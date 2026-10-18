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
