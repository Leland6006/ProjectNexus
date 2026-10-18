import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Bot, CheckCheck, Clock, GitCompare, History, MessageSquare, Plus, RotateCcw, Save, Share2, Trash2 } from 'lucide-react'
import type { Clause, Comment, Contract, Suggestion, Visibility } from '@shared/types'
import { htmlToText } from '@shared/diff'
import { sanitizeHtml } from '@shared/sanitize'
import { AiPanel } from '@/components/AiPanel'
import { ClauseEditor } from '@/components/ClauseEditor'
import { DiffView } from '@/components/DiffView'
import { ContractStatusBadge, SuggestionStatusBadge, VisibilityBadge } from '@/components/badges'
import { Badge, Button, Dialog, EmptyState, Field, Input, Select, Textarea } from '@/components/ui'
import { cn, formatDateTime } from '@/lib/utils'
import { accessFor, orgOf, userLabel } from '@/lib/selectors'
import { useApp, useView } from '@/store'

type RightTab = 'comments' | 'suggestions' | 'activity' | 'ai'

function newClauseId(): string {
  return `cl_${crypto.randomUUID().slice(0, 10)}`
}

export default function ContractEditor({ contractId }: { contractId: string }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const navigate = useApp((x) => x.navigate)
  const toast = useApp((x) => x.toast)

  const contract = s.contracts.find((c) => c.id === contractId)
  const tx = contract && s.transactions.find((t) => t.id === contract.transactionId)

  const [draft, setDraft] = useState<Clause[]>(contract?.clauses ?? [])
  const [dirty, setDirty] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(contract?.clauses[0]?.id ?? null)
  const [tab, setTab] = useState<RightTab>('comments')
  const [showVersions, setShowVersions] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [suggestFor, setSuggestFor] = useState<string | null>(null)
  const serverClauses = useRef(contract?.clauses)

  // Adopt server changes (accept suggestion, restore, switch account) unless the user has unsaved edits.
  useEffect(() => {
    if (!contract) return
    if (contract.clauses !== serverClauses.current) {
      serverClauses.current = contract.clauses
      if (!dirty) setDraft(contract.clauses)
    }
  }, [contract, dirty])

  // Warn about leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent): void => e.preventDefault()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  if (!contract || !tx) {
    return (
      <div className="p-6">
        <EmptyState title="合同不存在或无权访问" action={<Button onClick={() => navigate({ page: 'contracts' })}>返回合同中心</Button>} />
      </div>
    )
  }

  const a = accessFor(s, tx)
  const locked = contract.status === 'finalized'
  const canEdit = a.isOwner && !locked
  const versions = s.versions.filter((v) => v.contractId === contract.id).sort((x, y) => y.number - x.number)
  const latest = versions[0]
  const active = draft.find((c) => c.id === activeId) ?? draft[0]
  const iConfirmed = a.orgId ? contract.finalConfirmedBy.includes(a.orgId) : false

  const updateClause = (id: string, patch: Partial<Clause>): void => {
    setDraft((d) => d.map((c) => (c.id === id ? { ...c, ...patch } : c)))
    setDirty(true)
  }

  const saveDraft = async (): Promise<boolean> => {
    const ok = await act('updateClauses', [contract.id, draft], '草稿已保存')
    if (ok) setDirty(false)
    return ok
  }

  const goBack = (): void => {
    if (dirty && !window.confirm('有未保存的修改，确定离开吗？')) return
    navigate({ page: 'transactions', transactionId: tx.id })
  }

  const isOtherParty = (orgId: string): boolean => orgId !== a.orgId

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-2.5">
        <div className="flex items-center gap-3">
          <button onClick={goBack} aria-label="返回交易项目" className="rounded p-1 text-ink-500 hover:bg-slate-100">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold">{contract.title}</h1>
              <ContractStatusBadge status={contract.status} />
              {dirty && <Badge tone="amber">未保存</Badge>}
              {a.isCounsel && <Badge tone="purple">外部律师视图</Badge>}
            </div>
            <p className="text-xs text-ink-500">
              {tx.name} · {latest ? `最新版本 v${latest.number}` : '无版本'} · 更新于 {formatDateTime(contract.updatedAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setShowVersions(true)}>
            <History className="h-3.5 w-3.5" />
            版本历史（{versions.length}）
          </Button>
          {a.isOwner && !contract.sharedWithCounterparty && (
            <Button
              loading={busy}
              onClick={() => {
                if (tx.counterpartyStatus === 'none') toast('error', '请先在交易页邀请交易对方')
                else void act('shareContract', [contract.id], `已共享给 ${orgOf(s, tx.counterpartyOrgId)?.shortName}`)
              }}
            >
              <Share2 className="h-3.5 w-3.5" />
              共享给对方
            </Button>
          )}
          {canEdit && (
            <>
              <Button onClick={() => void saveDraft()} loading={busy} disabled={!dirty}>
                <Save className="h-3.5 w-3.5" />
                保存草稿
              </Button>
              <Button variant="primary" onClick={() => setSaveOpen(true)}>
                <Clock className="h-3.5 w-3.5" />
                保存为新版本
              </Button>
            </>
          )}
          {a.isParty && contract.sharedWithCounterparty && !locked && latest && (
            <Button
              variant={iConfirmed ? 'secondary' : 'primary'}
              disabled={iConfirmed || dirty}
              loading={busy}
              title={dirty ? '请先保存新版本再确认' : undefined}
              onClick={() => void act('confirmFinal', [contract.id, latest.id], '已确认该版本')}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              {iConfirmed ? '已确认，等待对方' : `确认 v${latest.number} 为最终版`}
            </Button>
          )}
        </div>
      </div>

      {locked && <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-2 text-xs text-emerald-800">双方已确认最终版本，合同内容已锁定，不能再修改。</div>}
      {!canEdit && !locked && (
        <div className="border-b border-blue-200 bg-blue-50 px-5 py-2 text-xs text-blue-800">
          {a.isCounsel ? '你以外部律师身份查看，可添加意见，不能修改合同。' : '合同由发起方维护。你可以评论条款或提出修改建议，由对方接受后生效。'}
        </div>
      )}

      {/* Three columns */}
      <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)_360px]">
        {/* Left: outline */}
        <nav className="overflow-y-auto border-r border-slate-200 bg-slate-50/60 p-3" aria-label="条款目录">
          <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium text-ink-500">
            条款目录
            {canEdit && (
              <button
                onClick={() => {
                  const id = newClauseId()
                  setDraft((d) => [...d, { id, title: `第${d.length + 1}条 新条款`, body: '<p></p>' }])
                  setDirty(true)
                  setActiveId(id)
                }}
                className="rounded p-1 text-brand-600 hover:bg-brand-50"
                aria-label="添加条款"
                title="添加条款"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <ul className="space-y-0.5">
            {draft.map((c) => {
              const count = s.comments.filter((x) => x.clauseId === c.id && x.contractId === contract.id).length
              const pending = s.suggestions.filter((x) => x.clauseId === c.id && x.contractId === contract.id && x.status === 'pending').length
              return (
                <li key={c.id}>
                  <button onClick={() => setActiveId(c.id)} className={cn('flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm', c.id === active?.id ? 'bg-white font-medium text-brand-700 shadow-sm ring-1 ring-slate-200' : 'text-ink-700 hover:bg-slate-100')}>
                    <span className="truncate">{c.title}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {pending > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-xs text-amber-700">{pending}</span>}
                      {count > 0 && (
                        <span className="flex items-center gap-0.5 text-xs text-ink-400">
                          <MessageSquare className="h-3 w-3" />
                          {count}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        {/* Middle: body */}
        <section className="overflow-y-auto bg-white" aria-label="合同正文">
          <div className="mx-auto max-w-3xl px-8 py-6">
            {draft.map((c) => {
              const isActive = c.id === active?.id
              return (
                <article key={c.id} id={`clause-${c.id}`} onClick={() => setActiveId(c.id)} className={cn('group mb-4 rounded-lg border px-4 py-3 transition-colors', isActive ? 'border-brand-200 bg-brand-50/30' : 'border-transparent hover:border-slate-200')}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    {canEdit && isActive ? <Input value={c.title} onChange={(e) => updateClause(c.id, { title: e.target.value })} aria-label="条款标题" className="font-semibold" /> : <h2 className="font-semibold">{c.title}</h2>}
                    {canEdit && isActive && draft.length > 1 && (
                      <button
                        aria-label="删除条款"
                        title="删除条款"
                        onClick={() => {
                          if (!window.confirm(`确定删除「${c.title}」吗？（保存前可通过刷新恢复）`)) return
                          setDraft((d) => d.filter((x) => x.id !== c.id))
                          setDirty(true)
                          setActiveId(null)
                        }}
                        className="rounded p-1 text-ink-400 hover:bg-rose-50 hover:text-rose-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  {canEdit && isActive ? <ClauseEditor value={c.body} onChange={(html) => updateClause(c.id, { body: html })} /> : <div className="contract-body text-sm" dangerouslySetInnerHTML={{ __html: sanitizeHtml(c.body) }} />}
                </article>
              )
            })}
          </div>
        </section>

        {/* Right: collaboration */}
        <aside className="flex min-h-0 flex-col border-l border-slate-200 bg-slate-50/60" aria-label="评论与协商">
          <div className="flex border-b border-slate-200 bg-white text-sm">
            {(
              [
                ['comments', '评论', MessageSquare],
                ['suggestions', '修改建议', GitCompare],
                ['activity', '协商记录', History],
                ['ai', 'AI助手', Bot]
              ] as const
            ).map(([k, label, Icon]) => (
              <button key={k} onClick={() => setTab(k)} className={cn('flex flex-1 items-center justify-center gap-1 border-b-2 px-1 py-2.5 text-xs', tab === k ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-900')}>
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'comments' && active && <CommentsTab contract={contract} clauseId={active.id} clauseTitle={active.title} canShare={contract.sharedWithCounterparty} isCounsel={a.isCounsel} />}
            {tab === 'suggestions' && (
              <SuggestionsTab
                contract={contract}
                activeClauseId={active?.id ?? null}
                canPropose={a.isParty && contract.sharedWithCounterparty && !locked}
                canResolve={a.isParty && !locked}
                isOther={isOtherParty}
                onPropose={() => active && setSuggestFor(active.id)}
                dirty={dirty}
              />
            )}
            {tab === 'activity' && <ActivityTab contract={contract} />}
            {tab === 'ai' && <AiPanel contract={contract} />}
          </div>
        </aside>
      </div>

      {saveOpen && (
        <SaveVersionDialog
          onClose={() => setSaveOpen(false)}
          onSave={async (label, note) => {
            if (dirty && !(await saveDraft())) return false
            const ok = await act('saveVersion', [contract.id, label, note], '新版本已保存')
            if (ok) setSaveOpen(false)
            return ok
          }}
        />
      )}
      {suggestFor && (
        <SuggestDialog
          clause={contract.clauses.find((c) => c.id === suggestFor)!}
          onClose={() => setSuggestFor(null)}
          onSubmit={async (html, reason) => {
            const ok = await act('createSuggestion', [contract.id, suggestFor, html, reason], '修改建议已提交')
            if (ok) setSuggestFor(null)
          }}
        />
      )}
      {showVersions && <VersionsDialog contract={contract} canRestore={canEdit} onClose={() => setShowVersions(false)} />}
    </div>
  )
}

// ---------- Right panel tabs ----------

function CommentsTab({ contract, clauseId, clauseTitle, canShare, isCounsel }: { contract: Contract; clauseId: string; clauseTitle: string; canShare: boolean; isCounsel: boolean }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const [body, setBody] = useState('')
  const [vis, setVis] = useState<Visibility>(isCounsel ? 'counsel' : canShare ? 'shared' : 'internal')
  const [replyTo, setReplyTo] = useState<Comment | null>(null)

  const all = s.comments.filter((c) => c.contractId === contract.id && c.clauseId === clauseId).sort((x, y) => x.createdAt.localeCompare(y.createdAt))
  const roots = all.filter((c) => !c.parentId)

  const submit = async (): Promise<void> => {
    if (!body.trim()) return
    const effective = replyTo && replyTo.visibility !== 'shared' && vis === 'shared' ? replyTo.visibility : vis
    if (await act('addComment', [contract.id, clauseId, body, effective, replyTo?.id ?? null], replyTo ? '回复已发送' : '评论已发布')) {
      setBody('')
      setReplyTo(null)
    }
  }

  const renderComment = (c: Comment, nested = false) => (
    <div key={c.id} className={cn('rounded-lg border bg-white p-2.5', nested ? 'ml-5 mt-1.5 border-slate-100' : 'border-slate-200')}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium text-ink-900">{userLabel(s, c.authorId)}</span>
        <VisibilityBadge visibility={c.visibility} />
      </div>
      <p className="whitespace-pre-wrap text-sm text-ink-700">{c.body}</p>
      <div className="mt-1 flex items-center justify-between text-xs text-ink-400">
        <span>{formatDateTime(c.createdAt)}</span>
        {!nested && (
          <button
            className="text-brand-600 hover:underline"
            onClick={() => {
              setReplyTo(c)
              setVis(c.visibility)
            }}
          >
            回复
          </button>
        )}
      </div>
    </div>
  )

  const replyAudience = replyTo?.visibility
  const options: [Visibility, string][] = isCounsel
    ? [['counsel', '仅委托企业及其律师']]
    : [
        ...(canShare && (!replyAudience || replyAudience === 'shared') ? ([['shared', '双方可见']] as [Visibility, string][]) : []),
        ['internal', '仅本企业（对方与律师不可见）'],
        ['counsel', '本企业及其外部律师']
      ]

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-3 py-2 text-xs text-ink-500">
        当前条款：<span className="font-medium text-ink-900">{clauseTitle}</span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {roots.length === 0 && <EmptyState title="这条款还没有评论" hint="在下方发表第一条意见" />}
        {roots.map((c) => (
          <div key={c.id}>
            {renderComment(c)}
            {all.filter((r) => r.parentId === c.id).map((r) => renderComment(r, true))}
          </div>
        ))}
      </div>
      <div className="border-t border-slate-200 bg-white p-3">
        {replyTo && (
          <div className="mb-2 flex items-center justify-between rounded bg-slate-100 px-2 py-1 text-xs text-ink-700">
            <span className="truncate">回复 {userLabel(s, replyTo.authorId)}</span>
            <button className="text-ink-500 hover:text-ink-900" onClick={() => setReplyTo(null)}>
              取消
            </button>
          </div>
        )}
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="输入评论…" rows={3} aria-label="评论内容" />
        <div className="mt-2 flex items-center gap-2">
          <Select value={options.some(([v]) => v === vis) ? vis : options[0][0]} onChange={(e) => setVis(e.target.value as Visibility)} aria-label="评论可见范围" className="flex-1">
            {options.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </Select>
          <Button variant="primary" loading={busy} disabled={!body.trim()} onClick={() => void submit()}>
            {replyTo ? '回复' : '发表'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function SuggestionsTab({ contract, activeClauseId, canPropose, canResolve, isOther, onPropose, dirty }: { contract: Contract; activeClauseId: string | null; canPropose: boolean; canResolve: boolean; isOther: (orgId: string) => boolean; onPropose: () => void; dirty: boolean }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const list = s.suggestions.filter((x) => x.contractId === contract.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt))

  const card = (sg: Suggestion) => {
    const clause = contract.clauses.find((c) => c.id === sg.clauseId)
    return (
      <div key={sg.id} className={cn('rounded-lg border bg-white p-3', sg.clauseId === activeClauseId ? 'border-brand-200' : 'border-slate-200')}>
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
            <Button size="sm" variant="primary" loading={busy} disabled={dirty} title={dirty ? '请先保存草稿' : undefined} onClick={() => void act('resolveSuggestion', [sg.id, true], '已接受修改建议')}>
              接受
            </Button>
            <Button size="sm" loading={busy} onClick={() => void act('resolveSuggestion', [sg.id, false], '已拒绝修改建议')}>
              拒绝
            </Button>
          </div>
        )}
        {sg.status === 'pending' && !isOther(sg.orgId) && <p className="text-xs text-ink-500">等待对方处理</p>}
        {sg.resolvedAt && <p className="text-xs text-ink-400">处理于 {formatDateTime(sg.resolvedAt)}，{userLabel(s, sg.resolvedBy!)}</p>}
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
      {list.length === 0 ? <EmptyState title="暂无修改建议" hint="交易双方可对共享合同的条款提出修改，由对方接受或拒绝" /> : list.map(card)}
    </div>
  )
}

function ActivityTab({ contract }: { contract: Contract }) {
  const s = useView()
  const list = s.activities.filter((x) => x.contractId === contract.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt))
  if (list.length === 0) return <EmptyState title="暂无协商记录" />
  return (
    <ol className="relative ml-5 mt-3 space-y-4 border-l border-slate-200 pb-4 pr-3">
      {list.map((x) => (
        <li key={x.id} className="relative pl-4">
          <span className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand-500" />
          <p className="text-sm text-ink-700">{x.summary}</p>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-400">
            {formatDateTime(x.createdAt)}
            <VisibilityBadge visibility={x.visibility} />
          </div>
        </li>
      ))}
    </ol>
  )
}

// ---------- Dialogs ----------

function SaveVersionDialog({ onClose, onSave }: { onClose: () => void; onSave: (label: string, note: string) => Promise<boolean> }) {
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
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="本次修改了什么" />
        </Field>
        <p className="text-xs text-ink-500">保存新版本会清除已有的“确认最终版”标记，双方需重新确认。</p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} disabled={!label.trim()} onClick={() => void onSave(label, note)}>
            保存版本
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function SuggestDialog({ clause, onClose, onSubmit }: { clause: Clause; onClose: () => void; onSubmit: (html: string, reason: string) => Promise<void> }) {
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
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="向对方说明为什么需要这样修改" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} disabled={unchanged || !reason.trim()} onClick={() => void onSubmit(html, reason)}>
            提交建议
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function VersionsDialog({ contract, canRestore, onClose }: { contract: Contract; canRestore: boolean; onClose: () => void }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const versions = useMemo(() => s.versions.filter((v) => v.contractId === contract.id).sort((x, y) => y.number - x.number), [s.versions, contract.id])
  const [selId, setSelId] = useState<string | null>(versions[0]?.id ?? null)
  const [mode, setMode] = useState<'diff' | 'view'>('diff')
  const sel = versions.find((v) => v.id === selId)
  const prev = sel ? versions.find((v) => v.number === sel.number - 1) : undefined

  return (
    <Dialog open onClose={onClose} title="版本历史与比较" width="max-w-5xl">
      <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-4">
        <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
          {versions.map((v) => (
            <li key={v.id}>
              <button onClick={() => setSelId(v.id)} className={cn('w-full rounded-md border px-2.5 py-2 text-left', v.id === selId ? 'border-brand-200 bg-brand-50' : 'border-slate-200 hover:bg-slate-50')}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">v{v.number} · {v.label}</span>
                  {contract.finalVersionId === v.id && contract.status === 'finalized' && <Badge tone="green">最终版</Badge>}
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
                  <p className="font-medium">v{sel.number} · {sel.label}</p>
                  {sel.note && <p className="text-xs text-ink-500">{sel.note}</p>}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant={mode === 'diff' ? 'primary' : 'secondary'} onClick={() => setMode('diff')} disabled={!prev}>
                    与上一版比较
                  </Button>
                  <Button size="sm" variant={mode === 'view' ? 'primary' : 'secondary'} onClick={() => setMode('view')}>
                    查看全文
                  </Button>
                  {canRestore && (
                    <Button
                      size="sm"
                      loading={busy}
                      onClick={async () => {
                        if (!window.confirm(`将合同恢复为 v${sel.number}？会生成一个新版本，历史记录不会丢失。`)) return
                        if (await act('restoreVersion', [contract.id, sel.id], `已恢复为 v${sel.number}`)) onClose()
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
                      <div className="contract-body text-sm" dangerouslySetInnerHTML={{ __html: sanitizeHtml(c.body) }} />
                    </div>
                  ))}
                </div>
              )}
              {!prev && mode === 'diff' && <p className="mt-2 text-xs text-ink-500">这是第一个版本，没有可比较的上一版。</p>}
            </>
          )}
        </div>
      </div>
    </Dialog>
  )
}
