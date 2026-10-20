import { GitCompare } from 'lucide-react'
import type { Contract, Suggestion } from '@shared/types'
import { htmlToText } from '@shared/diff'
import { cn, formatDateTime } from '@/lib/utils'
import { userLabel } from '@/lib/selectors'
import { useApp, useView } from '@/store'
import { SuggestionStatusBadge } from '../badges'
import { Button, EmptyState } from '../ui'

export function SuggestionsPanel({
  contract,
  activeClauseId,
  canPropose,
  canResolve,
  isOther,
  onPropose,
  dirty
}: {
  contract: Contract
  activeClauseId: string | null
  canPropose: boolean
  canResolve: boolean
  isOther: (orgId: string) => boolean
  onPropose: () => void
  dirty: boolean
}) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const list = s.suggestions
    .filter((x) => x.contractId === contract.id)
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt))

  const card = (sg: Suggestion) => {
    const clause = contract.clauses.find((c) => c.id === sg.clauseId)
    return (
      <div
        key={sg.id}
        className={cn(
          'rounded-lg border bg-white p-3',
          sg.clauseId === activeClauseId ? 'border-brand-200' : 'border-slate-200'
        )}
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-medium">{clause?.title ?? '（条款已删除）'}</span>
          <SuggestionStatusBadge status={sg.status} />
        </div>
        <p className="mb-2 text-xs text-ink-500">
          {userLabel(s, sg.authorId)} · {formatDateTime(sg.createdAt)}
        </p>
        <p className="mb-2 text-sm text-ink-700">理由：{sg.reason}</p>
        <div className="mb-2 space-y-1 rounded bg-slate-50 p-2 text-xs">
          <p className="text-ink-500">原文</p>
          <p className="whitespace-pre-wrap text-ink-700">{htmlToText(sg.originalBody)}</p>
          <p className="pt-1 text-ink-500">建议改为</p>
          <p className="whitespace-pre-wrap text-ink-900">{htmlToText(sg.proposedBody)}</p>
        </div>
        {sg.status === 'pending' && canResolve && isOther(sg.orgId) && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={dirty}
              title={dirty ? '请先保存草稿' : undefined}
              onClick={() => void act('resolveSuggestion', [sg.id, true], '已接受修改建议')}
            >
              接受
            </Button>
            <Button
              size="sm"
              loading={busy}
              onClick={() => void act('resolveSuggestion', [sg.id, false], '已拒绝修改建议')}
            >
              拒绝
            </Button>
          </div>
        )}
        {sg.status === 'pending' && !isOther(sg.orgId) && (
          <p className="text-xs text-ink-500">等待对方处理</p>
        )}
        {sg.resolvedAt && (
          <p className="text-xs text-ink-400">
            处理于 {formatDateTime(sg.resolvedAt)}，{userLabel(s, sg.resolvedBy!)}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3 p-3">
      {canPropose && (
        <Button className="w-full" onClick={onPropose} disabled={!activeClauseId}>
          <GitCompare className="h-3.5 w-3.5" />
          对当前条款提出修改建议
        </Button>
      )}
      {list.length === 0 ? (
        <EmptyState
          title="暂无修改建议"
          hint="交易双方可对共享合同的条款提出修改，由对方接受或拒绝"
        />
      ) : (
        list.map(card)
      )}
    </div>
  )
}
