import { internalReviewBlocker } from '@shared/terms'
import { InternalReviewPanel } from '@/components/contract/InternalReviewPanel'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Bot, CheckCheck, Clock, GitCompare, History, MessageSquare, Save, Share2 } from 'lucide-react'
import type { Clause } from '@shared/types'
import { canConfirmFinal, newClause, sortVersionsDesc } from '@shared/editorRules'
import { AiPanel } from '@/components/AiPanel'
import { ContractStatusBadge } from '@/components/badges'
import { ActivityPanel } from '@/components/contract/ActivityPanel'
import { ClauseBody } from '@/components/contract/ClauseBody'
import { ClauseOutline } from '@/components/contract/ClauseOutline'
import { CommentsPanel } from '@/components/contract/CommentsPanel'
import { SaveVersionDialog, SuggestDialog, VersionsDialog } from '@/components/contract/editorDialogs'
import { SuggestionsPanel } from '@/components/contract/SuggestionsPanel'
import { Badge, Button, EmptyState } from '@/components/ui'
import { cn, formatDateTime } from '@/lib/utils'
import { accessFor, orgOf } from '@/lib/selectors'
import { projectRoute } from '@/routes'
import { useApp, useView } from '@/store'

type RightTab = 'comments' | 'suggestions' | 'activity' | 'ai' | 'review'

const TABS = [
  ['comments', '评论', MessageSquare],
  ['suggestions', '修改建议', GitCompare],
  ['activity', '协商记录', History],
  ['ai', 'AI助手', Bot],
  ['review', '内部审阅', CheckCheck]
] as const

function clauseId(): string {
  return `cl_${crypto.randomUUID().slice(0, 10)}`
}

/**
 * Three-column contract editor. State lives here; each column and each dialog is a
 * separate component so this file stays about wiring, not markup.
 */
export default function ContractEditor({ contractId }: { contractId: string }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const navigate = useApp((x) => x.navigate)
  const toast = useApp((x) => x.toast)
  const setLeaveGuard = useApp((x) => x.setLeaveGuard)

  const contract = s.contracts.find((c) => c.id === contractId)
  const tx = contract && s.transactions.find((t) => t.id === contract.transactionId)

  const [draft, setDraft] = useState<Clause[]>(contract?.clauses ?? [])
  const [dirty, setDirty] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(contract?.clauses[0]?.id ?? null)
  const [tab, setTab] = useState<RightTab>(s.internalReviews.some((r) => r.contractId === contractId && r.reviewerId === s.currentUserId && r.status === 'pending') ? 'review' : 'comments')
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

  // In-app navigation away from unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return
    setLeaveGuard(() => window.confirm('有未保存的修改，确定离开吗？'))
    return () => setLeaveGuard(null)
  }, [dirty, setLeaveGuard])

  if (!contract || !tx) {
    return (
      <div className="p-6">
        <EmptyState title="合同不存在或无权访问" action={<Button onClick={() => navigate({ module: 'business', view: 'contracts' })}>返回全部合同</Button>} />
      </div>
    )
  }

  const a = accessFor(s, tx)
  const reviewBlock = internalReviewBlocker(contract, s.versions, s.internalReviews, a.orgId ?? '')
  const locked = contract.status === 'finalized'
  const canEdit = a.isOwner && !locked
  const versions = sortVersionsDesc(s.versions.filter((v) => v.contractId === contract.id))
  const latest = versions[0]
  const active = draft.find((c) => c.id === activeId) ?? draft[0]
  const iConfirmed = a.orgId ? contract.finalConfirmedBy.includes(a.orgId) : false
  const isOtherParty = (orgId: string): boolean => orgId !== a.orgId

  const updateClause = (id: string, patch: Partial<Clause>): void => {
    setDraft((d) => d.map((c) => (c.id === id ? { ...c, ...patch } : c)))
    setDirty(true)
  }

  const saveDraft = async (): Promise<boolean> => {
    const ok = await act('updateClauses', [contract.id, draft], '草稿已保存')
    if (ok) setDirty(false)
    return ok
  }

  // Unsaved edits are guarded centrally (see the leave guard above), so every way out of
  // the editor — this button, the sidebar, module switches, account switches — asks once.
  const goBack = (): void => navigate(projectRoute(tx.id))

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-2.5">
        <div className="flex items-center gap-3">
          <button onClick={goBack} aria-label="返回业务项目" className="rounded p-1 text-ink-500 hover:bg-slate-100">
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
          {a.isOwner && !contract.sharedWithCounterparty && !orgOf(s, tx.counterpartyOrgId)?.localOnly && (
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
              disabled={!!reviewBlock || !canConfirmFinal({ isParty: a.isParty, shared: contract.sharedWithCounterparty, locked, hasLatest: true, alreadyConfirmed: iConfirmed, dirty })}
              loading={busy}
              title={dirty ? '请先保存新版本再确认' : reviewBlock ?? undefined}
              onClick={() => void act('confirmFinal', [contract.id, latest.id], '已确认该版本')}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              {iConfirmed ? '已确认，等待对方' : `确认 v${latest.number} 为最终版`}
            </Button>
          )}
        </div>
      </div>

      {reviewBlock && <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800">{reviewBlock} · 请在右侧「内部审阅」处理</div>}
      {locked && <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-2 text-xs text-emerald-800">双方已确认最终版本，合同内容已锁定，不能再修改。</div>}
      {!canEdit && !locked && (
        <div className="border-b border-blue-200 bg-blue-50 px-5 py-2 text-xs text-blue-800">
          {a.isCounsel ? '你以外部律师身份查看，可添加意见，不能修改合同。' : '合同由发起方维护。你可以评论条款或提出修改建议，由对方接受后生效。'}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[208px_minmax(0,1fr)_320px] xl:grid-cols-[240px_minmax(0,1fr)_360px]">
        <ClauseOutline
          contractId={contract.id}
          clauses={draft}
          activeId={active?.id}
          canEdit={canEdit}
          onSelect={setActiveId}
          onAdd={() => {
            const clause = newClause(draft, clauseId)
            setDraft((d) => [...d, clause])
            setDirty(true)
            setActiveId(clause.id)
          }}
        />

        <ClauseBody
          clauses={draft}
          activeId={active?.id}
          canEdit={canEdit}
          onSelect={setActiveId}
          onChange={updateClause}
          onDelete={(c) => {
            if (!window.confirm(`确定删除「${c.title}」吗？（保存前可通过刷新恢复）`)) return
            setDraft((d) => d.filter((x) => x.id !== c.id))
            setDirty(true)
            setActiveId(null)
          }}
        />

        <aside className="flex min-h-0 flex-col border-l border-slate-200 bg-slate-50/60" aria-label="评论与协商">
          <div className="flex border-b border-slate-200 bg-white text-sm">
            {TABS.map(([k, label, Icon]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1 border-b-2 px-1 py-2.5 text-xs',
                  tab === k ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-900'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'comments' && active && (
              <CommentsPanel contract={contract} clauseId={active.id} clauseTitle={active.title} canShare={contract.sharedWithCounterparty} isCounsel={a.isCounsel} />
            )}
            {tab === 'suggestions' && (
              <SuggestionsPanel
                contract={contract}
                activeClauseId={active?.id ?? null}
                canPropose={a.isParty && contract.sharedWithCounterparty && !locked}
                canResolve={a.isParty && !locked}
                isOther={isOtherParty}
                onPropose={() => active && setSuggestFor(active.id)}
                dirty={dirty}
              />
            )}
            {tab === 'activity' && <ActivityPanel contract={contract} />}
            {tab === 'review' && <InternalReviewPanel contract={contract} dirty={dirty} />}
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
