import { useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { Clause, Contract } from '@shared/types'
import { sanitizeHtml } from '@shared/sanitize'
import { previousVersion, sortVersionsDesc } from '@shared/editorRules'
import { cn, formatDateTime } from '@/lib/utils'
import { userLabel } from '@/lib/selectors'
import { useApp, useView } from '@/store'
import { ClauseEditor } from '../ClauseEditor'
import { DiffView } from '../DiffView'
import { Badge, Button, Dialog, EmptyState, Field, Input, Textarea } from '../ui'

export function SaveVersionDialog({
  onClose,
  onSave
}: {
  onClose: () => void
  onSave: (label: string, note: string) => Promise<boolean>
}) {
  const busy = useApp((x) => x.busy)
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  return (
    <Dialog open onClose={onClose} title="保存为新版本">
      <div className="space-y-3">
        <Field label="版本名称" hint="例如：第二轮协商稿">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
        </Field>
        <Field label="版本说明（可选）">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="本次修改了什么"
          />
        </Field>
        <p className="text-xs text-ink-500">
          保存新版本会清除已有的“确认最终版”标记，双方需重新确认。
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!label.trim()}
            onClick={() => void onSave(label, note)}
          >
            保存版本
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function SuggestDialog({
  clause,
  onClose,
  onSubmit
}: {
  clause: Clause
  onClose: () => void
  onSubmit: (html: string, reason: string) => Promise<void>
}) {
  const busy = useApp((x) => x.busy)
  const [html, setHtml] = useState(clause.body)
  const [reason, setReason] = useState('')
  const unchanged = html.trim() === clause.body.trim()
  return (
    <Dialog open onClose={onClose} title={`修改建议：${clause.title}`} width="max-w-2xl">
      <div className="space-y-3">
        <Field label="修改后的条款内容">
          <ClauseEditor value={html} onChange={setHtml} />
        </Field>
        <Field label="修改理由">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="向对方说明为什么需要这样修改"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={unchanged || !reason.trim()}
            onClick={() => void onSubmit(html, reason)}
          >
            提交建议
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function VersionsDialog({
  contract,
  canRestore,
  onClose
}: {
  contract: Contract
  canRestore: boolean
  onClose: () => void
}) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const versions = useMemo(
    () => sortVersionsDesc(s.versions.filter((v) => v.contractId === contract.id)),
    [s.versions, contract.id]
  )
  const [selId, setSelId] = useState<string | null>(versions[0]?.id ?? null)
  const [mode, setMode] = useState<'diff' | 'view'>('diff')
  const sel = versions.find((v) => v.id === selId)
  const prev = previousVersion(versions, sel)

  return (
    <Dialog open onClose={onClose} title="版本历史与比较" width="max-w-5xl">
      <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-4">
        <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
          {versions.map((v) => (
            <li key={v.id}>
              <button
                onClick={() => setSelId(v.id)}
                className={cn(
                  'w-full rounded-md border px-2.5 py-2 text-left',
                  v.id === selId
                    ? 'border-brand-200 bg-brand-50'
                    : 'border-slate-200 hover:bg-slate-50'
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    v{v.number} · {v.label}
                  </span>
                  {contract.finalVersionId === v.id && contract.status === 'finalized' && (
                    <Badge tone="green">最终版</Badge>
                  )}
                </div>
                <p className="text-xs text-ink-500">
                  {userLabel(s, v.authorId)} · {formatDateTime(v.createdAt)}
                </p>
              </button>
            </li>
          ))}
        </ul>
        <div className="max-h-[60vh] overflow-y-auto">
          {!sel ? (
            <EmptyState title="没有可查看的版本" />
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="font-medium">
                    v{sel.number} · {sel.label}
                  </p>
                  {sel.note && <p className="text-xs text-ink-500">{sel.note}</p>}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={mode === 'diff' ? 'primary' : 'secondary'}
                    onClick={() => setMode('diff')}
                    disabled={!prev}
                  >
                    与上一版比较
                  </Button>
                  <Button
                    size="sm"
                    variant={mode === 'view' ? 'primary' : 'secondary'}
                    onClick={() => setMode('view')}
                  >
                    查看全文
                  </Button>
                  {canRestore && (
                    <Button
                      size="sm"
                      loading={busy}
                      onClick={async () => {
                        if (
                          !window.confirm(
                            `将合同恢复为 v${sel.number}？会生成一个新版本，历史记录不会丢失。`
                          )
                        )
                          return
                        if (
                          await act(
                            'restoreVersion',
                            [contract.id, sel.id],
                            `已恢复为 v${sel.number}`
                          )
                        )
                          onClose()
                      }}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      恢复此版本
                    </Button>
                  )}
                </div>
              </div>
              {mode === 'diff' && prev ? (
                <DiffView oldClauses={prev.clauses} newClauses={sel.clauses} />
              ) : (
                <div className="space-y-3">
                  {sel.clauses.map((c) => (
                    <div key={c.id} className="rounded-lg border border-slate-200 px-3 py-2.5">
                      <p className="mb-1 text-sm font-semibold">{c.title}</p>
                      <div
                        className="contract-body text-sm"
                        dangerouslySetInnerHTML={{ __html: sanitizeHtml(c.body) }}
                      />
                    </div>
                  ))}
                </div>
              )}
              {!prev && mode === 'diff' && (
                <p className="mt-2 text-xs text-ink-500">这是第一个版本，没有可比较的上一版。</p>
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  )
}
