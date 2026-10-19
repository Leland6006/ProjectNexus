import { useMemo, type ReactNode } from 'react'
import { CalendarClock, ChevronRight, FileWarning, Handshake, Sparkles } from 'lucide-react'
import { attentionItems, type AttentionItem } from '@shared/briefing'
import { pendingCount } from '@shared/proposalView'
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader } from '@/components/ui'
import { NotEnabled, SourceLine } from '@/components/StatusNote'
import { formatDateTime } from '@/lib/utils'
import { currentUser, orgOf } from '@/lib/selectors'
import { attentionRoute, projectRoute, type ActionsView } from '@/routes'
import { useApp, useView } from '@/store'
import Proposals from './Proposals'

const KIND = {
  decision: { label: '待决策', tone: 'amber' },
  suggestion: { label: '修改建议', tone: 'blue' },
  milestone: { label: '履约期限', tone: 'gray' }
} as const

function AttentionRow({ item }: { item: AttentionItem }) {
  const navigate = useApp((x) => x.navigate)
  const kind = KIND[item.kind]
  return (
    <li>
      <button
        onClick={() => navigate(attentionRoute(item))}
        className="flex w-full items-start gap-3 border-t border-slate-100 px-4 py-3 text-left first:border-t-0 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
      >
        <Badge tone={item.urgency === 0 ? 'red' : kind.tone}>{item.urgency === 0 ? '已逾期' : kind.label}</Badge>
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-ink-900">{item.title}</span>
          <span className="mt-0.5 block text-xs text-ink-400">
            {item.detail} · {item.source}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5 text-xs text-brand-700">
          处理
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
      </button>
    </li>
  )
}

function Tile({ icon, label, value, onClick }: { icon: ReactNode; label: string; value: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg border border-slate-200 bg-white p-4 text-left transition hover:border-brand-200 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <div className="mb-2 flex items-center gap-1.5 text-xs text-ink-500">
        <span className="text-brand-600">{icon}</span>
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums tracking-tight text-ink-900">{value}</div>
    </button>
  )
}

function Overview() {
  const s = useView()
  const navigate = useApp((x) => x.navigate)
  const me = currentUser(s)
  const now = useMemo(() => new Date(), [s])
  const items = useMemo(() => attentionItems(s, now), [s, now])
  const active = s.transactions.filter((t) => ['negotiating', 'pending_signature', 'in_performance'].includes(t.status))
  const suggestions = items.filter((i) => i.kind === 'suggestion').length
  const deadlines = items.filter((i) => i.kind === 'milestone').length
  const inProgress = s.milestones.filter((m) => m.status === 'in_progress')
  const recent = [...s.activities].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6)

  return (
    <div className="mx-auto max-w-5xl p-6">
      <PageHeader title="经营概况" subtitle={`${orgOf(s, me.orgId)?.name} · 根据你当前可见的业务数据整理`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile icon={<Handshake className="h-4 w-4" />} label="进行中的业务" value={active.length} onClick={() => navigate({ module: 'business', view: 'all' })} />
        <Tile icon={<Sparkles className="h-4 w-4" />} label="待我决策" value={pendingCount(s.proposals)} onClick={() => navigate({ module: 'actions', view: 'decisions' })} />
        <Tile icon={<FileWarning className="h-4 w-4" />} label="待我方处理的修改建议" value={suggestions} onClick={() => navigate({ module: 'actions', view: 'attention' })} />
        <Tile icon={<CalendarClock className="h-4 w-4" />} label="14 天内到期或逾期的节点" value={deadlines} onClick={() => navigate({ module: 'actions', view: 'attention' })} />
      </div>
      <div className="mt-2">
        <SourceLine>来源：本账号可见的业务、合同修改建议、AI 建议与履约节点 · 统计于 {formatDateTime(now.toISOString())}</SourceLine>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader
            title="需要关注"
            action={
              items.length > 5 && (
                <Button size="sm" variant="ghost" onClick={() => navigate({ module: 'actions', view: 'attention' })}>
                  全部 {items.length} 项
                </Button>
              )
            }
          />
          {items.length === 0 ? <EmptyState title="目前没有需要关注的事项" hint="有待决策的方案、对方的修改建议或临近的履约期限时，会显示在这里" /> : <ul>{items.slice(0, 5).map((i) => <AttentionRow key={i.id} item={i} />)}</ul>}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="执行进度" subtitle="任务执行尚未启用，这里只显示履约节点的实际状态" />
          {inProgress.length === 0 ? (
            <p className="px-4 py-4 text-xs text-ink-500">没有进行中的履约节点</p>
          ) : (
            <ul>
              {inProgress.map((m) => (
                <li key={m.id}>
                  <button
                    onClick={() => navigate(projectRoute(m.transactionId, 'performance'))}
                    className="w-full border-t border-slate-100 px-4 py-2.5 text-left first:border-t-0 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                  >
                    <p className="truncate text-sm text-ink-900">{m.name}</p>
                    <p className="text-xs text-ink-400">
                      {s.transactions.find((t) => t.id === m.transactionId)?.name} · 计划 {m.dueDate}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="lg:col-span-5">
          <CardHeader title="近期动态" />
          {recent.length === 0 ? (
            <p className="px-4 py-4 text-xs text-ink-500">暂无动态</p>
          ) : (
            <ul className="px-4 py-2">
              {recent.map((a) => (
                <li key={a.id} className="flex items-start gap-3 py-1.5">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                  <span className="flex-1 text-sm text-ink-700">{a.summary}</span>
                  <span className="shrink-0 text-xs text-ink-400">{formatDateTime(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

function Attention() {
  const s = useView()
  const now = useMemo(() => new Date(), [s])
  const items = useMemo(() => attentionItems(s, now), [s, now])
  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader title="需要关注" subtitle="按紧急程度排列。每一项都注明了来源，点击进入对应业务处理。" />
      <Card>{items.length === 0 ? <EmptyState title="目前没有需要关注的事项" /> : <ul>{items.map((i) => <AttentionRow key={i.id} item={i} />)}</ul>}</Card>
      <div className="mt-2">
        <SourceLine>统计于 {formatDateTime(now.toISOString())} · 履约期限只列出 14 天内到期或已逾期的节点</SourceLine>
      </div>
    </div>
  )
}

function Executing() {
  const navigate = useApp((x) => x.navigate)
  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader title="执行中" />
      <NotEnabled
        title="任务执行"
        detail="Nexus 目前还没有任务模型。采纳一个方案只会生成合同修改建议和活动记录，不会自动创建或执行任务，所以这里不会显示“执行中”的内容。分步流程和任务进度计划在第三轮提供。"
      >
        <Button size="sm" onClick={() => navigate({ module: 'actions', view: 'decisions' })}>
          查看待我决策
        </Button>
        <Button size="sm" onClick={() => navigate({ module: 'actions', view: 'attention' })}>
          查看需要关注
        </Button>
      </NotEnabled>
    </div>
  )
}

export default function ActionsPage({ view }: { view: ActionsView }) {
  switch (view) {
    case 'overview':
      return <Overview />
    case 'attention':
      return <Attention />
    case 'decisions':
      return <Proposals mode="pending" />
    case 'executing':
      return <Executing />
    case 'done':
      return <Proposals mode="decided" />
  }
}
