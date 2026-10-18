import { useMemo, useState } from 'react'
import { AlertTriangle, Check, Database, Play, ShieldCheck, Sparkles, X } from 'lucide-react'
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
  sortClaimsByStatus,
  sortForReview,
  unconfirmedClaims
} from '@shared/proposalView'
import type { Claim } from '@shared/types'
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Select } from '@/components/ui'
import { cn, formatDateTime } from '@/lib/utils'
import { runAgentAnalysis } from '@/lib/agents'
import { accessFor, orgOf } from '@/lib/selectors'
import { useApp, useView } from '@/store'

function ClaimRow({ claim, dense }: { claim: Claim; dense?: boolean }) {
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const canConfirm = claim.status !== 'confirmed'
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
          {claim.supersededById && ' · 已被更新的推断取代'}
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
  const { found } = claimsForProposal(s.claims, p)
  const author = p.createdBy.startsWith('agent:') ? AGENT_LABEL[p.createdBy.slice(6) as keyof typeof AGENT_LABEL] ?? 'Nexus Agent' : '人工起草'

  const decide = async (approve: boolean): Promise<void> => {
    const ok = approve
      ? await act('approveProposal', [p.id], '已采纳建议，相关推断已升级为已确认事实')
      : await act('rejectProposal', [p.id], '已忽略该建议')
    if (ok && approve) useApp.getState().toast('info', '建议已采纳，依据信息已写入企业记忆')
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
            {tx ? tx.name : '交易项目'} · {author} · {formatDateTime(p.createdAt)}
          </p>
        </div>
        {tx && (
          <Button size="sm" onClick={() => navigate({ page: 'transactions', transactionId: tx.id })}>
            查看交易
          </Button>
        )}
      </div>

      <div className="space-y-3 px-4 py-3">
        {stale && (
          <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            合同已在建议生成之后被修改，建议已失效。请重新运行分析，再决定是否采纳。
          </div>
        )}

        {p.rationale && <div className="whitespace-pre-line text-sm leading-relaxed text-ink-700">{p.rationale}</div>}

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
            <p className="mb-1.5 text-xs font-medium text-ink-500">依据（事实、推断与建议分开保存）</p>
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
          <span className="mr-auto text-xs text-ink-400">采纳后才会写入合同修改建议与企业记忆</span>
          <Button size="sm" loading={busy} onClick={() => void decide(false)}>
            <X className="h-3.5 w-3.5" />
            忽略
          </Button>
          <Button size="sm" variant="primary" loading={busy} disabled={stale} onClick={() => void decide(true)}>
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
      <CardHeader title="触发一次协同分析" subtitle="用最新合同条款重新跑一遍 Agent 协作" />
      <div className="space-y-2 px-4 py-3">
        <Select value={txId} onChange={(e) => setTxId(e.target.value)} aria-label="选择交易项目">
          {runnable.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}（{orgOf(s, accessFor(s, t).orgId === t.initiatorOrgId ? t.counterpartyOrgId : t.initiatorOrgId)?.shortName}）
            </option>
          ))}
        </Select>
        <Button variant="primary" loading={busy} disabled={!txId} onClick={() => void run()} className="w-full">
          <Play className="h-3.5 w-3.5" />
          运行 AI 团队分析
        </Button>
        <p className="text-xs text-ink-500">每笔交易只保留一条待确认建议；重复运行会用最新条款刷新它，不会堆积。</p>
      </div>
    </Card>
  )
}

function MemoryPanel() {
  const s = useView()
  const claims = useMemo(() => sortClaimsByStatus(s.claims), [s.claims])
  const queue = unconfirmedClaims(s.claims)
  if (claims.length === 0) return null
  return (
    <Card>
      <CardHeader
        title="企业记忆"
        subtitle={`${claims.length} 条 · ${queue.length} 条待人工确认`}
        action={<Database className="h-4 w-4 text-ink-400" />}
      />
      <ul className="max-h-[28rem] space-y-1.5 overflow-y-auto px-4 py-3">
        {claims.slice(0, 20).map((c) => (
          <ClaimRow key={c.id} claim={c} dense />
        ))}
      </ul>
    </Card>
  )
}

export default function Proposals() {
  const s = useView()
  const [tab, setTab] = useState<'pending' | 'decided'>('pending')
  const sorted = useMemo(() => sortForReview(s.proposals), [s.proposals])
  const pending = sorted.filter((p) => p.status === 'pending')
  const decided = sorted.filter((p) => p.status !== 'pending')
  const list = tab === 'pending' ? pending : decided

  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader
        title="AI 建议中心"
        subtitle="Agent 只在共享的企业上下文里工作；它们写下的东西在你的确认之前不会生效。"
        actions={
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-ink-500">
            <Sparkles className="h-3.5 w-3.5" />
            AI 输出仅供参考，需人工确认
          </span>
        }
      />

      <div className="mb-4 inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-sm shadow-sm">
        {(
          [
            ['pending', `待确认（${pending.length}）`],
            ['decided', `已处理（${decided.length}）`]
          ] as [typeof tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn('rounded-md px-3 py-1 transition-colors', tab === key ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-500 hover:text-ink-900')}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-4">
          {list.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Sparkles className="h-8 w-8" />}
                title={tab === 'pending' ? '暂时没有待确认的建议' : '还没有处理过的建议'}
                hint="当付款条款等商业条件发生变化时，法务、财务、经营三个视角会自动分析，并把结论汇总成一条待确认的建议放在这里。"
              />
            </Card>
          ) : (
            list.map((p) => <ProposalCard key={p.id} id={p.id} />)
          )}
        </div>
        <div className="space-y-4">
          <RunPanel />
          <MemoryPanel />
        </div>
      </div>
    </div>
  )
}
