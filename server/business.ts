import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { createSession, handleCall, setLlmClient } from '../src/main/handlers.ts'
import { API_METHODS, type ApiMethod, type ApiResult } from '../src/shared/api.ts'
import { CURRENT_SCHEMA_VERSION } from '../src/shared/migrations.ts'
import { NO_LLM } from '../src/shared/orchestrator.ts'
import { buildViewState, canViewTransaction } from '../src/shared/permissions.ts'
import type { Database, Organization, User, ViewState } from '../src/shared/types.ts'
import {
  audit,
  HttpError,
  requireMembership,
  type MembershipRole,
  type Principal
} from './tenancy.ts'
import {
  loadBusinessDatabase,
  persistBusinessDatabase,
  snapshotBusiness
} from './businessStorage.ts'

const forbidden = new Set(['switchUser', 'resetDemo', 'setRepresentingOrg', 'grantCounsel'])
const fullAccess = new Set<MembershipRole>(['owner', 'admin', 'business'])
const legalMethods = new Set([
  'createContract',
  'shareContract',
  'updateClauses',
  'updatePaymentTerms',
  'saveVersion',
  'restoreVersion',
  'confirmFinal',
  'addComment',
  'createSuggestion',
  'resolveSuggestion',
  'sendMessage'
])
const financeMethods = new Set([
  'createMilestone',
  'updateMilestone',
  'runAgents',
  'confirmClaim',
  'rejectProposal',
  'sendMessage'
])

export function canCallBusiness(role: MembershipRole, method: string): boolean {
  if (!(API_METHODS as readonly string[]).includes(method) || forbidden.has(method)) return false
  if (method === 'getState') return true
  if (fullAccess.has(role)) return true
  if (role === 'legal') return legalMethods.has(method)
  return role === 'finance' && financeMethods.has(method)
}

export function filterRoleView(state: ViewState, role: MembershipRole): ViewState {
  const clean = { ...state, demoAccounts: null }
  if (fullAccess.has(role) || role === 'finance') return clean
  return {
    ...clean,
    costItems: [],
    cashAccounts: [],
    claims: [],
    proposals: [],
    activities: clean.activities.filter((a) => !a.type.startsWith('proposal_'))
  }
}

export function emptyBusinessDatabase(): Database {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    organizations: [],
    users: [],
    transactions: [],
    contracts: [],
    versions: [],
    comments: [],
    suggestions: [],
    messages: [],
    milestones: [],
    activities: [],
    costItems: [],
    cashAccounts: [],
    claims: [],
    proposals: []
  }
}

const collections = [
  'transactions',
  'contracts',
  'versions',
  'comments',
  'suggestions',
  'messages',
  'milestones',
  'activities',
  'costItems',
  'cashAccounts',
  'claims',
  'proposals'
] as const

export function persistedBusinessState(db: Database): Omit<Database, 'users' | 'organizations'> {
  return {
    schemaVersion: db.schemaVersion,
    transactions: db.transactions,
    contracts: db.contracts,
    versions: db.versions,
    comments: db.comments,
    suggestions: db.suggestions,
    messages: db.messages,
    milestones: db.milestones,
    activities: db.activities,
    costItems: db.costItems,
    cashAccounts: db.cashAccounts,
    claims: db.claims,
    proposals: db.proposals
  }
}

export function readBusinessState(payload: unknown): Database {
  const db = emptyBusinessDatabase()
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('业务数据格式无效')
  const source = payload as Record<string, unknown>
  // 001 迁移明确以空对象初始化；已有快照必须完整声明当前版本，不能在读取时隐式升级。
  if (Object.keys(source).length === 0) return db
  if (source.schemaVersion !== CURRENT_SCHEMA_VERSION)
    throw new Error('业务数据版本不受支持，请显式迁移后重试')
  if (
    Object.keys(source).some(
      (key) => !['schemaVersion', 'users', 'organizations', ...collections].includes(key)
    )
  )
    throw new Error('业务数据包含未知字段')
  for (const key of ['users', 'organizations']) {
    if (source[key] !== undefined && !Array.isArray(source[key]))
      throw new Error('业务目录格式无效')
  }
  for (const key of collections) {
    if (!Array.isArray(source[key])) throw new Error('业务集合格式无效')
    Object.assign(db, { [key]: source[key] })
  }
  return db
}

interface DirectoryRow {
  id: string
  name: string
  org_id: string
  role: MembershipRole
}

function projectedUser(row: DirectoryRow): User {
  return {
    id: row.id,
    name: row.name,
    orgId: row.org_id,
    role: row.role === 'legal' ? 'legal' : 'business',
    title: row.role
  }
}

async function projectDirectory(
  client: PoolClient,
  db: Database,
  p: Principal,
  role: MembershipRole,
  method: string,
  args: unknown[]
): Promise<void> {
  const orgId = p.actingOrgId!
  const person = await client.query<{ id: string; name: string }>(
    "SELECT id,name FROM identities WHERE id=$1 AND status='active'",
    [p.userId]
  )
  if (!person.rows[0]) throw new HttpError(401, 'UNAUTHENTICATED', '账号已失效')
  const actor = projectedUser({ ...person.rows[0], org_id: orgId, role })
  db.users = [actor]
  const visibleTransactions = db.transactions.filter((t) => canViewTransaction(actor, t))
  const orgIds = new Set([orgId])
  for (const tx of visibleTransactions) {
    orgIds.add(tx.initiatorOrgId)
    orgIds.add(tx.counterpartyOrgId)
  }
  const partners = await client.query<{ org_id: string }>(
    `SELECT CASE WHEN requester_org_id=$1 THEN recipient_org_id ELSE requester_org_id END AS org_id
    FROM partner_relationships WHERE status='accepted' AND (requester_org_id=$1 OR recipient_org_id=$1)`,
    [orgId]
  )
  for (const partner of partners.rows) orgIds.add(partner.org_id)
  if (method === 'createTransaction') {
    const input = args[0]
    const counterpartyId =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>).counterpartyOrgId
        : undefined
    if (
      typeof counterpartyId !== 'string' ||
      !counterpartyId ||
      counterpartyId.length > 128 ||
      counterpartyId === orgId
    ) {
      throw new HttpError(400, 'INVALID_INPUT', '请选择有效的交易对方')
    }
    // 与断开合作共用关系行锁，让新建交易和断开操作按事务边界排序。
    const accepted = await client.query(
      `SELECT id FROM partner_relationships WHERE status='accepted'
      AND ((requester_org_id=$1 AND recipient_org_id=$2) OR (requester_org_id=$2 AND recipient_org_id=$1)) FOR SHARE`,
      [orgId, counterpartyId]
    )
    if (!accepted.rows.length)
      throw new HttpError(409, 'PARTNER_REQUIRED', '请先与交易对方建立已确认的合作关系')
    orgIds.add(counterpartyId)
  }
  const organizations = await client.query<Organization>(
    'SELECT id,name,short_name AS "shortName",kind FROM organizations WHERE id=ANY($1::text[])',
    [[...orgIds]]
  )
  db.organizations = organizations.rows
  const visible = buildViewState(db, p.userId)
  const referenced = new Map<string, string>()
  for (const tx of visible.transactions) referenced.set(tx.createdBy, tx.initiatorOrgId)
  for (const c of visible.contracts) {
    const tx = visible.transactions.find((t) => t.id === c.transactionId)
    if (tx) referenced.set(c.createdBy, tx.initiatorOrgId)
  }
  for (const x of visible.comments) referenced.set(x.authorId, x.orgId)
  for (const x of visible.suggestions) {
    referenced.set(x.authorId, x.orgId)
    if (x.resolvedBy) referenced.set(x.resolvedBy, orgId)
  }
  for (const x of visible.messages) referenced.set(x.authorId, x.orgId)
  for (const x of visible.activities) referenced.set(x.actorId, x.orgId)
  for (const x of visible.milestones) referenced.set(x.createdBy, x.responsibleOrgId)
  for (const x of visible.versions) referenced.set(x.authorId, orgId)
  const members = await client.query<DirectoryRow>(
    `SELECT i.id,i.name,m.org_id,m.role FROM identities i JOIN memberships m ON m.user_id=i.id
    WHERE i.status='active' AND m.status='active' AND m.org_id=$1`,
    [orgId]
  )
  const directory = new Map(members.rows.map((row) => [row.id, projectedUser(row)]))
  const foreignIds = [...referenced.keys()].filter((id) => !directory.has(id) && id !== p.userId)
  if (foreignIds.length) {
    const authors = await client.query<{ id: string; name: string }>(
      'SELECT id,name FROM identities WHERE id=ANY($1::text[])',
      [foreignIds]
    )
    for (const author of authors.rows) {
      // 历史署名只服务显示，绝不将其用作当前请求的授权来源。
      directory.set(
        author.id,
        projectedUser({ ...author, org_id: referenced.get(author.id)!, role: 'business' })
      )
    }
  }
  directory.set(actor.id, actor)
  db.users = [...directory.values()]
}

/** 仅对当前角色实际可见业务内容生成摘要；调用方负责身份/成员校验及一致性快照。 */
export async function tenantChangeFingerprint(
  client: PoolClient,
  p: Principal,
  role: MembershipRole
): Promise<string> {
  const db = await loadBusinessDatabase(client, p.actingOrgId!, false, false)
  db.users = [
    {
      id: p.userId,
      name: p.name,
      orgId: p.actingOrgId!,
      role: role === 'legal' ? 'legal' : 'business',
      title: role
    }
  ]
  const visible = filterRoleView(buildViewState(db, p.userId), role)
  return createHash('sha256')
    .update(JSON.stringify(persistedBusinessState({ ...db, ...visible })))
    .digest('hex')
}

export async function businessRequest(
  client: PoolClient,
  p: Principal,
  body: { method: unknown; args?: unknown }
): Promise<ApiResult> {
  const member = await requireMembership(client, p)
  if (
    !body ||
    typeof body !== 'object' ||
    typeof body.method !== 'string' ||
    !Array.isArray(body.args ?? [])
  ) {
    throw new HttpError(400, 'INVALID_INPUT', '业务请求参数无效')
  }
  if (!canCallBusiness(member.role, body.method))
    throw new HttpError(403, 'PERMISSION_DENIED', '当前企业角色无权执行此业务操作')
  const args = (body.args ?? []) as unknown[]
  if (body.method === 'updateClauses' && !Array.isArray(args[2])) {
    throw new HttpError(400, 'INVALID_INPUT', '请重新载入合同后编辑，并提交开始编辑时的条款快照')
  }
  const db = await loadBusinessDatabase(client, p.actingOrgId!, body.method !== 'getState')
  const baseline = snapshotBusiness(db)
  await projectDirectory(client, db, p, member.role, body.method, args)
  let changed = false
  const session = createSession(db, p.userId, () => {
    changed = true
  })
  setLlmClient(NO_LLM)
  const result = await handleCall(session, body.method as ApiMethod, args)
  if (!result.ok) {
    const status =
      result.code === 'NOT_FOUND'
        ? 404
        : result.code === 'PERMISSION_DENIED'
          ? 403
          : result.code === 'CONFLICT'
            ? 409
            : result.code === 'INTERNAL'
              ? 500
              : 400
    throw new HttpError(status, result.code, result.message)
  }
  if (changed) {
    await persistBusinessDatabase(client, db, baseline, p.actingOrgId!)
    await audit(client, p, `business.${body.method}`, typeof args[0] === 'string' ? args[0] : null)
  }
  const state = filterRoleView(
    { ...buildViewState(db, p.userId), organizations: db.organizations },
    member.role
  )
  return { ok: true, state }
}
