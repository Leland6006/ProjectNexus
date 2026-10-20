import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { audit, HttpError, requireMembership, type Principal } from './tenancy.ts'

export interface PartnerRelationship {
  id: string
  requesterOrgId: string
  recipientOrgId: string
  partner: { id: string; name: string; shortName: string }
  status: 'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'disconnected'
  revision: number
  createdAt: string
}

export interface PartnerMessage {
  id: string
  relationshipId: string
  authorId: string
  orgId: string
  body: string
  createdAt: string
}

type MessageRow = Omit<PartnerMessage, 'createdAt'> & { createdAt: Date | string }
const messageColumns = `id,relationship_id AS "relationshipId",author_id AS "authorId",org_id AS "orgId",body,created_at AS "createdAt"`
const serializeMessage = (row: MessageRow): PartnerMessage => ({
  ...row,
  createdAt: new Date(row.createdAt).toISOString()
})
type RelationshipRow = Omit<PartnerRelationship, 'createdAt'> & { createdAt: Date | string }
const columns = `r.id, r.requester_org_id AS "requesterOrgId", r.recipient_org_id AS "recipientOrgId",
  json_build_object('id',o.id,'name',o.name,'shortName',o.short_name) AS partner,
  r.status,r.revision,r.created_at AS "createdAt"`
const partnerJoin = `JOIN organizations o ON o.id=CASE WHEN r.requester_org_id=$1 THEN r.recipient_org_id ELSE r.requester_org_id END`
const serialize = (row: RelationshipRow): PartnerRelationship => ({
  ...row,
  createdAt: new Date(row.createdAt).toISOString()
})
const fail = (status: number, code: string, message: string): never => {
  throw new HttpError(status, code, message)
}

function inputObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail(400, 'INVALID_INPUT', '合作请求参数无效')
  return raw as Record<string, unknown>
}

async function lockPair(client: PoolClient, orgId: string, otherId: string): Promise<void> {
  // 企业成员检查已持有本企业共享锁；只锁规范化企业对，避免双方申请时升级企业行锁而死锁。
  await client.query(
    `INSERT INTO partner_pairs(lower_org_id,upper_org_id) VALUES(LEAST($1::text,$2::text),GREATEST($1::text,$2::text))
    ON CONFLICT DO NOTHING`,
    [orgId, otherId]
  )
  await client.query(
    `SELECT lower_org_id FROM partner_pairs
    WHERE lower_org_id=LEAST($1::text,$2::text) AND upper_org_id=GREATEST($1::text,$2::text) FOR UPDATE`,
    [orgId, otherId]
  )
}

async function relationship(
  client: PoolClient,
  orgId: string,
  id: string
): Promise<PartnerRelationship> {
  const result = await client.query<RelationshipRow>(
    `SELECT ${columns} FROM partner_relationships r ${partnerJoin}
    WHERE r.id=$2 AND (r.requester_org_id=$1 OR r.recipient_org_id=$1)`,
    [orgId, id]
  )
  if (!result.rows[0]) return fail(404, 'NOT_FOUND', '合作关系不存在')
  return serialize(result.rows[0])
}

export async function partnersRequest(
  client: PoolClient,
  p: Principal,
  method: string,
  path: string,
  rawBody: unknown
): Promise<unknown> {
  const member = await requireMembership(client, p)
  const orgId = member.org_id
  if (method === 'GET' && path === '/partners') {
    const result = await client.query<RelationshipRow>(
      `SELECT ${columns} FROM partner_relationships r ${partnerJoin}
      WHERE r.requester_org_id=$1 OR r.recipient_org_id=$1 ORDER BY r.created_at DESC,r.id`,
      [orgId]
    )
    return { partners: result.rows.map(serialize) }
  }
  const messageMatch = /^\/partners\/([^/]+)\/messages$/.exec(path)
  if (messageMatch && (method === 'GET' || method === 'POST')) {
    const id = messageMatch[1]
    const initial = await relationship(client, orgId, id)
    if (method === 'GET') {
      if (!['accepted', 'disconnected'].includes(initial.status))
        return fail(409, 'PARTNER_UNAVAILABLE', '该合作关系尚不能读取消息')
      const result = await client.query<MessageRow>(
        `SELECT ${messageColumns} FROM partner_messages WHERE relationship_id=$1
        ORDER BY created_at DESC,id DESC LIMIT 100`,
        [id]
      )
      return { messages: result.rows.reverse().map(serializeMessage) }
    }
    if (member.role === 'readonly')
      return fail(403, 'PERMISSION_DENIED', '只读成员不能发送企业消息')
    const input = inputObject(rawBody)
    if (
      Object.keys(input).some((key) => key !== 'body') ||
      typeof input.body !== 'string' ||
      !input.body.trim() ||
      [...input.body.trim()].length > 10000
    ) {
      return fail(400, 'INVALID_INPUT', '消息正文须为1至10000个字符')
    }
    await lockPair(client, initial.requesterOrgId, initial.recipientOrgId)
    const current = await relationship(client, orgId, id)
    if (current.status !== 'accepted')
      return fail(409, 'PARTNER_UNAVAILABLE', '合作关系已断开或尚未确认，不能发送消息')
    const messageId = randomUUID()
    const result = await client.query<MessageRow>(
      `INSERT INTO partner_messages(id,relationship_id,author_id,org_id,body)
      VALUES($1,$2,$3,$4,$5) RETURNING ${messageColumns}`,
      [messageId, id, p.userId, orgId, input.body.trim()]
    )
    await audit(client, p, 'partner.message_sent', messageId, { relationshipId: id })
    return { message: serializeMessage(result.rows[0]) }
  }
  const match = /^\/partners\/([^/]+)\/(accept|reject|withdraw|disconnect)$/.exec(path)
  if (method !== 'POST' || (path !== '/partners' && !match))
    return fail(404, 'NOT_FOUND', '接口不存在')
  if (!['owner', 'admin', 'business'].includes(member.role))
    return fail(403, 'PERMISSION_DENIED', '当前企业角色无权管理合作关系')
  const input = inputObject(rawBody)
  if (path === '/partners') {
    if (
      Object.keys(input).some((key) => key !== 'orgId') ||
      typeof input.orgId !== 'string' ||
      !input.orgId.trim() ||
      input.orgId.trim().length > 128
    ) {
      return fail(400, 'INVALID_INPUT', '请输入有效的企业编号')
    }
    const otherId = input.orgId.trim()
    if (otherId === orgId) return fail(400, 'INVALID_INPUT', '不能向本企业申请合作')
    const target = await client.query(
      "SELECT id FROM organizations WHERE id=$1 AND kind='company'",
      [otherId]
    )
    if (!target.rows[0]) return fail(404, 'NOT_FOUND', '目标企业不存在')
    const own = await client.query("SELECT id FROM organizations WHERE id=$1 AND kind='company'", [
      orgId
    ])
    if (!own.rows[0]) return fail(400, 'INVALID_INPUT', '当前组织不能申请企业合作')
    await lockPair(client, orgId, otherId)
    const existing = await client.query(
      `SELECT id FROM partner_relationships WHERE status IN ('pending','accepted')
      AND LEAST(requester_org_id,recipient_org_id)=LEAST($1::text,$2::text)
      AND GREATEST(requester_org_id,recipient_org_id)=GREATEST($1::text,$2::text)`,
      [orgId, otherId]
    )
    if (existing.rows.length) return fail(409, 'PARTNER_EXISTS', '双方已有待确认或已建立的合作关系')
    const id = randomUUID()
    await client.query(
      'INSERT INTO partner_relationships(id,requester_org_id,recipient_org_id) VALUES($1,$2,$3)',
      [id, orgId, otherId]
    )
    await audit(client, p, 'partner.requested', id, { recipientOrgId: otherId })
    return { relationship: await relationship(client, orgId, id) }
  }
  if (Object.keys(input).length) return fail(400, 'INVALID_INPUT', '合作操作无需额外参数')
  const [id, action] = [match![1], match![2]]
  const initial = await relationship(client, orgId, id)
  await lockPair(client, initial.requesterOrgId, initial.recipientOrgId)
  const current = await relationship(client, orgId, id)
  if (
    ((action === 'accept' || action === 'reject') && current.recipientOrgId !== orgId) ||
    (action === 'withdraw' && current.requesterOrgId !== orgId)
  ) {
    return fail(403, 'PERMISSION_DENIED', '当前企业无权执行此合作操作')
  }
  if (current.status !== (action === 'disconnect' ? 'accepted' : 'pending'))
    return fail(409, 'PARTNER_UNAVAILABLE', '合作关系状态已变化，请刷新后重试')
  const statuses: Record<string, PartnerRelationship['status']> = {
    accept: 'accepted',
    reject: 'rejected',
    withdraw: 'withdrawn',
    disconnect: 'disconnected'
  }
  const status = statuses[action]
  await client.query('UPDATE partner_relationships SET status=$1,revision=revision+1 WHERE id=$2', [
    status,
    id
  ])
  await audit(client, p, `partner.${status}`, id)
  return { relationship: await relationship(client, orgId, id) }
}
