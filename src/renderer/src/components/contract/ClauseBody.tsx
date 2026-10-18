import { Trash2 } from 'lucide-react'
import type { Clause } from '@shared/types'
import { sanitizeHtml } from '@shared/sanitize'
import { cn } from '@/lib/utils'
import { ClauseEditor } from '../ClauseEditor'
import { Input } from '../ui'

/** Middle column of the editor: the editable clause text. */
export function ClauseBody({
  clauses,
  activeId,
  canEdit,
  onSelect,
  onChange,
  onDelete
}: {
  clauses: Clause[]
  activeId: string | undefined
  canEdit: boolean
  onSelect: (id: string) => void
  onChange: (id: string, patch: Partial<Clause>) => void
  onDelete: (clause: Clause) => void
}) {
  return (
    <section className="overflow-y-auto bg-white" aria-label="合同正文">
      <div className="mx-auto max-w-3xl px-8 py-6">
        {clauses.map((c) => {
          const isActive = c.id === activeId
          return (
            <article
              key={c.id}
              id={`clause-${c.id}`}
              onClick={() => onSelect(c.id)}
              className={cn(
                'group mb-4 rounded-lg border px-4 py-3 transition-colors',
                isActive ? 'border-brand-200 bg-brand-50/30' : 'border-transparent hover:border-slate-200'
              )}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                {canEdit && isActive ? (
                  <Input value={c.title} onChange={(e) => onChange(c.id, { title: e.target.value })} aria-label="条款标题" className="font-semibold" />
                ) : (
                  <h2 className="font-semibold">{c.title}</h2>
                )}
                {canEdit && isActive && clauses.length > 1 && (
                  <button
                    aria-label="删除条款"
                    title="删除条款"
                    onClick={() => onDelete(c)}
                    className="rounded p-1 text-ink-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              {canEdit && isActive ? (
                <ClauseEditor value={c.body} onChange={(html) => onChange(c.id, { body: html })} />
              ) : (
                <div className="contract-body text-sm" dangerouslySetInnerHTML={{ __html: sanitizeHtml(c.body) }} />
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
