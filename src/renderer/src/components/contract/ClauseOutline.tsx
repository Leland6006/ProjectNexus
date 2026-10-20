import { MessageSquare, Plus } from 'lucide-react'
import type { Clause } from '@shared/types'
import { clauseBadges } from '@shared/editorRules'
import { cn } from '@/lib/utils'
import { useView } from '@/store'

/**
 * Left column of the editor: the clause outline with per-clause comment and
 * open-suggestion counters.
 */
export function ClauseOutline({
  contractId,
  clauses,
  activeId,
  canEdit,
  onSelect,
  onAdd
}: {
  contractId: string
  clauses: Clause[]
  activeId: string | undefined
  canEdit: boolean
  onSelect: (id: string) => void
  onAdd: () => void
}) {
  const s = useView()
  return (
    <nav
      className="overflow-y-auto border-r border-slate-200 bg-slate-50/60 p-3"
      aria-label="条款目录"
    >
      <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium text-ink-500">
        条款目录
        {canEdit && (
          <button
            onClick={onAdd}
            className="rounded p-1 text-brand-600 hover:bg-brand-50"
            aria-label="添加条款"
            title="添加条款"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <ul className="space-y-0.5">
        {clauses.map((c) => {
          const { comments, pendingSuggestions } = clauseBadges(
            s.comments,
            s.suggestions,
            contractId,
            c.id
          )
          return (
            <li key={c.id}>
              <button
                onClick={() => onSelect(c.id)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                  c.id === activeId
                    ? 'bg-white font-medium text-brand-700 shadow-sm ring-1 ring-slate-200'
                    : 'text-ink-700 hover:bg-slate-100'
                )}
              >
                <span className="truncate">{c.title}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {pendingSuggestions > 0 && (
                    <span className="rounded-full bg-amber-100 px-1.5 text-xs text-amber-700">
                      {pendingSuggestions}
                    </span>
                  )}
                  {comments > 0 && (
                    <span className="flex items-center gap-0.5 text-xs text-ink-400">
                      <MessageSquare className="h-3 w-3" />
                      {comments}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
