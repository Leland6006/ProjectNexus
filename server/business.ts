import type { PoolClient } from 'pg'
import { createSession, handleCall, setLlmClient } from '../src/main/handlers.ts'
import { API_METHODS, type ApiMethod, type ApiResult } from '../src/shared/api.ts'
import { CURRENT_SCHEMA_VERSION } from '../src/shared/migrations.ts'
import { NO_LLM } from '../src/shared/orchestrator.ts'
import { buildViewState, canViewTransaction } from '../src/shared/permissions.ts'
import type { Database, Organization, User, ViewState } from '../src/shared/types.ts'
import { audit, HttpError, requireMembership, type MembershipRole, type Principal } from './tenancy.ts'

const forbidden = new Set(['switchUser', 'resetDemo', 'setRepresentingOrg', 'grantCounsel'])
const fullAccess = new Set<MembershipRole>(['owner', 'admin', 'business'])
const legalMethods = new Set(['createContract', 'shareContract', 'updateClauses', 'updatePaymentTerms', 'saveVersion', 'restoreVersion', 'confirmFinal', 'addComment', 'createSuggestion', 'resolveSuggestion', 'sendMessage'])
const financeMethods = new Set(['createMilestone', 'updateMilestone', 'runAgents', 'confirmClaim', 'rejectProposal', 'sendMessage'])

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
    costItems: [], cashAccounts: [], claims: [], proposals: [],
    activities: clean.activities.filter((a) => !a.type.startsWith('proposal_'))
  }
}

export function emptyBusinessDatabase(): Database {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    organizations: [], users: [], transactions: [], contracts: [], versions: [], comments: [], suggestions: [],
    messages: [], milestones: [], activities: [], costItems: [], cashAccounts: [], claims: [], proposals: []
  }
}

const collections = ['transactions', 'contracts', 'versions', 'comments', 'suggestions', 'messages', 'milestones', 'activities', 'costItems', 'cashAccounts', 'claims', 'proposals'] as const

export function persistedBusinessState(db: Database): Omit<Database, 'users' | 'organizations'> {
  return {
    schemaVersion: db.schemaVersion,
    transactions: db.transactions, contracts: db.contracts, versions: db.versions, comments: db.comments,
    suggestions: db.suggestions, messages: db.messages, milestones: db.milestones, activities: db.activities,
    costItems: db.costItems, cashAccounts: db.cashAccounts, claims: db.claims, proposals: db.proposals
  }
}

function readBusinessState(payload: unknown): Database {
  const db = emptyBusinessDatabase()
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('业务数据格式无效')
  const source = payload as Record<string, unknown>
  for (const key of collections) {
    if (source[key] !== undefined && !Array.isArray(source[key])) throw new Error('业务集合格式无效')
    if (source[key] !== undefined) Object.assign(db, { [key]: source[key] })
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
  return { id: row.id, name: row.name, orgId: row.org_id, role: row.role === 'legal' ? 'legal' : 'business', title: row.role }
}

async function projectDirectory(client: PoolClient, db: Database, p: Principal, role: MembershipRole, method: string, args: unknown[]): Promise<void> {
  const orgId = p.actingOrgId!
  const person = await client.query<{ id: string; name: string }>('SELECT id,name FROM identities WHERE id=$1 AND status=\'active\'', [p.userId])
  if (!person.rows[0]) throw new HttpError(401, 'UNAUTHENTICATED', '账号已失效')
  const actor = projectedUser({ ...person.rows[0], org_id: orgId, role })
  db.users = [actor]
  const visibleTransactions = db.transactions.filter((t) => canViewTransaction(actor, t))
  const orgIds = new Set([orgId])
  for (const tx of visibleTransactions) {
    orgIds.add(tx.initiatorOrgId)
    orgIds.add(tx.counterpartyOrgId)
  }
  // 创建交易仅解析请求明确引用的企业，不提供可枚举的全平台企业目录。
  if (method === 'createTransaction' && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const counterpartyId = (args[0] as Record<string, unknown>).counterpartyOrgId
    if (typeof counterpartyId === 'string' && counterpartyId.length <= 128) orgIds.add(counterpartyId)
  }
  const organizations = await client.query<Organization>('SELECT id,name,short_name AS "shortName",kind FROM organizations WHERE id=ANY($1::text[])', [[...orgIds]])
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
  const members = await client.query<DirectoryRow>(`SELECT i.id,i.name,m.org_id,m.role FROM identities i JOIN memberships m ON m.user_id=i.id
    WHERE i.status='active' AND m.status='active' AND m.org_id=$1`, [orgId])
  const directory = new Map(members.rows.map((row) => [row.id, projectedUser(row)]))
  const foreignIds = [...referenced.keys()].filter((id) => !directory.has(id) && id !== p.userId)
  if (foreignIds.length) {
    const authors = await client.query<{ id: string; name: string }>('SELECT id,name FROM identities WHERE id=ANY($1::text[])', [foreignIds])
    for (const author of authors.rows) {
      // 历史署名只服务显示，绝不将其用作当前请求的授权来源。
      directory.set(author.id, projectedUser({ ...author, org_id: referenced.get(author.id)!, role: 'business' }))
    }
  }
  directory.set(actor.id, actor)
  db.users = [...directory.values()]
}

export async function businessRequest(client: PoolClient, p: Principal, body: { method: unknown; args?: unknown }): Promise<ApiResult> {
  const member = await requireMembership(client, p)
  if (!body || typeof body !== 'object' || typeof body.method !== 'string' || !Array.isArray(body.args ?? [])) {
    throw new HttpError(400, 'INVALID_INPUT', '业务请求参数无效')
  }
  if (!canCallBusiness(member.role, body.method)) throw new HttpError(403, 'PERMISSION_DENIED', '当前企业角色无权执行此业务操作')
  const args = (body.args ?? []) as unknown[]
  // MVP 用一个持久化业务快照锁串行执行；后续拆分为交易级表后再缩小锁粒度。
  const stored = await client.query<{ payload: unknown }>('SELECT payload FROM business_state WHERE id=\'singleton\' FOR UPDATE')
  if (!stored.rows[0]) throw new Error('业务状态尚未初始化')
  const db = readBusinessState(stored.rows[0].payload)
  await projectDirectory(client, db, p, member.role, body.method, args)
  let changed = false
  const session = createSession(db, p.userId, () => { changed = true })
  setLlmClient(NO_LLM)
  const result = await handleCall(session, body.method as ApiMethod, args)
  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : result.code === 'PERMISSION_DENIED' ? 403 : result.code === 'CONFLICT' ? 409 : result.code === 'INTERNAL' ? 500 : 400
    throw new HttpError(status, result.code, result.message)
  }
  if (changed) {
    await client.query('UPDATE business_state SET payload=$1,revision=revision+1 WHERE id=\'singleton\'', [JSON.stringify(persistedBusinessState(db))])
    await audit(client, p, `business.${body.method}`, typeof args[0] === 'string' ? args[0] : null)
  }
  const state = filterRoleView(buildViewState(db, p.userId), member.role)
  return { ok: true, state }
}
