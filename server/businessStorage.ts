import type { PoolClient } from 'pg'
import { CURRENT_SCHEMA_VERSION } from '../src/shared/migrations.ts'
import type { Database } from '../src/shared/types.ts'
import { BUSINESS_TABLES } from './businessSchema.ts'
import { HttpError } from './tenancy.ts'

type Collection = keyof typeof BUSINESS_TABLES
type Entity = { id: string }
export type BusinessSnapshot = { [K in Collection]: Map<string, string> }

export function snapshotBusiness(db: Database): BusinessSnapshot {
  return Object.fromEntries(
    Object.keys(BUSINESS_TABLES).map((key) => [
      key,
      new Map((db[key as Collection] as Entity[]).map((item) => [item.id, JSON.stringify(item)]))
    ])
  ) as BusinessSnapshot
}

/** 业务scope独立于成员管理的organizations锁；只锁本企业，再按全局id顺序锁交易。 */
export async function loadBusinessDatabase(
  client: PoolClient,
  orgId: string,
  write: boolean,
  lock = true
): Promise<Database> {
  if (lock) {
    await client.query(
      'INSERT INTO business_org_scopes(org_id) VALUES($1) ON CONFLICT(org_id) DO NOTHING',
      [orgId]
    )
    await client.query(
      `SELECT org_id FROM business_org_scopes WHERE org_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
      [orgId]
    )
  }
  let transactions = await client.query<{ payload: Database['transactions'][number] }>(
    `SELECT payload FROM business_transactions
    WHERE initiator_org_id=$1 OR (counterparty_org_id=$1 AND counterparty_status<>'none')
    ORDER BY id${lock ? ` FOR ${write ? 'UPDATE' : 'SHARE'}` : ''}`,
    [orgId]
  )
  if (lock) {
    // 等待对手交易锁期间可能收到其他交易邀请；重读后拒绝未加锁的新集合，避免逆序追加锁。
    const refreshed = await client.query<{ payload: Database['transactions'][number] }>(
      `SELECT payload FROM business_transactions
      WHERE initiator_org_id=$1 OR (counterparty_org_id=$1 AND counterparty_status<>'none') ORDER BY id`,
      [orgId]
    )
    if (
      JSON.stringify(refreshed.rows.map(({ payload }) => payload.id)) !==
      JSON.stringify(transactions.rows.map(({ payload }) => payload.id))
    ) {
      throw new HttpError(409, 'CONFLICT', '可见交易已变更，请重试')
    }
    transactions = refreshed
  }
  const txIds = transactions.rows.map(({ payload }) => payload.id)
  const db = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    organizations: [],
    users: [],
    transactions: transactions.rows.map(({ payload }) => payload)
  } as unknown as Database
  for (const [key, name] of Object.entries(BUSINESS_TABLES)) {
    if (key === 'transactions') continue
    let sql: string
    let values: unknown[]
    if (key === 'cashAccounts') {
      sql = `SELECT payload FROM ${name} WHERE org_id=$1 ORDER BY id`
      values = [orgId]
    } else if (key === 'proposals') {
      sql = `SELECT payload FROM ${name} WHERE transaction_id=ANY($1::text[]) AND org_id=$2 ORDER BY id`
      values = [txIds, orgId]
    } else if (key === 'claims') {
      sql = `SELECT payload FROM ${name} WHERE transaction_id=ANY($1::text[]) OR (transaction_id IS NULL AND org_id=$2) ORDER BY id`
      values = [txIds, orgId]
    } else if (['versions', 'comments', 'suggestions'].includes(key)) {
      sql = `SELECT e.payload FROM ${name} e JOIN business_contracts c ON c.id=e.contract_id WHERE c.transaction_id=ANY($1::text[]) ORDER BY e.id`
      values = [txIds]
    } else {
      sql = `SELECT payload FROM ${name} WHERE transaction_id=ANY($1::text[]) ORDER BY id`
      values = [txIds]
    }
    const result = await client.query(sql, values)
    Object.assign(db, { [key]: result.rows.map((row: { payload: unknown }) => row.payload) })
  }
  return db
}

/** 在任何SQL写入前检查快照作用域及跨实体归属；SQL外键继续验证真实身份和实体存在性。 */
export function validateBusinessDatabase(
  db: Database,
  orgId?: string,
  baseline?: BusinessSnapshot
): void {
  const bad = (message: string): never => {
    throw new Error(`业务关系校验失败：${message}`)
  }
  const maps = Object.fromEntries(
    Object.keys(BUSINESS_TABLES).map((key) => {
      const items = db[key as Collection] as Entity[]
      if (
        items.some((item) => !item || typeof item.id !== 'string' || !item.id) ||
        new Set(items.map((item) => item.id)).size !== items.length
      )
        bad(`${key}编号无效或重复`)
      return [key, new Map(items.map((item) => [item.id, item]))]
    })
  ) as { [K in Collection]: Map<string, Database[K][number]> }
  const transaction = (id: string) => maps.transactions.get(id) ?? bad('交易引用不存在')
  const contract = (id: string) => maps.contracts.get(id) ?? bad('合同引用不存在')
  const party = (txId: string, owner: string) => {
    const tx = transaction(txId)
    if (![tx.initiatorOrgId, tx.counterpartyOrgId].includes(owner)) bad('实体组织不是交易参与方')
  }
  for (const tx of db.transactions) {
    if (tx.initiatorOrgId === tx.counterpartyOrgId) bad('交易双方相同')
    if (
      orgId &&
      !(
        tx.initiatorOrgId === orgId ||
        (tx.counterpartyOrgId === orgId && tx.counterpartyStatus !== 'none')
      )
    )
      bad('交易超出当前企业作用域')
    if (orgId && baseline && !baseline.transactions.has(tx.id) && tx.initiatorOrgId !== orgId)
      bad('不能代其他企业创建交易')
    for (const grant of tx.counselGrants) party(tx.id, grant.grantedByOrgId)
  }
  for (const c of db.contracts) {
    transaction(c.transactionId)
    const versions = db.versions
      .filter((v) => v.contractId === c.id)
      .sort((a, b) => a.number - b.number)
    if (!versions.length || versions.some((v, index) => v.number !== index + 1))
      bad('合同版本集合不连续')
    if (c.finalVersionId && maps.versions.get(c.finalVersionId)?.contractId !== c.id)
      bad('最终版本不属于当前合同')
    for (const owner of c.finalConfirmedBy) party(c.transactionId, owner)
  }
  for (const v of db.versions) contract(v.contractId)
  for (const item of [...db.comments, ...db.suggestions])
    party(contract(item.contractId).transactionId, item.orgId)
  for (const c of db.comments)
    if (c.parentId && maps.comments.get(c.parentId)?.contractId !== c.contractId)
      bad('回复跨合同或引用不存在')
  for (const item of [...db.messages, ...db.activities, ...db.costItems, ...db.proposals])
    party(item.transactionId, item.orgId)
  for (const item of db.milestones) party(item.transactionId, item.responsibleOrgId)
  for (const item of [...db.activities, ...db.proposals])
    if (item.contractId && contract(item.contractId).transactionId !== item.transactionId)
      bad('实体跨交易引用合同')
  for (const item of db.cashAccounts)
    if (orgId && item.orgId !== orgId) bad('账户超出当前企业作用域')
  for (const claim of db.claims) {
    if (claim.transactionId) party(claim.transactionId, claim.orgId)
    else if (orgId && claim.orgId !== orgId) bad('公司信息超出当前企业作用域')
    if (claim.supersededById) {
      const next = maps.claims.get(claim.supersededById)
      if (!next || next.orgId !== claim.orgId || next.transactionId !== claim.transactionId)
        bad('替代信息跨组织或交易')
    }
    const { kind, ref } = claim.source
    if (ref && kind === 'contract' && contract(ref).transactionId !== claim.transactionId)
      bad('信息来源合同跨交易')
    if (ref && kind === 'transaction' && transaction(ref).id !== claim.transactionId)
      bad('信息来源交易无效')
    if (ref && kind === 'ledger') {
      const cost = maps.costItems.get(ref)
      if (!cost || cost.orgId !== claim.orgId || cost.transactionId !== claim.transactionId)
        bad('信息来源台账归属无效')
    }
  }
  for (const proposal of db.proposals) {
    if (
      proposal.baseVersionId &&
      (!proposal.contractId ||
        maps.versions.get(proposal.baseVersionId)?.contractId !== proposal.contractId)
    )
      bad('方案基础版本不属于当前合同')
    for (const id of proposal.claimIds) {
      const claim = maps.claims.get(id)
      if (
        !claim ||
        claim.orgId !== proposal.orgId ||
        (claim.transactionId !== null && claim.transactionId !== proposal.transactionId)
      )
        bad('方案引用跨组织或交易信息')
    }
  }
}

/** 只对已加载实体做diff，绝不按企业/交易范围整批删除重建。 */
export async function persistBusinessDatabase(
  client: PoolClient,
  db: Database,
  baseline: BusinessSnapshot,
  orgId?: string
): Promise<void> {
  validateBusinessDatabase(db, orgId, baseline)
  await client.query('SET CONSTRAINTS ALL DEFERRED')
  const next = snapshotBusiness(db)
  for (const [key, name] of Object.entries(BUSINESS_TABLES) as [Collection, string][]) {
    for (const [id, serialized] of next[key]) {
      const previous = baseline[key].get(id)
      if (previous === serialized) continue
      if (previous === undefined)
        await client.query(`INSERT INTO ${name}(id,payload) VALUES($1,$2::jsonb)`, [id, serialized])
      else {
        const updated = await client.query(
          `UPDATE ${name} SET payload=$2::jsonb WHERE id=$1 AND payload=$3::jsonb RETURNING id`,
          [id, serialized, previous]
        )
        if (!updated.rows.length) throw new Error('业务实体已被并发修改')
      }
      if (key === 'proposals') {
        await client.query('DELETE FROM business_proposal_claims WHERE proposal_id=$1', [id])
        const proposal = db.proposals.find((item) => item.id === id)!
        for (const claimId of new Set(proposal.claimIds))
          await client.query(
            'INSERT INTO business_proposal_claims(proposal_id,claim_id,org_id) VALUES($1,$2,$3)',
            [id, claimId, proposal.orgId]
          )
      }
      if (
        key === 'transactions' &&
        (previous === undefined ||
          JSON.stringify(JSON.parse(previous).counselGrants) !==
            JSON.stringify(JSON.parse(serialized).counselGrants))
      ) {
        await client.query('DELETE FROM business_counsel_grants WHERE transaction_id=$1', [id])
        for (const grant of db.transactions.find((item) => item.id === id)!.counselGrants) {
          await client.query(
            'INSERT INTO business_counsel_grants(transaction_id,user_id,granted_by_org_id,granted_by_user_id) VALUES($1,$2,$3,$4)',
            [id, grant.userId, grant.grantedByOrgId, grant.grantedByUserId]
          )
        }
      }
    }
  }
  for (const [key, name] of (Object.entries(BUSINESS_TABLES) as [Collection, string][]).reverse()) {
    for (const [id, previous] of baseline[key])
      if (!next[key].has(id)) {
        const deleted = await client.query(
          `DELETE FROM ${name} WHERE id=$1 AND payload=$2::jsonb RETURNING id`,
          [id, previous]
        )
        if (!deleted.rows.length) throw new Error('业务实体已被并发修改')
      }
  }
  await client.query('SET CONSTRAINTS ALL IMMEDIATE')
}
