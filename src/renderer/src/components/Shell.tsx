import { useState, type ReactNode } from 'react'
import { Building2, ChevronDown, FileText, Handshake, LayoutDashboard, MessagesSquare, Settings as SettingsIcon, ShieldAlert, Workflow } from 'lucide-react'
import { ROLE_LABEL } from '@shared/types'
import { cn } from '@/lib/utils'
import { counselGrantOrgIds, currentUser, directory, orgOf } from '@/lib/selectors'
import { useApp, useView, type Page } from '@/store'

const NAV: { page: Page; label: string; icon: typeof LayoutDashboard }[] = [
  { page: 'dashboard', label: '工作台', icon: LayoutDashboard },
  { page: 'transactions', label: '交易项目', icon: Handshake },
  { page: 'contracts', label: '合同中心', icon: FileText },
  { page: 'collaboration', label: '协作与消息', icon: MessagesSquare },
  { page: 'performance', label: '履约管理', icon: Workflow },
  { page: 'organization', label: '企业与成员', icon: Building2 },
  { page: 'settings', label: '设置', icon: SettingsIcon }
]

function AccountSwitcher() {
  const s = useView()
  const act = useApp((x) => x.act)
  const navigate = useApp((x) => x.navigate)
  const [open, setOpen] = useState(false)
  const me = currentUser(s)
  const myOrg = orgOf(s, me.orgId)
  const accounts = directory(s).users

  const choose = async (id: string): Promise<void> => {
    setOpen(false)
    if (id === me.id) return
    const target = accounts.find((u) => u.id === id)!
    if (await act('switchUser', [id], `已切换为 ${target.name}`)) navigate({ page: 'dashboard' })
  }

  return (
    <div className="relative px-3 pb-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-lg border border-slate-200 bg-white p-2 text-left shadow-sm hover:bg-slate-50"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">{me.name.slice(0, 1)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{me.name}</span>
          <span className="block truncate text-xs text-ink-500">
            {myOrg?.shortName} · {ROLE_LABEL[me.role]}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 text-ink-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <ul role="listbox" className="absolute bottom-full left-3 right-3 z-20 mb-1 max-h-96 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
            <li className="px-2 py-1.5 text-xs text-ink-500">切换演示账号（仅本地模拟）</li>
            {accounts.map((u) => (
              <li key={u.id}>
                <button
                  role="option"
                  aria-selected={u.id === me.id}
                  onClick={() => void choose(u.id)}
                  className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-100', u.id === me.id && 'bg-brand-50')}
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-medium">{u.name.slice(0, 1)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{u.name}</span>
                    <span className="block truncate text-xs text-ink-500">
                      {orgOf(s, u.orgId)?.shortName} · {ROLE_LABEL[u.role]}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * An external counsel may be authorised by both parties. When that happens they have to
 * say who they are acting for, otherwise they would only ever see the first grant.
 */
function RepresentingOrgPicker() {
  const s = useView()
  const act = useApp((x) => x.act)
  const me = currentUser(s)
  const grantIds = counselGrantOrgIds(s)
  if (me.role !== 'external_counsel' || grantIds.length === 0) return null

  const current = s.representingOrgId && grantIds.includes(s.representingOrgId) ? s.representingOrgId : grantIds[0]
  if (grantIds.length === 1) {
    return <span className="text-xs text-ink-500">代表 {orgOf(s, current)?.shortName ?? current}</span>
  }
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-500">
      代表
      <select
        value={current}
        aria-label="选择代表的委托企业"
        onChange={(e) => void act('setRepresentingOrg', [e.target.value], `已切换为代表 ${orgOf(s, e.target.value)?.shortName}`)}
        className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-ink-700"
      >
        {grantIds.map((id) => (
          <option key={id} value={id}>
            {orgOf(s, id)?.shortName ?? id}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const route = useApp((s) => s.route)
  const navigate = useApp((s) => s.navigate)
  const s = useView()
  const me = currentUser(s)
  const myOrg = orgOf(s, me.orgId)
  const active: Page = route.page

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-slate-50/80">
        <div className="drag h-12 shrink-0" />
        <div className="px-4 pb-4">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">N</div>
            <span className="text-base font-semibold tracking-tight">Project Nexus</span>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-3" aria-label="主导航">
          {NAV.map(({ page, label, icon: Icon }) => (
            <button
              key={page}
              onClick={() => navigate({ page })}
              aria-current={active === page ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                active === page ? 'bg-white font-medium text-brand-700 shadow-sm ring-1 ring-slate-200' : 'text-ink-700 hover:bg-slate-100'
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>
        <AccountSwitcher />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="drag flex h-12 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6">
          <div className="no-drag flex items-center gap-3 text-xs text-ink-500">
            <span className="font-medium text-ink-700">{myOrg?.name}</span>
            <RepresentingOrgPicker />
          </div>
          <div className="no-drag flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-700" title="账号切换仅用于本地演示，不是真实的身份认证">
            <ShieldAlert className="h-3.5 w-3.5" />
            本地模拟账号 · 演示数据
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
