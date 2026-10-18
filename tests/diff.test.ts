import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffClauses, diffText, htmlToText, summarizeDiff, tokenize } from '../src/shared/diff.ts'

test('htmlToText strips tags and keeps paragraph breaks', () => {
  assert.equal(htmlToText('<p>甲方</p><p>乙方 &amp; 丙方</p>'), '甲方\n乙方 & 丙方')
})

test('tokenize splits Chinese by character and keeps latin words whole', () => {
  assert.deepEqual(tokenize('交付 30 days'), ['交', '付', ' ', '30', ' ', 'days'])
})

test('diffText marks changed characters', () => {
  const segs = diffText('交付期为30日', '交付期为45日')
  assert.deepEqual(
    segs.map((s) => [s.op, s.text]),
    [
      ['equal', '交付期为'],
      ['delete', '30'],
      ['insert', '45'],
      ['equal', '日']
    ]
  )
})

test('diffText reconstructs both sides exactly', () => {
  const a = '违约金总额不超过合同总价款的10%。'
  const b = '违约金总额不超过合同总价款的5%，以实际损失为限。'
  const segs = diffText(a, b)
  assert.equal(segs.filter((s) => s.op !== 'insert').map((s) => s.text).join(''), a)
  assert.equal(segs.filter((s) => s.op !== 'delete').map((s) => s.text).join(''), b)
})

test('diffClauses detects added, removed, modified and unchanged', () => {
  const oldC = [
    { id: '1', title: '一', body: '<p>甲</p>' },
    { id: '2', title: '二', body: '<p>乙</p>' },
    { id: '3', title: '三', body: '<p>丙</p>' }
  ]
  const newC = [
    { id: '1', title: '一', body: '<p>甲</p>' },
    { id: '2', title: '二', body: '<p>乙乙</p>' },
    { id: '4', title: '四', body: '<p>丁</p>' }
  ]
  const s = summarizeDiff(diffClauses(oldC, newC))
  assert.deepEqual(s, { added: 1, removed: 1, modified: 1, unchanged: 1 })
})

test('identical text yields a single equal segment', () => {
  assert.deepEqual(diffText('abc', 'abc'), [{ op: 'equal', text: 'abc' }])
})

function reconstruct(segs: { op: string; text: string }[], keep: 'old' | 'new'): string {
  const drop = keep === 'old' ? 'insert' : 'delete'
  return segs.filter((s) => s.op !== drop).map((s) => s.text).join('')
}

test('a single edit inside a long document stays exact', () => {
  const head = '甲方应当按照约定交付设备并承担运输费用。'.repeat(400)
  const tail = '双方另有书面约定的从其约定。'.repeat(400)
  const a = `${head}交付期为30日。${tail}`
  const b = `${head}交付期为45日。${tail}`

  const segs = diffText(a, b)
  assert.equal(reconstruct(segs, 'old'), a)
  assert.equal(reconstruct(segs, 'new'), b)
  // Shared head and tail must collapse into single equal blocks, not per-character noise.
  assert.ok(segs.filter((s) => s.op === 'equal').length <= 2, 'head/tail were not trimmed')
  assert.ok(segs.some((s) => s.op === 'delete' && s.text === '30'))
  assert.ok(segs.some((s) => s.op === 'insert' && s.text === '45'))
})

test('a long document with one edit stays responsive', () => {
  const head = '供方应在预付款到账后完成交付。'.repeat(600)
  const tail = '需方应在收货后完成验收。'.repeat(600)
  const a = `${head}违约金上限为10%。${tail}`
  const b = `${head}违约金上限为5%。${tail}`

  const started = Date.now()
  diffText(a, b)
  assert.ok(Date.now() - started < 2000, `diff took ${Date.now() - started}ms on a 15k token document`)
})

test('a wholesale rewrite degrades to a block replacement instead of exploding', () => {
  const a = '甲'.repeat(1500)
  const b = '乙'.repeat(1500)
  const segs = diffText(a, b)
  assert.deepEqual(segs.map((s) => s.op), ['delete', 'insert'])
  assert.equal(reconstruct(segs, 'old'), a)
  assert.equal(reconstruct(segs, 'new'), b)
})
