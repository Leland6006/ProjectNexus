import { create } from 'zustand'
import type { ApiMethod } from '@shared/api'
import type { ViewState } from '@shared/types'
import { counterpartyGroups } from './lib/selectors'
import { HOME, defaultRoute, isContractRoute, reconcileRoute, rememberable, type ModuleId, type Route, type VisibleIds } from './routes'

export type { ModuleId, Route } from './routes'

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  text: string
}

interface AppStore {
  state: ViewState | null
  loading: boolean
  chatDraft: { conversationId: string; body: string } | null
  busy: boolean
  route: Route
  /** Last page per module, so switching modules returns to where the user was. */
  lastRoutes: Partial<Record<ModuleId, Route>>
  sidebarCollapsed: boolean
  /** Sidebar preference to restore after leaving the contract editor. */
  sidebarBeforeContract: boolean | null
  /** Set by a page with unsaved edits; returns false to cancel leaving. */
  leaveGuard: (() => boolean) | null
  toasts: Toast[]
  init: () => Promise<void>
  /** Run a mutation. Returns true on success. Shows an error toast on failure. */
  act: (method: ApiMethod, args: unknown[], successText?: string) => Promise<boolean>
  navigate: (route: Route) => void
  openModule: (module: ModuleId) => void
  toggleSidebar: () => void
  setLeaveGuard: (guard: (() => boolean) | null) => void
  toast: (kind: Toast['kind'], text: string) => void
  dismissToast: (id: number) => void
}

let toastSeq = 0
let pendingCount = 0
let identityEpoch = 0
let workflowUnsubscribe: (() => void) | undefined
let chatUnsubscribe: (() => void) | undefined

function visibleFor(s: ViewState): VisibleIds {
  return {
    conversations: s.conversations.map((c) => c.id),
    transactions: s.transactions.map((t) => t.id),
    contracts: s.contracts.map((c) => c.id),
    counterparties: counterpartyGroups(s).map((g) => g.orgId)
  }
}

/** Route change plus the sidebar rule: the contract editor gets the full width by default. */
function routeChange(cur: AppStore, route: Route): Partial<AppStore> {
  const patch: Partial<AppStore> = { route, lastRoutes: { ...cur.lastRoutes, [route.module]: rememberable(route) } }
  const entering = isContractRoute(route) && !isContractRoute(cur.route)
  const leaving = !isContractRoute(route) && isContractRoute(cur.route)
  if (entering) {
    patch.sidebarBeforeContract = cur.sidebarCollapsed
    patch.sidebarCollapsed = true
  } else if (leaving && cur.sidebarBeforeContract !== null) {
    patch.sidebarCollapsed = cur.sidebarBeforeContract
    patch.sidebarBeforeContract = null
  }
  return patch
}

export const useApp = create<AppStore>((set, get) => ({
  state: null,
  loading: true,
  chatDraft: null,
  busy: false,
  route: HOME,
  lastRoutes: {},
  sidebarCollapsed: false,
  sidebarBeforeContract: null,
  leaveGuard: null,
  toasts: [],

  async init() {
    workflowUnsubscribe?.()
    workflowUnsubscribe = window.nexus.onWorkflowProgress?.((state) => { if (get().state?.currentUserId === state.currentUserId) set({ state }) })
    chatUnsubscribe?.()
    chatUnsubscribe = window.nexus.onChatProgress?.((event) => {
      const cur = get()
      if (cur.state?.currentUserId !== event.userId) return
      const patch: Partial<AppStore> = { chatDraft: event.stage === 'end' ? null : { conversationId: event.conversationId, body: event.body } }
      if (event.state) patch.state = event.state
      if (event.stage === 'start' && cur.route.module === 'nexus' && !cur.route.conversationId) patch.route = { module: 'nexus', conversationId: event.conversationId }
      set(patch)
    })
    const res = await window.nexus.call('getState')
    if (res.ok) set({ state: res.state, loading: false, route: HOME })
    else {
      set({ loading: false })
      get().toast('error', res.message)
    }
  },

  async act(method, args, successText) {
    const switching = method === 'switchUser' || method === 'resetDemo'
    if (switching) { identityEpoch++; set({ chatDraft: null }) }
    const epoch = identityEpoch
    pendingCount++
    set({ busy: true })
    try {
      const res = await window.nexus.call(method, ...args)
      if (epoch !== identityEpoch) return false
      if (res.ok) {
        const cur = get()
        const identityChanged = !cur.state || cur.state.currentUserId !== res.state.currentUserId || method === 'resetDemo'
        if (identityChanged) {
          // A different account starts clean: no conversation, selection or page of the
          // previous account survives the switch.
          set({ state: res.state, ...routeChange(cur, HOME), lastRoutes: {}, leaveGuard: null })
        } else {
          const v = visibleFor(res.state)
          const lastRoutes: Partial<Record<ModuleId, Route>> = {}
          for (const [k, r] of Object.entries(cur.lastRoutes) as [ModuleId, Route][]) lastRoutes[k] = reconcileRoute(r, v)
          const next = reconcileRoute(cur.route, v)
          set({ state: res.state, lastRoutes, ...(next !== cur.route ? routeChange({ ...cur, lastRoutes }, next) : {}) })
        }
        if (successText) get().toast('success', successText)
        if (res.notice) get().toast('info', res.notice)
        return true
      }
      get().toast('error', res.code === 'PERMISSION_DENIED' ? `权限不足：${res.message}` : res.message)
      return false
    } catch {
      get().toast('error', '操作失败，请重试')
      return false
    } finally {
      pendingCount--
      set({ busy: pendingCount > 0 })
    }
  },

  navigate(route) {
    const guard = get().leaveGuard
    if (guard && !guard()) return
    set(routeChange(get(), route))
  },

  openModule(module) {
    const cur = get()
    if (cur.route.module === module || !cur.state) return
    const target = cur.lastRoutes[module] ?? defaultRoute(module)
    cur.navigate(reconcileRoute(target, visibleFor(cur.state)))
  },

  toggleSidebar() {
    set({ sidebarCollapsed: !get().sidebarCollapsed })
  },

  setLeaveGuard(guard) {
    set({ leaveGuard: guard })
  },

  toast(kind, text) {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 5000 : 3200)
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
}))

/** Ask the current page whether it is safe to leave (unsaved edits). */
export function confirmLeave(): boolean {
  const guard = useApp.getState().leaveGuard
  return !guard || guard()
}

export function useView(): ViewState {
  const s = useApp((x) => x.state)
  if (!s) throw new Error('state not loaded')
  return s
}
