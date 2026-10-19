import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'
import { createSeedDatabase, DEFAULT_USER_ID } from '../src/shared/seed.ts'
import { NexusService } from '../src/shared/service.ts'
import { buildViewState } from '../src/shared/permissions.ts'
import { extractContractText, identifyContractFields } from '../src/main/contractImport.ts'
import { createSession, handleCall } from '../src/main/handlers.ts'
import { migrateDatabase, CURRENT_SCHEMA_VERSION } from '../src/shared/migrations.ts'
import { attentionItems } from '../src/shared/briefing.ts'

const documentText = '甲方：上海测试科技有限公司\n乙方：杭州测试工作室\n合同总金额：人民币 20,000 元\n签订日期：2026年10月19日\n预付款比例为40%，验收后支付尾款。'
const docx = (text = documentText) => zipSync({ 'word/document.xml': strToU8(`<w:document><w:body>${text.split('\n').map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`) })
const newInput = { title: '导入合同', name: '新业务', counterpartyName: '杭州测试工作室', amount: 20000, expectedSignDate: '2026-10-19', acknowledged: true }

test('DOCX text and candidates preserve source quotes, ambiguous values stay unfilled', async () => {
  const text = await extractContractText('合同.docx', docx())
  assert.equal(text, documentText)
  const fields = identifyContractFields(text)
  assert.equal(fields.candidates.find((c) => c.field === 'amount')?.value, '20,000')
  assert.ok(fields.candidates.every((c) => text.includes(c.quote)))
  assert.ok(!identifyContractFields(text + '\n甲方：另一家企业').candidates.some((c) => c.field === 'partyA'))
  assert.equal((await extractContractText('test.docx', docx('&lt;script&gt; &amp; 文本'))), '<script> & 文本')
})

test('invalid, oversized, unsupported and empty documents fail without producing drafts', async () => {
  await assert.rejects(extractContractText('x.doc', new Uint8Array([1])))
  await assert.rejects(extractContractText('x.docx', new Uint8Array([1])))
  await assert.rejects(extractContractText('x.docx', docx('')))
  await assert.rejects(extractContractText('x.docx', new Uint8Array(10 * 1024 * 1024 + 1)))
  await assert.rejects(extractContractText('x.docx', docx('x'.repeat(2 * 1024 * 1024 + 1))))
  await assert.rejects(extractContractText('x.pdf', new Uint8Array([1])))
})

// Actual PDF bytes, including byte offsets, exercise the installed PDF parser.
function pdfBytes(): Uint8Array {
  const stream = 'BT /F1 12 Tf 20 700 Td (Contract amount: 20000) Tj ET'
  const objects = [ '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream` ]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n` }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new Uint8Array(Buffer.from(pdf))
}
test('text PDF extraction works with the real parser', async () => {
  assert.match(await extractContractText('sample.pdf', pdfBytes()), /Contract amount: 20000/)
})

test('independent counterparties are private, deduplicated and cannot receive fake online invites', () => {
  const db = createSeedDatabase(), service = new NexusService(db)
  const cp = service.createCounterparty(DEFAULT_USER_ID, { name: '独立测试客户', email: 'owner@example.com' })
  assert.equal(service.createCounterparty(DEFAULT_USER_ID, { name: '独立测试客户' }).id, cp.id)
  const input = { name: '独立交易', type: '其他', counterpartyOrgId: cp.id, amount: 20, expectedSignDate: '2026-10-19', description: '' }
  assert.throws(() => service.createTransaction(DEFAULT_USER_ID, { ...input, status: 'invalid' as never }))
  const tx = service.createTransaction(DEFAULT_USER_ID, input)
  assert.throws(() => service.inviteCounterparty(DEFAULT_USER_ID, tx.id))
  assert.equal(tx.counterpartyStatus, 'none')
  assert.throws(() => service.createTransaction('u_b_biz', input))
  assert.throws(() => service.createCounterparty('u_a_counsel', { name: '客户' }))
  assert.throws(() => service.createCounterparty(DEFAULT_USER_ID, { name: '客户', email: 'wrong' }))
  for (const user of ['u_b_biz', 'u_a_counsel']) {
    const view = buildViewState(db, user, { demoDirectory: true })
    assert.equal(view.counterparties.length, 0)
    assert.ok(!view.demoAccounts?.organizations.some((o) => o.id === cp.id))
  }
})

test('import confirmation is atomic, human-confirmed, idempotent, escaped and has no financial mirror', () => {
  const db = createSeedDatabase(), service = new NexusService(db)
  const rawText = documentText + '\n<script>alert(1)</script>'
  const draft = service.stageContractImport(DEFAULT_USER_ID, { fileName: '合同.docx', rawText, ...identifyContractFields(rawText) })
  const before = JSON.stringify(db)
  assert.throws(() => service.confirmContractImport(DEFAULT_USER_ID, draft.id, { ...newInput, acknowledged: false }))
  assert.throws(() => service.confirmContractImport(DEFAULT_USER_ID, draft.id, { ...newInput, expectedSignDate: '2026-02-30' }))
  assert.throws(() => service.confirmContractImport('u_a_legal', draft.id, newInput))
  assert.throws(() => service.confirmContractImport(DEFAULT_USER_ID, draft.id, { ...newInput, transactionId: 'tx_not_found' }))
  assert.equal(JSON.stringify(db), before)
  const c = service.confirmContractImport(DEFAULT_USER_ID, draft.id, newInput)
  assert.equal(c.paymentTerms, null)
  assert.equal(c.sharedWithCounterparty, false)
  assert.match(c.clauses.at(-1)!.body, /&lt;script&gt;/)
  assert.ok(!c.clauses.at(-1)!.body.includes('<script>'))
  assert.equal(service.confirmContractImport(DEFAULT_USER_ID, draft.id, newInput).id, c.id)
  assert.equal(db.transactions.filter((t) => t.name === '新业务').length, 1)
  assert.equal(buildViewState(db, 'u_a_legal').importDrafts.length, 0)
  assert.equal(db.versions.filter((v) => v.contractId === c.id).length, 2)
})

test('native file selection stages a private draft and rejects identity changes while selecting', async () => {
  const db = createSeedDatabase(), session = createSession(db, DEFAULT_USER_ID, () => {})
  session.selectContractFile = async () => ({ fileName: 'import.docx', bytes: docx() })
  assert.equal((await handleCall(session, 'selectContractImport', [])).ok, true)
  assert.equal(db.importDrafts.length, 1)
  assert.equal(db.transactions.length, createSeedDatabase().transactions.length)
  session.selectContractFile = async () => { await handleCall(session, 'switchUser', ['u_b_biz']); return { fileName: 'late.docx', bytes: docx() } }
  assert.equal((await handleCall(session, 'selectContractImport', [])).ok, false)
  assert.equal(db.importDrafts.length, 1)
  session.selectContractFile = async () => null
  assert.equal((await handleCall(session, 'selectContractImport', [])).ok, true)
  assert.equal(db.importDrafts.length, 1)
})

test('internal reviews enforce distinct colleagues, exact source, reviewer identity and private decisions', () => {
  const db = createSeedDatabase(), service = new NexusService(db)
  const contract = db.contracts.find((c) => c.transactionId === 'tx_equip')!
  assert.throws(() => service.requestInternalReview(DEFAULT_USER_ID, contract.id, DEFAULT_USER_ID))
  assert.throws(() => service.requestInternalReview(DEFAULT_USER_ID, contract.id, 'u_b_biz'))
  const r = service.requestInternalReview(DEFAULT_USER_ID, contract.id, 'u_a_legal')
  assert.equal(service.requestInternalReview(DEFAULT_USER_ID, contract.id, 'u_a_legal').id, r.id)
  assert.equal(buildViewState(db, 'u_b_biz').internalReviews.length, 0)
  assert.equal(buildViewState(db, 'u_a_counsel').internalReviews.length, 0)
  assert.ok(attentionItems(buildViewState(db, 'u_a_legal'), new Date()).some((i) => i.kind === 'review'))
  assert.throws(() => service.decideInternalReview(DEFAULT_USER_ID, r.id, { decision: 'approved', comment: '本人不能代审' }))
  service.updateClauses(DEFAULT_USER_ID, contract.id, contract.clauses.map((c, i) => i ? c : { ...c, body: '<p>新条款</p>' }))
  assert.throws(() => service.decideInternalReview('u_a_legal', r.id, { decision: 'approved', comment: '旧稿不可通过' }))
  const next = service.requestInternalReview(DEFAULT_USER_ID, contract.id, 'u_a_legal')
  service.decideInternalReview('u_a_legal', next.id, { decision: 'rejected', comment: '付款时间需要调整' })
  assert.equal(next.status, 'rejected')
  assert.equal(contract.status, 'negotiating')
  assert.throws(() => service.decideInternalReview('u_a_legal', next.id, { decision: 'approved', comment: '重复处理' }))
})

test('v5 migration preserves all previous task and analysis data', () => {
  const db = createSeedDatabase(), raw = db as unknown as Record<string, unknown>
  db.schemaVersion = 5
  delete raw.counterparties; delete raw.importDrafts; delete raw.internalReviews
  const txs = JSON.stringify(db.transactions)
  assert.ok(migrateDatabase(db).ok)
  assert.equal(db.schemaVersion, CURRENT_SCHEMA_VERSION)
  assert.deepEqual(db.counterparties, [])
  assert.equal(JSON.stringify(db.transactions), txs)
})

test('requested internal approval gates final confirmation, including stale approved drafts', () => {
  const db = createSeedDatabase(), service = new NexusService(db)
  const c = db.contracts.find((c) => c.transactionId === 'tx_equip')!
  const r = service.requestInternalReview(DEFAULT_USER_ID, c.id, 'u_a_legal')
  const version = db.versions.filter((v) => v.contractId === c.id).at(-1)!
  assert.throws(() => service.confirmFinal(DEFAULT_USER_ID, c.id, version.id), /内部审阅/)
  service.decideInternalReview('u_a_legal', r.id, { decision: 'approved', comment: '核对通过' })
  service.confirmFinal(DEFAULT_USER_ID, c.id, version.id)
  service.updateClauses(DEFAULT_USER_ID, c.id, c.clauses.map((cl, i) => i ? cl : { ...cl, body: '<p>审阅之后变更</p>' }))
  assert.throws(() => service.confirmFinal(DEFAULT_USER_ID, c.id, version.id), /新版本/)
  const next = service.saveVersion(DEFAULT_USER_ID, c.id, '修订版')
  assert.throws(() => service.confirmFinal(DEFAULT_USER_ID, c.id, next.id), /重新发起内部审阅/)
})
