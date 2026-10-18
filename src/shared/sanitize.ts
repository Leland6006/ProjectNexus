// Whitelist HTML clean-up for contract text.
//
// The Tiptap editor only emits a small tag set, so instead of blacklisting known-bad
// markup (which is always one encoding trick away from being bypassed) we re-build the
// output from an allowlist: every tag that is not explicitly permitted is dropped, and
// **all attributes are discarded**. That removes `on*` handlers, `javascript:` URLs,
// `<svg onload>`, `srcdoc`, `formaction` and friends by construction rather than by
// pattern matching.
//
// This runs in the Electron main process (no DOM available), so a dependency-free
// scanner is used instead of DOMPurify. It is intentionally conservative: if it cannot
// parse a tag it drops it.

/** Tags the rich-text editor is allowed to produce. */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'p',
  'br',
  'hr',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'strike',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6'
])

/** Emitted without a closing tag. */
const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr'])

/**
 * Elements whose *content* must be discarded too. Their text is either executable
 * (script) or would be rendered as visible garbage (style, svg, template...).
 */
const DROP_CONTENT_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'template',
  'noscript',
  'textarea',
  'title',
  'svg',
  'math',
  'head',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'select',
  'option',
  'audio',
  'video',
  'source',
  'track',
  'canvas',
  'frame',
  'frameset'
])

const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*/

export function sanitizeHtml(html: string): string {
  if (typeof html !== 'string' || html.length === 0) return ''

  let out = ''
  const open: string[] = []
  let i = 0
  const n = html.length

  const closeTo = (index: number): void => {
    for (let k = open.length - 1; k >= index; k--) out += `</${open[k]}>`
    open.length = index
  }

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      out += html.slice(i)
      break
    }
    if (lt > i) out += html.slice(i, lt)

    // Comments, doctype, CDATA and processing instructions never contribute content.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (html.startsWith('<![', lt) || html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt + 2)
      i = end < 0 ? n : end + 1
      continue
    }

    // Scan to the closing '>' while respecting quoted attribute values.
    let j = lt + 1
    let quote = ''
    while (j < n) {
      const ch = html[j]
      if (quote) {
        if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
      j++
    }
    // Unterminated tag: nothing after it can be trusted, stop here.
    if (j >= n) break

    const raw = html.slice(lt + 1, j)
    i = j + 1

    // A tag name must follow '<' (or '</') immediately; "< b" is text, not a tag.
    const isClosing = raw.startsWith('/')
    const name = (isClosing ? raw.slice(1) : raw).match(TAG_NAME)?.[0]?.toLowerCase() ?? ''
    // Not a real tag (e.g. "a < b"): keep the character as escaped text so surrounding
    // prose survives instead of being swallowed up to the next '>'.
    if (!name) {
      out += '&lt;'
      i = lt + 1
      continue
    }

    if (DROP_CONTENT_TAGS.has(name)) {
      if (!isClosing) {
        const m = html.slice(i).match(new RegExp(`</\\s*${name}\\s*>`, 'i'))
        i = m && m.index !== undefined ? i + m.index + m[0].length : n
      }
      continue
    }

    if (isClosing) {
      const at = open.lastIndexOf(name)
      if (at >= 0) closeTo(at)
      continue
    }

    if (!ALLOWED_TAGS.has(name)) continue

    if (VOID_TAGS.has(name)) {
      out += `<${name} />`
      continue
    }

    out += `<${name}>`
    open.push(name)
  }

  closeTo(0)
  return out
}
