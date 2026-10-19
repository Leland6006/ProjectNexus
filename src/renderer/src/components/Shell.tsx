import { useState, type ReactNode } from 'react'
import { BookMarked, Briefcase, Compass, MessageCircle, PanelLeftClose, PanelLeftOpen, Settings as SettingsIcon, ShieldAlert, Wallet } from 'lucide-react'
import { ROLE_LABEL } from '@shared/types'
import { pendingCount } from '@shared/proposalView'
import { cn } from '@/lib/utils'
import { counselGrantOrgIds, currentUser, directory, orgOf } from '@/lib/selectors'
import { confirmLeave, useApp, useView, type ModuleId } from '@/store'
import { MODULE_TITLE, SecondaryNav } from './SecondaryNav'

const MODULES: { id: ModuleId; short: string; icon: typeof Compass }[] = [
  { id: 'nexus', short: 'Nexus', icon: MessageCircle },
  { id: 'actions', short: '行动', icon: Compass },
  { id: 'business', short: '业务', icon: Briefcase },
  { id: 'finance', short: '资金', icon: Wallet },
  { id: 'memory', short: '档案', icon: BookMarked }
]

function RailButton({ id, short, icon: Icon, badge }: { id: ModuleId; short: string; icon: typeof Compass; badge?: number }) {
  const active = useApp((x) => x.route.module === id)
  const openModule = useApp((x) => x.openModule)
  return (
    <button
      onClick={() => openModule(id)}
      aria-label={MODULE_TITLE[id]}
      aria-current={active ? 'page' : undefined}
      title={MODULE_TITLE[id]}
      className={cn(
        'no-drag relative flex w-14 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        active ? 'bg-white text-brand-700 shadow-sm ring-1 ring-slate-200' : 'text-ink-500 hover:bg-slate-200/70 hover:text-ink-900'
      )}
    >
      <Icon className="h-[18px] w-[18px]" aria-hidden />
      <span className={cn(active && 'font-medium')}>{short}</span>
      {badge !== undefined && badge > 0 && (
        <span className="absolute right-1 top-0.5 min-w-[16px] rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-4 text-white">{badge}</span>
      )}
    </button>
  )
}

/** Account and operating-company switcher. Switching account also switches the company you operate as. */
function AccountMenu() {
  const s = useView()
  const act = useApp((x) => x.act)
  const [open, setOpen] = useState(false)
  const me = currentUser(s)
  const dir = directory(s)

  const choose = async (id: string): Promise<void> => {
    setOpen(false)
    if (id === me.id || !confirmLeave()) return
    const target = dir.users.find((u) => u.id === id)!
    const org = dir.organizations.find((o) => o.id === target.orgId)
    await act('switchUser', [id], `已切换为 ${target.name}（${org?.shortName ?? ''}）`)
  }

  return (
    <div className="no-drag relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`当前账号：${me.name}，点击切换经营企业或账号`}
        title={`${me.name} · ${orgOf(s, me.orgId)?.shortName ?? ''}`}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700 ring-2 ring-white hover:bg-brand-200 focus-visible:outline-none focus-visible:ring-brand-500"
      >
        {me.name.slice(0, 1)}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute bottom-0 left-full z-40 ml-2 w-72 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl">
            <div className="px-2 pb-2 pt-1.5">
              <p className="text-xs text-ink-500">当前账号</p>
              <p className="text-sm font-medium">
                {me.name} · {ROLE_LABEL[me.role]}
              </p>
              <p className="text-xs text-ink-500">经营企业：{orgOf(s, me.orgId)?.name}</p>
            </div>
            <div className="max-h-80 overflow-y-auto border-t border-slate-100 pt-1">
              <p className="px-2 py-1 text-[11px] text-ink-400">切换经营企业或账号（本地演示，不是真实登录）</p>
              {dir.organizations.map((o) => {
                const members = dir.users.filter((u) => u.orgId === o.id)
                if (members.length === 0) return null
                return (
                  <div key={o.id} className="py-0.5">
                    <p className="px-2 pt-1 text-[11px] font-medium text-ink-500">{o.name}</p>
                    {members.map((u) => (
                      <button
                        key={u.id}
                        role="menuitemradio"
                        aria-checked={u.id === me.id}
                        onClick={() => void choose(u.id)}
                        className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100', u.id === me.id && 'bg-brand-50 text-brand-700')}
                      >
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-medium">{u.name.slice(0, 1)}</span>
                        <span className="flex-1 truncate">{u.name}</span>
                        <span className="text-xs text-ink-400">{ROLE_LABEL[u.role]}</span>
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** External counsel authorised by both parties must say which client they act for. */
function RepresentingOrgPicker() {
  const s = useView()
  const act = useApp((x) => x.act)
  const me = currentUser(s)
  const grantIds = counselGrantOrgIds(s)
  if (me.role !== 'external_counsel' || grantIds.length === 0) return null
  const current = s.representingOrgId && grantIds.includes(s.representingOrgId) ? s.representingOrgId : grantIds[0]
  if (grantIds.length === 1) return <span className="text-xs text-ink-500">代表委托方：{orgOf(s, current)?.shortName ?? current}</span>
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-500">
      代表委托方
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
  const s = useView()
  const module = useApp((x) => x.route.module)
  const collapsed = useApp((x) => x.sidebarCollapsed)
  const toggleSidebar = useApp((x) => x.toggleSidebar)
  const openModule = useApp((x) => x.openModule)
  const me = currentUser(s)
  const myOrg = orgOf(s, me.orgId)

  return (
    <div className="flex h-full">
      {/* Level 1: modules */}
      <nav aria-label="模块" className="drag flex w-[76px] shrink-0 flex-col items-center border-r border-slate-200 bg-slate-100/80 pb-3">
        <div className="h-12 shrink-0" />
        <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white" aria-hidden>
          N
        </div>
        <div className="flex flex-1 flex-col items-center gap-1">
          {MODULES.map((m) => (
            <RailButton key={m.id} {...m} badge={m.id === 'actions' ? pendingCount(s.proposals) : undefined} />
          ))}
        </div>
        <div className="flex flex-col items-center gap-2">
          <button
            onClick={() => openModule('settings')}
            aria-label="设置"
            aria-current={module === 'settings' ? 'page' : undefined}
            title="设置"
            className={cn(
              'no-drag flex h-9 w-9 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
              module === 'settings' ? 'bg-white text-brand-700 shadow-sm ring-1 ring-slate-200' : 'text-ink-500 hover:bg-slate-200/70'
            )}
          >
            <SettingsIcon className="h-[18px] w-[18px]" />
          </button>
          <AccountMenu />
        </div>
      </nav>

      {/* Level 2: objects in the current module */}
      {!collapsed && (
        <aside aria-label={`${MODULE_TITLE[module]}导航`} className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-slate-50">
          <div className="drag flex h-12 shrink-0 items-center justify-between px-3">
            <span className="text-sm font-semibold text-ink-900">{MODULE_TITLE[module]}</span>
            <button
              onClick={toggleSidebar}
              aria-label="收起侧栏"
              title="收起侧栏"
              className="no-drag rounded-md p-1 text-ink-400 hover:bg-slate-200/70 hover:text-ink-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <SecondaryNav />
          </div>
          <div className="border-t border-slate-200 px-3 py-2.5">
            <p className="text-[11px] text-ink-400">当前经营企业</p>
            <p className="truncate text-sm font-medium text-ink-900" title={myOrg?.name}>
              {myOrg?.name}
            </p>
            <p className="truncate text-xs text-ink-500">
              {me.name} · {ROLE_LABEL[me.role]}
            </p>
          </div>
        </aside>
      )}

      {/* Main work area */}
      <div className="flex min-w-0 flex-1 flex-col bg-white">
        <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-slate-200 px-4">
          {collapsed && (
            <button
              onClick={toggleSidebar}
              aria-label="展开侧栏"
              title="展开侧栏"
              className="no-drag rounded-md p-1 text-ink-400 hover:bg-slate-100 hover:text-ink-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
          <div className="no-drag flex min-w-0 items-center gap-2 text-xs">
            <span className="shrink-0 rounded bg-brand-50 px-1.5 py-0.5 font-medium text-brand-700">经营企业</span>
            <span className="truncate font-medium text-ink-700">{myOrg?.name}</span>
            <RepresentingOrgPicker />
          </div>
          <div
            className="no-drag ml-auto flex shrink-0 items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-700"
            title="账号切换仅用于本地演示，不是真实的身份认证"
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            本地模拟账号 · 演示数据
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
