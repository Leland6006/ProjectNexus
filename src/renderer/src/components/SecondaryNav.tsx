import { useState, type ReactNode } from 'react'
import { Archive, Building2, FileText, Plus, Search } from 'lucide-react'
import { attentionItems } from '@shared/briefing'
import { searchConversations } from '@shared/chat'
import { pendingCount, unconfirmedClaims } from '@shared/proposalView'
import { cn, formatDate } from '@/lib/utils'
import { accessFor, counterpartyGroups, currentUser, otherPartyId } from '@/lib/selectors'
import { HOME, type ActionsView, type FinanceView, type MemoryView } from '@/routes'
import { useApp, useView, type ModuleId } from '@/store'

export const MODULE_TITLE: Record<ModuleId, string> = {
  nexus: 'Nexus',
  actions: '行动与决策',
  business: '业务与项目',
  finance: '资金与收支',
  memory: '公司档案与记忆',
  settings: '设置'
}

function Item({
  active,
  label,
  onClick,
  count,
  tag,
  icon,
  indent,
  hint
}: {
  active?: boolean
  label: string
  onClick: () => void
  count?: number
  tag?: string
  icon?: ReactNode
  indent?: boolean
  hint?: string
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={hint ?? label}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        indent && 'pl-8 text-[13px]',
        active ? 'bg-white font-medium text-brand-700 shadow-sm ring-1 ring-slate-200' : 'text-ink-700 hover:bg-slate-200/60'
      )}
    >
      {icon && <span className="shrink-0 text-ink-400">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {tag && <span className="shrink-0 rounded bg-slate-200/70 px-1.5 text-[10px] leading-4 text-ink-500">{tag}</span>}
      {count !== undefined && count > 0 && <span className="shrink-0 text-xs tabular-nums text-ink-400">{count}</span>}
    </button>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <p className="mb-1 px-2.5 text-[11px] font-medium text-ink-400">{title}</p>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function NexusNav() {
  const s = useView()
  const route = useApp((x) => x.route)
  const navigate = useApp((x) => x.navigate)
  const [q, setQ] = useState('')
  const list = searchConversations(s.conversations, q)
  const activeId = route.module === 'nexus' ? route.conversationId : null

  return (
    <div>
      <button
        onClick={() => navigate(HOME)}
        className="flex w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-ink-900 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <Plus className="h-4 w-4 text-brand-600" />
        新对话
      </button>
      <div className="relative mt-2">
        <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-ink-400" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索对话"
          aria-label="搜索对话"
          className="h-7 w-full rounded-md border border-slate-200 bg-white pl-8 pr-2 text-xs placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
      </div>
      <Section title="最近聊天">
        {list.length === 0 ? (
          <p className="px-2.5 py-2 text-xs leading-5 text-ink-400">
            {s.conversations.length === 0 ? '还没有对话。发送第一条消息后会出现在这里。' : '没有匹配的对话'}
          </p>
        ) : (
          list.map((c) => (
            <Item
              key={c.id}
              active={c.id === activeId}
              label={c.title}
              hint={`${c.title} · ${formatDate(c.updatedAt)}`}
              onClick={() => navigate({ module: 'nexus', conversationId: c.id })}
            />
          ))
        )}
      </Section>
    </div>
  )
}

function ActionsNav() {
  const s = useView()
  const route = useApp((x) => x.route)
  const navigate = useApp((x) => x.navigate)
  const current = route.module === 'actions' ? route.view : null
  const attention = attentionItems(s, new Date()).length
  const decided = s.proposals.filter((p) => p.status !== 'pending').length
  const items: { view: ActionsView; label: string; count?: number; tag?: string }[] = [
    { view: 'overview', label: '经营概况' },
    { view: 'attention', label: '需要关注', count: attention },
    { view: 'decisions', label: '待我决策', count: pendingCount(s.proposals) },
    { view: 'executing', label: '执行中', tag: '未启用' },
    { view: 'done', label: '已处理', count: decided }
  ]
  return (
    <div className="space-y-0.5">
      {items.map((i) => (
        <Item key={i.view} active={current === i.view} label={i.label} count={i.count} tag={i.tag} onClick={() => navigate({ module: 'actions', view: i.view })} />
      ))}
    </div>
  )
}

function BusinessNav() {
  const s = useView()
  const route = useApp((x) => x.route)
  const navigate = useApp((x) => x.navigate)
  const me = currentUser(s)
  const groups = counterpartyGroups(s)
  const b = route.module === 'business' ? route : null

  // Which business (and therefore which counterparty) the main area is showing.
  let activeTxId: string | null = null
  if (b?.view === 'project') activeTxId = b.transactionId
  if (b?.view === 'contract') activeTxId = s.contracts.find((c) => c.id === b.contractId)?.transactionId ?? null
  const activeTx = activeTxId ? s.transactions.find((t) => t.id === activeTxId) : undefined
  const activeOrg = b?.view === 'counterparty' ? b.orgId : activeTx ? otherPartyId(activeTx, accessFor(s, activeTx).orgId) : null

  return (
    <div>
      <div className="space-y-0.5">
        {me.role !== 'external_counsel' && (
          <Item icon={<Plus className="h-4 w-4" />} label="新建业务" onClick={() => navigate({ module: 'business', view: 'all', create: true })} />
        )}
        <Item active={b?.view === 'all'} label="全部业务" count={s.transactions.length} onClick={() => navigate({ module: 'business', view: 'all' })} />
        <Item
          active={b?.view === 'contracts'}
          icon={<FileText className="h-3.5 w-3.5" />}
          label="全部合同"
          count={s.contracts.length}
          onClick={() => navigate({ module: 'business', view: 'contracts' })}
        />
      </div>
      <Section title="按交易对象">
        {groups.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-ink-400">暂无交易对象</p>
        ) : (
          groups.map((g) => (
            <div key={g.orgId}>
              <Item
                icon={<Building2 className="h-3.5 w-3.5" />}
                active={b?.view === 'counterparty' && b.orgId === g.orgId}
                label={g.name}
                count={g.transactions.length}
                onClick={() => navigate({ module: 'business', view: 'counterparty', orgId: g.orgId })}
              />
              {activeOrg === g.orgId &&
                g.transactions.map((t) => (
                  <Item
                    key={t.id}
                    indent
                    active={activeTxId === t.id}
                    label={t.name}
                    onClick={() => navigate({ module: 'business', view: 'project', transactionId: t.id, tab: 'overview' })}
                  />
                ))}
            </div>
          ))
        )}
      </Section>
      <Section title="其他">
        <Item icon={<Archive className="h-3.5 w-3.5" />} active={b?.view === 'archived'} label="归档" tag="未启用" onClick={() => navigate({ module: 'business', view: 'archived' })} />
      </Section>
    </div>
  )
}

function FinanceNav() {
  const s = useView()
  const route = useApp((x) => x.route)
  const navigate = useApp((x) => x.navigate)
  const me = currentUser(s)
  const current = route.module === 'finance' ? route.view : null
  const items: { view: FinanceView; label: string; count?: number; tag?: string }[] = [
    { view: 'overview', label: '资金概览' },
    { view: 'receivables', label: '应收应付', tag: '未启用' },
    { view: 'records', label: '收支记录', tag: '未启用' },
    { view: 'costs', label: '成本', count: s.costItems.filter((c) => c.orgId === me.orgId).length },
    { view: 'invoices', label: '发票', tag: '未启用' }
  ]
  return (
    <div className="space-y-0.5">
      {items.map((i) => (
        <Item key={i.view} active={current === i.view} label={i.label} count={i.count} tag={i.tag} onClick={() => navigate({ module: 'finance', view: i.view })} />
      ))}
    </div>
  )
}

function MemoryNav() {
  const s = useView()
  const route = useApp((x) => x.route)
  const navigate = useApp((x) => x.navigate)
  const current = route.module === 'memory' ? route.view : null
  const confirmed = s.claims.filter((c) => c.status === 'confirmed' && !c.supersededById).length
  const items: { view: MemoryView; label: string; count?: number; tag?: string }[] = [
    { view: 'profile', label: '公司资料' },
    { view: 'confirmed', label: '已确认信息', count: confirmed },
    { view: 'unverified', label: '待核实信息', count: unconfirmedClaims(s.claims).length },
    { view: 'library', label: '资料库', tag: '未启用' },
    { view: 'members', label: '成员' }
  ]
  return (
    <div className="space-y-0.5">
      {items.map((i) => (
        <Item key={i.view} active={current === i.view} label={i.label} count={i.count} tag={i.tag} onClick={() => navigate({ module: 'memory', view: i.view })} />
      ))}
    </div>
  )
}

export function SecondaryNav() {
  const module = useApp((x) => x.route.module)
  switch (module) {
    case 'nexus':
      return <NexusNav />
    case 'actions':
      return <ActionsNav />
    case 'business':
      return <BusinessNav />
    case 'finance':
      return <FinanceNav />
    case 'memory':
      return <MemoryNav />
    case 'settings':
      return (
        <div className="space-y-0.5">
          <Item active label="通用与演示数据" onClick={() => undefined} />
        </div>
      )
  }
}
