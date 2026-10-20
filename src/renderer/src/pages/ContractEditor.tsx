import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Bot, CheckCheck, Clock, GitCompare, History, MessageSquare, Save, Share2 } from 'lucide-react'
import type { Clause } from '@shared/types'
import { canConfirmFinal, newClause, sortVersionsDesc } from '@shared/editorRules'
import { sanitizeHtml } from '@shared/sanitize'
import { AiPanel } from '@/components/AiPanel'
import { ContractStatusBadge } from '@/components/badges'
import { ActivityPanel } from '@/components/contract/ActivityPanel'
import { ClauseBody } from '@/components/contract/ClauseBody'
import { ClauseOutline } from '@/components/contract/ClauseOutline'
import { CommentsPanel } from '@/components/contract/CommentsPanel'
import { SaveVersionDialog, SuggestDialog, VersionsDialog } from '@/components/contract/editorDialogs'
import { SuggestionsPanel } from '@/components/contract/SuggestionsPanel'
import { Badge, Button, Dialog, EmptyState, Textarea } from '@/components/ui'
import { cn, formatDateTime } from '@/lib/utils'
import { accessFor, orgOf } from '@/lib/selectors'
import { useApp, useView } from '@/store'

type RightTab = 'comments' | 'suggestions' | 'activity' | 'ai'

const TABS = [
  ['comments', '评论', MessageSquare],
  ['suggestions', '修改建议', GitCompare],
  ['activity', '协商记录', History],
  ['ai', 'AI助手', Bot]
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
  const identity = useApp((x) => x.identityStatus)
  const user = s.users.find((u) => u.id === s.currentUserId)
  const contextKey = JSON.stringify([contractId, s.currentUserId, user?.orgId, s.representingOrgId, identity?.account?.id, identity?.actingOrgId])
  return <ContractEditorSession key={contextKey} contractId={contractId} />
}

function clausesToken(clauses: Clause[]): string {
  return JSON.stringify(clauses.map(({ id, title, body }) => [id, title, body]))
}

function ContractEditorSession({ contractId }: { contractId: string }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const navigate = useApp((x) => x.navigate)
  const toast = useApp((x) => x.toast)

  const contract = s.contracts.find((c) => c.id === contractId)
  const tx = contract && s.transactions.find((t) => t.id === contract.transactionId)

  const [draft, setDraft] = useState<Clause[]>(() => structuredClone(contract?.clauses ?? []))
  const [dirty, setDirty] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(contract?.clauses[0]?.id ?? null)
  const [tab, setTab] = useState<RightTab>('comments')
  const [showVersions, setShowVersions] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [suggestFor, setSuggestFor] = useState<string | null>(null)
  const [baseClauses, setBaseClauses] = useState<Clause[]>(() => structuredClone(contract?.clauses ?? []))
  const [saveFailed, setSaveFailed] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  const editRevision = useRef(0)
  const saving = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // 未保存时保留开始编辑的快照，轮询结果只能更新远端视图。
  useEffect(() => {
    if (!contract || dirty || saving.current) return
    setDraft(structuredClone(contract.clauses))
    setBaseClauses(structuredClone(contract.clauses))
    setSaveFailed(false)
  }, [contract?.clauses, dirty])

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
  const versions = sortVersionsDesc(s.versions.filter((v) => v.contractId === contract.id))
  const latest = versions[0]
  const active = draft.find((c) => c.id === activeId) ?? draft[0]
  const iConfirmed = a.orgId ? contract.finalConfirmedBy.includes(a.orgId) : false
  const isOtherParty = (orgId: string): boolean => orgId !== a.orgId

  const remoteChanged = dirty && clausesToken(contract.clauses) !== clausesToken(baseClauses)

  const markEdited = (): void => {
    ++editRevision.current
    setDirty(true)
  }

  const updateClause = (id: string, patch: Partial<Clause>): void => {
    markEdited()
    setDraft((d) => d.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }

  const saveDraft = async (): Promise<boolean> => {
    if (saving.current) return false
    const revision = editRevision.current
    const submitted = structuredClone(draft)
    saving.current = true
    const ok = await act('updateClauses', [contract.id, submitted, structuredClone(baseClauses)], '草稿已保存')
    saving.current = false
    if (!mounted.current) return false
    if (!ok) {
      setSaveFailed(true)
      await act('getState', [])
      return false
    }
    const saved = submitted.map(({ id, title, body }) => ({ id: id.trim(), title: title.trim(), body: sanitizeHtml(body).slice(0, 100_000) }))
    setBaseClauses(saved)
    setSaveFailed(false)
    if (editRevision.current !== revision) {
      toast('info', '已保存提交时的内容，保存期间的新修改仍保留在本地，请再次保存。')
      return false
    }
    setDraft(saved)
    setDirty(false)
    return true
  }

  const reloadRemote = async (): Promise<void> => {
    if (saving.current || (dirty && !window.confirm('重新载入会放弃本地未保存内容。建议先复制本地内容，确定继续吗？'))) return
    const revision = editRevision.current
    if (!(await act('getState', [])) || !mounted.current) return
    if (revision !== editRevision.current) {
      toast('info', '载入期间又有本地修改，已保留；请复制内容后重新载入。')
      return
    }
    const latestContract = useApp.getState().state?.contracts.find((c) => c.id === contract.id)
    if (!latestContract) return
    const clauses = structuredClone(latestContract.clauses)
    setDraft(clauses)
    setBaseClauses(structuredClone(clauses))
    setActiveId(clauses[0]?.id ?? null)
    setDirty(false)
    setSaveFailed(false)
    setCopyOpen(false)
    ++editRevision.current
  }

  const goBack = (): void => {
    if (dirty && !window.confirm('有未保存的修改，确定离开吗？')) return
    navigate({ page: 'transactions', transactionId: tx.id })
  }

  return (
    <div className="flex h-full flex-col">
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
              disabled={!canConfirmFinal({ isParty: a.isParty, shared: contract.sharedWithCounterparty, locked, hasLatest: true, alreadyConfirmed: iConfirmed, dirty })}
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

      {dirty && (
        <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-900" role="status">
          <span>{remoteChanged ? '远端合同条款已修改。已保留本地草稿；请复制本地内容，再重新载入最新条款后编辑。' : saveFailed ? '保存未完成，本地草稿已保留。若远端已修改，请复制内容后重新载入。' : '本地修改尚未保存，可先复制留存。'}</span>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" onClick={() => setCopyOpen(true)}>复制本地内容</Button>
            <Button size="sm" loading={busy} onClick={() => void reloadRemote()}>重新载入最新条款</Button>
          </div>
        </div>
      )}
      {locked && <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-2 text-xs text-emerald-800">双方已确认最终版本，合同内容已锁定，不能再修改。</div>}
      {!canEdit && !locked && (
        <div className="border-b border-blue-200 bg-blue-50 px-5 py-2 text-xs text-blue-800">
          {a.isCounsel ? '你以外部律师身份查看，可添加意见，不能修改合同。' : '合同由发起方维护。你可以评论条款或提出修改建议，由对方接受后生效。'}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)_360px]">
        <ClauseOutline
          contractId={contract.id}
          clauses={draft}
          activeId={active?.id}
          canEdit={canEdit}
          onSelect={setActiveId}
          onAdd={() => {
            const clause = newClause(draft, clauseId)
            markEdited()
            setDraft((d) => [...d, clause])
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
            markEdited()
            setDraft((d) => d.filter((x) => x.id !== c.id))
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
            {tab === 'ai' && <AiPanel contract={contract} />}
          </div>
        </aside>
      </div>

      {copyOpen && (
        <Dialog open onClose={() => setCopyOpen(false)} title="复制本地未保存内容">
          <p className="mb-3 text-sm text-ink-600">点击下方内容并按 Ctrl+C（macOS 为 ⌘C）复制。包含条款标题与正文 HTML，可用于对照恢复本地修改。</p>
          <Textarea readOnly autoFocus aria-label="本地草稿内容" className="min-h-72" value={draft.map((c) => `${c.title}\n${c.body}`).join('\n\n')} onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()} />
        </Dialog>
      )}
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
