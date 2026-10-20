import { randomBytes, randomUUID } from 'node:crypto'
import * as oidc from 'openid-client'
import type { PoolClient } from 'pg'
import { decrypt, digest, encrypt, type ServerConfig } from './config.ts'
import { HttpError } from './tenancy.ts'
import type { Principal } from './tenancy.ts'

export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES identities(id), token_hash text NOT NULL UNIQUE,
 acting_org_id text REFERENCES organizations(id), access_cipher text NOT NULL, refresh_cipher text,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS auth_transactions (
 state_hash text PRIMARY KEY, ticket_hash text NOT NULL UNIQUE, verifier_cipher text NOT NULL,
 nonce text NOT NULL, expires_at timestamptz NOT NULL, session_cipher text, completed boolean NOT NULL DEFAULT false
);
`

type AuthRow = { state_hash: string; ticket_hash: string; verifier_cipher: string; nonce: string; session_cipher: string | null; completed: boolean }
type SessionRow = { id: string; user_id: string; acting_org_id: string | null; access_cipher: string; refresh_cipher: string | null;
  email: string; name: string; oidc_sub: string; status: string; expires_at: Date }

export class IdentityService {
  private readonly settings: ServerConfig
  private readonly oidc: oidc.Configuration
  private constructor(settings: ServerConfig, configuration: oidc.Configuration) {
    this.settings = settings
    this.oidc = configuration
  }
  static async connect(settings: ServerConfig): Promise<IdentityService> {
    const configuration = await oidc.discovery(new URL(settings.issuer), settings.clientId,
      settings.clientSecret, oidc.ClientSecretPost(settings.clientSecret),
      settings.development ? { execute: [oidc.allowInsecureRequests] } : undefined)
    oidc.enableNonRepudiationChecks(configuration)
    configuration.timeout = 10
    return new IdentityService(settings, configuration)
  }
  async begin(db: PoolClient, intent: string): Promise<{ authorizationUrl: string; ticket: string }> {
    const state = oidc.randomState()
    const nonce = oidc.randomNonce()
    const verifier = oidc.randomPKCECodeVerifier()
    const ticket = randomBytes(32).toString('base64url')
    await db.query('DELETE FROM auth_transactions WHERE expires_at < now()')
    await db.query(`INSERT INTO auth_transactions(state_hash,ticket_hash,verifier_cipher,nonce,expires_at)
      VALUES($1,$2,$3,$4,now()+interval '10 minutes')`, [digest(state), digest(ticket), encrypt(verifier, this.settings.encryptionKey), nonce])
    const parameters: Record<string, string> = {
      redirect_uri: `${this.settings.publicUrl}/auth/callback`, scope: 'openid email profile',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce,
      prompt: 'login', max_age: '0'
    }
    // Registration, forgotten-password and verification are provider-hosted flows. Never collect a password here.
    if (intent === 'register') parameters.prompt = 'create'
    const authorizationUrl = oidc.buildAuthorizationUrl(this.oidc, parameters)
    if (intent === 'recover') {
      // Keycloak's supported client-initiated reset flow preserves OIDC state/PKCE.
      // Do not redirect directly to login-actions, or confuse UPDATE_PASSWORD with recovery.
      if (!authorizationUrl.pathname.endsWith('/protocol/openid-connect/auth')) {
        throw new HttpError(503, 'RECOVERY_UNAVAILABLE', '当前身份服务未配置直接找回入口，请在登录页选择忘记密码')
      }
      authorizationUrl.pathname = authorizationUrl.pathname.replace(/\/auth$/, '/forgot-credentials')
    }
    return { authorizationUrl: authorizationUrl.href, ticket }
  }
  async callback(db: PoolClient, url: URL): Promise<void> {
    const state = url.searchParams.get('state')
    if (!state) throw new HttpError(400, 'INVALID_AUTH', '登录回调缺少状态')
    const result = await db.query<AuthRow>(`SELECT * FROM auth_transactions WHERE state_hash=$1 AND expires_at>now() FOR UPDATE`, [digest(state)])
    const tx = result.rows[0]
    if (!tx || tx.completed) throw new HttpError(400, 'INVALID_AUTH', '登录请求已失效或已使用')
    const tokens = await oidc.authorizationCodeGrant(this.oidc, url, {
      pkceCodeVerifier: decrypt(tx.verifier_cipher, this.settings.encryptionKey), expectedState: state,
      expectedNonce: tx.nonce, idTokenExpected: true
    })
    const claims = tokens.claims()
    if (!claims || claims.email_verified !== true || typeof claims.email !== 'string' || !claims.sub) {
      throw new HttpError(403, 'EMAIL_UNVERIFIED', '请先在身份服务完成邮箱验证，再重新登录')
    }
    const sub = `${this.settings.issuer}|${claims.sub}`
    const user = await db.query<{ id: string; status: string }>(`INSERT INTO identities(id,oidc_sub,email,name,status)
      VALUES($1,$2,$3,$4,'active') ON CONFLICT(oidc_sub) DO UPDATE SET email=excluded.email RETURNING id,status`,
    [randomUUID(), sub, claims.email.toLowerCase(), typeof claims.name === 'string' ? claims.name.slice(0, 100) : claims.email.split('@')[0]])
    if (user.rows[0].status !== 'active') throw new HttpError(401, 'ACCOUNT_DISABLED', '账号已停用')
    const token = randomBytes(32).toString('base64url')
    await db.query(`INSERT INTO sessions(id,user_id,token_hash,access_cipher,refresh_cipher,expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '12 hours')`, [randomUUID(), user.rows[0].id, digest(token),
      encrypt(tokens.access_token, this.settings.encryptionKey), tokens.refresh_token ? encrypt(tokens.refresh_token, this.settings.encryptionKey) : null])
    await db.query('UPDATE auth_transactions SET completed=true, session_cipher=$1 WHERE state_hash=$2',
      [encrypt(token, this.settings.encryptionKey), digest(state)])
    await db.query(`INSERT INTO audit(id,org_id,actor_id,action,target_id,detail) VALUES($1,NULL,$2,'session.created',$2,'{}')`, [randomUUID(), user.rows[0].id])
  }
  async poll(db: PoolClient, ticket: unknown): Promise<{ pending: true } | { token: string }> {
    if (typeof ticket !== 'string' || ticket.length > 128) throw new HttpError(400, 'INVALID_INPUT', '登录请求无效')
    const result = await db.query<AuthRow>('SELECT * FROM auth_transactions WHERE ticket_hash=$1 AND expires_at>now() FOR UPDATE', [digest(ticket)])
    const tx = result.rows[0]
    if (!tx) throw new HttpError(401, 'AUTH_EXPIRED', '登录请求已过期，请重新登录')
    if (!tx.completed || !tx.session_cipher) return { pending: true }
    const token = decrypt(tx.session_cipher, this.settings.encryptionKey)
    await db.query('DELETE FROM auth_transactions WHERE ticket_hash=$1', [digest(ticket)])
    return { token }
  }
  async authenticate(db: PoolClient, bearer: string | undefined): Promise<Principal> {
    const token = bearer?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
    if (!token) throw new HttpError(401, 'UNAUTHENTICATED', '请先登录')
    // 先串行化同一用户的会话操作，再锁单个会话，防止两台设备互相撤销时死锁。
    // 此事务不修改身份主键；非键更新锁保持互斥，同时允许业务外键的 KEY SHARE 检查。
    const owner = await db.query<{ user_id: string }>('SELECT user_id FROM sessions WHERE token_hash=$1', [digest(token)])
    if (!owner.rows[0]) throw new HttpError(401, 'SESSION_EXPIRED', '会话已失效，请重新登录')
    await db.query('SELECT id FROM identities WHERE id=$1 FOR NO KEY UPDATE', [owner.rows[0].user_id])
    const result = await db.query<SessionRow>(`SELECT s.*,i.email,i.name,i.oidc_sub,i.status FROM sessions s
      JOIN identities i ON i.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() FOR UPDATE OF s`, [digest(token)])
    const row = result.rows[0]
    if (!row || row.status !== 'active') throw new HttpError(401, 'SESSION_EXPIRED', '会话已失效，请重新登录')
    let access = decrypt(row.access_cipher, this.settings.encryptionKey)
    let active = await oidc.tokenIntrospection(this.oidc, access)
    if (!active.active && row.refresh_cipher) {
      try {
        const refreshed = await oidc.refreshTokenGrant(this.oidc, decrypt(row.refresh_cipher, this.settings.encryptionKey))
        access = refreshed.access_token
        await db.query('UPDATE sessions SET access_cipher=$1,refresh_cipher=$2 WHERE id=$3',
          [encrypt(access, this.settings.encryptionKey), refreshed.refresh_token ? encrypt(refreshed.refresh_token, this.settings.encryptionKey) : row.refresh_cipher, row.id])
        active = await oidc.tokenIntrospection(this.oidc, access)
      } catch {
        throw new HttpError(401, 'SESSION_EXPIRED', '身份服务会话已失效，请重新登录')
      }
    }
    if (!active.active || `${this.settings.issuer}|${active.sub}` !== row.oidc_sub) {
      throw new HttpError(401, 'SESSION_EXPIRED', '身份服务会话已撤销，请重新登录')
    }
    // Never trust roles or organisation ids in a JWT or a request. Read membership on every operation.
    const membership = row.acting_org_id ? await db.query(`SELECT id FROM memberships
      WHERE user_id=$1 AND org_id=$2 AND status='active'`, [row.user_id, row.acting_org_id]) : null
    const actingOrgId = membership?.rowCount ? row.acting_org_id : null
    if (row.acting_org_id && !actingOrgId) await db.query('UPDATE sessions SET acting_org_id=NULL WHERE id=$1', [row.id])
    return { userId: row.user_id, sessionId: row.id, email: row.email, name: row.name, actingOrgId }
  }
  async sessions(db: PoolClient, p: Principal): Promise<unknown> {
    const result = await db.query(`SELECT id,created_at AS "createdAt",(id=$2) AS current FROM sessions
      WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC`, [p.userId, p.sessionId])
    return result.rows
  }
  async revoke(db: PoolClient, p: Principal, id?: string): Promise<void> {
    const rows = await db.query<{ id: string; refresh_cipher: string | null }>(`SELECT id,refresh_cipher FROM sessions
      WHERE user_id=$1 AND ($2::text IS NULL OR id=$2) AND revoked_at IS NULL FOR UPDATE`, [p.userId, id ?? null])
    for (const row of rows.rows) {
      if (row.refresh_cipher) {
        // Fail closed if provider revocation cannot be confirmed. Do not claim remote logout succeeded.
        await oidc.tokenRevocation(this.oidc, decrypt(row.refresh_cipher, this.settings.encryptionKey), { token_type_hint: 'refresh_token' })
      }
      await db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [row.id])
      await db.query(`INSERT INTO audit(id,org_id,actor_id,action,target_id,detail) VALUES($1,NULL,$2,'session.revoked',$3,'{}')`, [randomUUID(), p.userId, row.id])
    }
  }
  accountUrl(): string { return this.settings.accountUrl }
}
