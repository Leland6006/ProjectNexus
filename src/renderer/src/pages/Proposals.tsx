import { useMemo, useState } from 'react'
import { AlertTriangle, Check, Play, ShieldCheck, Sparkles, X } from 'lucide-react'
import {
  AGENT_LABEL,
  ACTION_KIND_LABEL,
  CLAIM_STATUS_LABEL,
  CLAIM_STATUS_TONE,
  PROPOSAL_STATUS_LABEL,
  PROPOSAL_STATUS_TONE,
  claimAuthorLabel,
  claimValue,
  claimsForProposal,
  isStaleProposal,
  sortForReview
} from '@shared/proposalView'
import { canPromote } from '@shared/context'
import type { Claim } from '@shared/types'
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Select } from '@/components/ui'
import { cn, formatDateTime } from '@/lib/utils'
import { runAgentAnalysis } from '@/lib/agents'
import { accessFor, orgOf } from '@/lib/selectors'
import { useApp, useView } from '@/store'

// NOTE: tests/contextReview.test.ts executes this page with stubbed modules. Keep its
// imports to the modules stubbed there (or real packages) so the test keeps running.

export function ClaimRow({ claim, dense }: { claim: Claim; dense?: boolean }) {
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const canConfirm = canPromote(claim)
  return (
    <li className={cn('flex items-start gap-2 rounded-md border border-slate-100 px-2.5', dense ? 'py-1.5' : 'py-2')}>
      <Badge tone={CLAIM_STATUS_TONE[claim.status]}>{CLAIM_STATUS_LABEL[claim.status]}</Badge>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink-900">
          <span className="font-medium">{claim.label}</span>：{claimValue(claim)}
        </p>
        <p className="mt-0.5 text-xs text-ink-400">
          {claimAuthorLabel(claim)}
          {claim.source.detail && ` · ${claim.source.detail}`} · 更新于 {formatDateTime(claim.asOf)}
          {claim.supersededById && ' · 已被更新的结果取代'}
        </p>
      </div>
      {canConfirm && (
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void act('confirmClaim', [claim.id], '已确认为企业事实')} title="只有人工确认后，推断才会成为事实">
          <ShieldCheck className="h-3.5 w-3.5" />
          确认
        </Button>
      )}
    </li>
  )
}

function ProposalCard({ id }: { id: string }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const navigate = useApp((x) => x.navigate)
  const p = s.proposals.find((x) => x.id === id)!
  const tx = s.transactions.find((t) => t.id === p.transactionId)
  const stale = isStaleProposal(s.versions, p)
  const { found, missing } = claimsForProposal(s.claims, p)
  const author = p.createdBy.startsWith('agent:') ? AGENT_LABEL[p.createdBy.slice(6) as keyof typeof AGENT_LABEL] ?? 'Nexus Agent' : '人工起草'

  const decide = async (approve: boolean): Promise<void> => {
    if (approve && await act('approveProposal', [p.id], '已采纳方案并创建执行任务；预测保持原状态。')) navigate({ module: 'actions', view: 'executing' })
    else await act('rejectProposal', [p.id], '已忽略该建议')
  }

  return (
    <Card className={cn(stale && 'border-amber-300 ring-1 ring-amber-100')}>
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={PROPOSAL_STATUS_TONE[p.status]}>{PROPOSAL_STATUS_LABEL[p.status]}</Badge>
            <span className="text-sm font-semibold text-ink-900">{p.title}</span>
          </div>
          <p className="mt-1 text-xs text-ink-500">
            {tx ? tx.name : '业务项目'} · {author} · {formatDateTime(p.createdAt)}
          </p>
        </div>
        {tx && (
          <Button size="sm" onClick={() => navigate({ module: 'business', view: 'project', transactionId: tx.id, tab: 'overview' })}>
            查看业务
          </Button>
        )}
      </div>

      <div className="space-y-3 px-4 py-3">
        {stale && (
          <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            合同或基础资料已更新，建议已失效。请重新运行分析，再决定是否采纳。
          </div>
        )}

        {missing.length > 0 && (
          <div role="alert" className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {missing.length} 条依据缺失或当前无权查看，暂时无法采纳。请重新运行分析或联系有权查看完整依据的人员处理。
          </div>
        )}

        {p.rationale && <div className="whitespace-pre-line text-sm leading-relaxed text-ink-700">{p.rationale}</div>}

        {p.analysisRunId && <details className="rounded border border-slate-100 p-3"><summary className="cursor-pointer text-sm text-brand-700">查看本方案的专业协同过程</summary>{s.analysisRuns.find((r) => r.id === p.analysisRunId)?.steps.map((step) => <div key={step.agentId} className="mt-3"><p className="text-sm font-medium">{AGENT_LABEL[step.agentId]} · {step.status === 'skipped' ? '未配置模型，已跳过' : step.status === 'completed' ? '完成' : step.status}</p>{step.findings.map((f, n) => <p key={n} className="whitespace-pre-wrap text-sm text-ink-600">{f}</p>)}</div>)}</details>}
        {p.actions.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-500">建议动作</p>
            <ol className="space-y-1.5">
              {p.actions.map((a, i) => (
                <li key={i} className="flex items-start gap-2 rounded-md bg-slate-50 px-2.5 py-2">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[10px] font-semibold text-brand-700">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-ink-900">{a.title}</span>
                      <Badge>{ACTION_KIND_LABEL[a.kind]}</Badge>
                    </div>
                    {a.detail !== a.title && <p className="mt-0.5 text-xs text-ink-500">{a.detail}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        {found.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-500">依据（事实、推断与建议分开保存，需逐条确认）</p>
            <ul className="space-y-1.5">
              {found.map((c) => (
                <ClaimRow key={c.id} claim={c} />
              ))}
            </ul>
          </div>
        )}
      </div>

      {p.status === 'pending' && (
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-2.5">
          <span className="mr-auto text-xs text-ink-400">采纳后创建执行任务，具备条款草稿时另建修改建议；依据中的推断不会变成事实</span>
          <Button size="sm" loading={busy} onClick={() => void decide(false)}>
            <X className="h-3.5 w-3.5" />
            忽略
          </Button>
          <Button size="sm" variant="primary" loading={busy} disabled={stale || missing.length > 0} onClick={() => void decide(true)}>
            <Check className="h-3.5 w-3.5" />
            采纳
          </Button>
        </div>
      )}
    </Card>
  )
}

function RunPanel() {
  const s = useView()
  const busy = useApp((x) => x.busy)
  const runnable = s.transactions.filter((t) => accessFor(s, t).isParty)
  const [txId, setTxId] = useState(runnable[0]?.id ?? '')

  const run = async (): Promise<void> => {
    if (txId) await runAgentAnalysis(txId)
  }

  if (runnable.length === 0) return null
  return (
    <Card>
      <CardHeader title="运行一次协同分析" subtitle="用最新合同条款重新分析一笔业务" />
      <div className="space-y-2 px-4 py-3">
        <Select value={txId} onChange={(e) => setTxId(e.target.value)} aria-label="选择业务项目">
          {runnable.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}（{orgOf(s, accessFor(s, t).orgId === t.initiatorOrgId ? t.counterpartyOrgId : t.initiatorOrgId)?.shortName}）
            </option>
          ))}
        </Select>
        <Button variant="primary" loading={busy} disabled={!txId} onClick={() => void run()} className="w-full">
          <Play className="h-3.5 w-3.5" />
          运行协同分析
        </Button>
        <p className="text-xs text-ink-500">未连接模型时只执行确定性的财务测算，法务与经营视角会标为跳过。每笔业务只保留一条待确认建议。</p>
      </div>
    </Card>
  )
}

export default function Proposals({ mode = 'pending' }: { mode?: 'pending' | 'decided' }) {
  const s = useView()
  const sorted = useMemo(() => sortForReview(s.proposals), [s.proposals])
  const list = sorted.filter((p) => (mode === 'pending' ? p.status === 'pending' : p.status !== 'pending'))

  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader
        title={mode === 'pending' ? '待我决策' : '已处理'}
        subtitle={mode === 'pending' ? '需要你判断的方案。每条都列出依据，采纳前可以逐条核对。' : '已采纳或已忽略的方案，保留依据以便追溯。'}
        actions={
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-ink-500">
            <Sparkles className="h-3.5 w-3.5" />
            仅供参考，需人工确认
          </span>
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {list.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Sparkles className="h-8 w-8" />}
                title={mode === 'pending' ? '暂时没有待决策的方案' : '还没有处理过的方案'}
                hint="付款条款等商业条件发生变化时，会生成一条带依据的待确认方案。"
              />
            </Card>
          ) : (
            list.map((p) => <ProposalCard key={p.id} id={p.id} />)
          )}
        </div>
        {mode === 'pending' && (
          <div className="space-y-4">
            <RunPanel />
          </div>
        )}
      </div>
    </div>
  )
}
