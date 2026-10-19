// Local text extraction only. Documents never execute code or supply tool instructions.
import { unzipSync, strFromU8 } from 'fflate'
import { extname } from 'node:path'
import { NexusError, type ContractImportDraft } from '../shared/types.ts'
const MAX_TEXT = 100_000
const fail = (message: string): never => { throw new NexusError('INVALID_INPUT', message) }
function entities(text: string): string {
  return text.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (_, code: string, name: string) => {
    if (code) { const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '' }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()] ?? ''
  })
}
export async function extractContractText(fileName: string, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > 10 * 1024 * 1024) fail('文件不能超过 10 MB')
  let text = ''
  const ext = extname(fileName).toLowerCase()
  try {
    if (ext === '.docx') {
      let oversize = false
      const files = unzipSync(bytes, { filter: (f) => {
        if (f.name !== 'word/document.xml') return false
        if (f.originalSize > 2 * 1024 * 1024) { oversize = true; return false }
        return true
      } })
      if (oversize) fail('文档正文过大，请拆分后导入')
      if (!files['word/document.xml']) fail('未找到 DOCX 正文，请确认文件格式')
      const xml = strFromU8(files['word/document.xml'])
      text = entities(xml.replace(/<w:tab\b[^>]*\/?\s*>/g, '\t').replace(/<w:(br|cr)\b[^>]*\/?\s*>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]*>/g, ''))
    } else if (ext === '.pdf') {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      // Explicit worker path is also needed in packaged Electron's externalized dependency.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href
      const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true })
      let pdf: Awaited<typeof loading.promise> | undefined
      try {
        pdf = await loading.promise
        if (pdf.numPages > 50) fail('PDF 不能超过 50 页，请拆分后导入')
        const lines: string[] = []
        for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
          const page = await pdf.getPage(pageNo)
          const content = await page.getTextContent()
          lines.push(content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join(''))
          if (lines.join('\n').length > MAX_TEXT) fail('提取文字过多，请拆分后导入')
          page.cleanup()
        }
        text = lines.join('\n')
      } finally { await loading.destroy() }
    } else fail('仅支持 DOCX 和文字型 PDF 文件')
  } catch (err) {
    if (err instanceof NexusError) throw err
    fail('无法读取文件。请检查文件是否损坏或加密；旧版 DOC 请先另存为 DOCX')
  }
  text = text.replace(/\u0000/g, '').replace(/\r/g, '').trim()
  if (!text) fail('未提取到文字。扫描版 PDF 请先进行 OCR 后再导入')
  if (text.length > MAX_TEXT) fail('正文不能超过 10 万字，请拆分后导入')
  return text
}

// Conservative candidate extraction: each value must retain a verbatim source quote.
export function identifyContractFields(text: string): Pick<ContractImportDraft, 'candidates' | 'warnings'> {
  const candidates: ContractImportDraft['candidates'] = []
  for (const [field, pattern] of [
    ['partyA', /甲方(?:[（(][^\n)）]{0,20}[)）])?\s*[:：]\s*([^\n;；]{2,100})/g],
    ['partyB', /乙方(?:[（(][^\n)）]{0,20}[)）])?\s*[:：]\s*([^\n;；]{2,100})/g],
    ['amount', /(?:合同总金额|合同金额|合同总价|总价款)\s*[:：为]?\s*(?:人民币|RMB|CNY|¥|￥)?\s*([\d,，]+(?:\.\d{1,2})?)\s*元?/g],
    ['date', /(?:签订日期|签约日期)\s*[:：]?\s*(\d{4}[-年/.]\d{1,2}[-月/.]\d{1,2}日?)/g]
  ] as const) {
    const matches = [...text.matchAll(pattern)]
    const unique = [...new Set(matches.map((m) => m[1].trim()))]
    // Ambiguous fields deliberately remain empty for human input.
    if (unique.length === 1) candidates.push({ field, value: unique[0], quote: matches[0][0] })
  }
  return { candidates, warnings: ['规则识别结果未经核对；请与原文件逐项比对。', '仅导入文字，排版、表格结构、印章、签名和附件可能丢失。原文件请另行保管。', '付款条款尚未转换为资金计划，请在合同中人工核对付款安排。'] }
}
