import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeHtml } from '../src/shared/sanitize.ts'

test('allowed editor markup is preserved', () => {
  const html = '<p>甲方与乙方</p><ul><li>三十日内交付</li><li>验收后付款</li></ul>'
  assert.equal(sanitizeHtml(html), html)
})

test('every attribute is dropped, including event handlers', () => {
  assert.equal(
    sanitizeHtml('<p onclick="alert(1)" class="x" style="color:red">hi</p>'),
    '<p>hi</p>'
  )
  assert.equal(sanitizeHtml("<p onmouseover='x()'>hi</p>"), '<p>hi</p>')
})

test('script and style are removed together with their content', () => {
  assert.equal(sanitizeHtml('<p>a</p><script>alert(1)</script><p>b</p>'), '<p>a</p><p>b</p>')
  assert.equal(sanitizeHtml('<style>body{display:none}</style><p>x</p>'), '<p>x</p>')
})

test('case and separator variants of dangerous tags are removed', () => {
  assert.equal(sanitizeHtml('<ScRiPt>alert(1)</ScRiPt>'), '')
  assert.equal(sanitizeHtml('<svg/onload="alert(1)">x</svg>'), '')
  assert.equal(sanitizeHtml('<IMG SRC="x" ONERROR="alert(1)">'), '')
  // "< script >" is not a tag to a browser; make sure we do not turn it into one either.
  const spaced = sanitizeHtml('< script >alert(1)</ script >')
  assert.ok(!/<script/i.test(spaced))
  assert.ok(!/<svg/i.test(spaced))
})

test('svg and other non-whitelisted elements disappear entirely', () => {
  assert.equal(sanitizeHtml('<svg onload="alert(1)"><rect/></svg><p>ok</p>'), '<p>ok</p>')
  assert.equal(sanitizeHtml('<img src=x onerror=alert(1)>'), '')
  assert.equal(sanitizeHtml('<iframe srcdoc="<script>alert(1)</script>"></iframe>'), '')
})

test('javascript: urls cannot survive because links carry no attributes', () => {
  const clean = sanitizeHtml('<a href="javascript:alert(1)">link</a>')
  assert.ok(!/javascript:/i.test(clean))
  assert.ok(!/<a/i.test(clean))
})

test('comments, doctype and processing instructions are dropped', () => {
  assert.equal(sanitizeHtml('<!-- leak --><p>ok</p>'), '<p>ok</p>')
  assert.equal(sanitizeHtml('<!DOCTYPE html><p>ok</p>'), '<p>ok</p>')
  assert.equal(sanitizeHtml('<?xml version="1.0"?><p>ok</p>'), '<p>ok</p>')
})

test('a ">" inside a quoted attribute does not break parsing', () => {
  assert.equal(sanitizeHtml('<p title="a>b">ok</p>'), '<p>ok</p>')
})

test('unclosed tags are balanced, unterminated tags stop the scan', () => {
  assert.equal(sanitizeHtml('<p>a<strong>b'), '<p>a<strong>b</strong></p>')
  assert.equal(sanitizeHtml('<p>a</em>b'), '<p>ab</p>')
  assert.equal(sanitizeHtml('<p>a<p onx="'), '<p>a</p>')
})

test('plain text and entities are left alone', () => {
  assert.equal(sanitizeHtml('价款 &amp; 违约金'), '价款 &amp; 违约金')
  assert.equal(sanitizeHtml('a < b 且 c > d'), 'a &lt; b 且 c > d')
})

test('empty and non-string input is safe', () => {
  assert.equal(sanitizeHtml(''), '')
  assert.equal(sanitizeHtml(undefined as unknown as string), '')
})
