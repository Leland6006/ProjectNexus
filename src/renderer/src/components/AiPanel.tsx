import { useState } from 'react'
import { Bot, FileSearch, ListChecks, ShieldAlert, Sparkles } from 'lucide-react'
import { htmlToText } from '@shared/diff'
import type { Contract } from '@shared/types'
import { Badge, Button } from './ui'

// IMPORTANT: this panel is a clearly-labelled SIMULATION. No AI model is called and no
// real analysis happens. Output is produced by simple local rules (counting, keyword matching)
// and is shown with a permanent "模拟AI输出" label.

type Mode = 'summary' | 'risk' | 'obligations'

function simulate(mode: Mode, contract: Contract): string[] {
  const texts = contract.clauses.map((c) => ({ title: c.title, text: htmlToText(c.body) }))
  if (mode === 'summary') {
    const chars = texts.reduce((n, t) => n + t.text.length, 0)
    return [
      `本合同共 ${contract.clauses.length} 个条款，正文约 ${chars} 字。`,
      `条款目录：${texts.map((t) => t.title).join('；')}。`
    ]
  }
  if (mode === 'risk') {
    const hits: string[] = []
    for (const t of texts) {
      if (/违约金/.test(t.text))
        hits.push(`「${t.title}」涉及违约金，建议核对计算基数与上限是否合理。`)
      if (/视为|默认|自动/.test(t.text))
        hits.push(`「${t.title}」含“视为/默认/自动”表述，建议确认是否对一方不利。`)
      if (!/争议|管辖|仲裁|诉讼/.test(texts.map((x) => x.text).join(''))) {
        if (!hits.includes('合同中未发现争议解决条款，建议补充管辖或仲裁约定。'))
          hits.push('合同中未发现争议解决条款，建议补充管辖或仲裁约定。')
      }
    }
    return hits.length ? hits : ['基于关键词规则，未发现需要提示的条款。']
  }
  const out: string[] = []
  for (const t of texts) {
    for (const m of t.text.matchAll(/([^。；\n]*?(?:日内|个工作日内|个月内)[^。；\n]*)/g))
      out.push(`「${t.title}」${m[1].trim()}`)
  }
  return out.length ? out : ['基于关键词规则，未提取到带期限的履约义务。']
}

export function AiPanel({ contract }: { contract: Contract }) {
  const [mode, setMode] = useState<Mode | null>(null)
  const result = mode ? simulate(mode, contract) : null
  const tabs: { mode: Mode; label: string; icon: React.ReactNode }[] = [
    { mode: 'summary', label: '合同摘要', icon: <FileSearch className="h-3.5 w-3.5" /> },
    { mode: 'risk', label: '风险提示', icon: <ShieldAlert className="h-3.5 w-3.5" /> },
    { mode: 'obligations', label: '履约义务', icon: <ListChecks className="h-3.5 w-3.5" /> }
  ]
  return (
    <div className="space-y-3 p-3">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        <div className="mb-1 flex items-center gap-1.5 font-semibold">
          <Bot className="h-4 w-4" />
          模拟AI输出
        </div>
        当前未接入任何 AI 模型。下方结果由本地简单规则（统计、关键词匹配）生成，仅用于演示未来的 AI
        助手入口，不构成法律意见。
      </div>
      <div className="flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <Button
            key={t.mode}
            size="sm"
            variant={mode === t.mode ? 'primary' : 'secondary'}
            onClick={() => setMode(t.mode)}
          >
            {t.icon}
            {t.label}
          </Button>
        ))}
      </div>
      {result ? (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-2 flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-brand-600" />
            <Badge tone="amber">模拟AI输出</Badge>
          </div>
          <ul className="list-disc space-y-1.5 pl-4 text-sm text-ink-700">
            {result.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-ink-500">选择一项功能查看演示输出。</p>
      )}
      <p className="text-xs text-ink-400">
        规划中：版本变化总结、法律问题提示（接入真实模型后提供）。
      </p>
    </div>
  )
}
