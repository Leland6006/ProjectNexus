import { useMemo } from 'react'
import { diffClauses, summarizeDiff, type DiffSegment } from '@shared/diff'
import type { Clause } from '@shared/types'
import { Badge } from './ui'

function Segments({ segments }: { segments: DiffSegment[] }) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.op === 'equal' ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <span key={i} className={seg.op === 'insert' ? 'diff-ins' : 'diff-del'}>
            {seg.text}
          </span>
        )
      )}
    </>
  )
}

const CHANGE_LABEL = { added: ['green', '新增'], removed: ['red', '删除'], modified: ['amber', '修改'], unchanged: ['gray', '无变化'] } as const

export function DiffView({ oldClauses, newClauses, showUnchanged = false }: { oldClauses: Clause[]; newClauses: Clause[]; showUnchanged?: boolean }) {
  const diffs = useMemo(() => diffClauses(oldClauses, newClauses), [oldClauses, newClauses])
  const summary = summarizeDiff(diffs)
  const visible = diffs.filter((d) => showUnchanged || d.change !== 'unchanged')

  return (
    <div>
      <div className="mb-3 flex gap-2 text-xs">
        <Badge tone="amber">修改 {summary.modified}</Badge>
        <Badge tone="green">新增 {summary.added}</Badge>
        <Badge tone="red">删除 {summary.removed}</Badge>
        <Badge tone="gray">无变化 {summary.unchanged}</Badge>
      </div>
      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-500">两个版本内容完全一致</p>
      ) : (
        <div className="space-y-3">
          {visible.map((d) => {
            const [tone, label] = CHANGE_LABEL[d.change]
            return (
              <div key={d.clauseId} className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
                  <span className="text-sm font-medium">
                    <Segments segments={d.titleSegments} />
                  </span>
                  <Badge tone={tone}>{label}</Badge>
                </div>
                <div className="whitespace-pre-wrap px-3 py-2.5 text-sm leading-7">
                  <Segments segments={d.bodySegments} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
