import { create } from 'zustand'
import type { ApiMethod, NexusBridge } from '@shared/api'
import type { IdentityStatus } from '@shared/identity'
import type { ViewState } from '@shared/types'

export type Page = 'dashboard' | 'proposals' | 'transactions' | 'contracts' | 'contacts' | 'collaboration' | 'performance' | 'organization' | 'settings'
export interface Route { page: Page; transactionId?: string; contractId?: string }
export interface Toast { id: number; kind: 'success' | 'error' | 'info'; text: string }
interface AppStore {
  state: ViewState | null
  mode: 'demo' | 'server' | null
  identityStatus: IdentityStatus | null
  choosingCompany: boolean
  error: string | null
  loading: boolean
  busy: boolean
  route: Route
  toasts: Toast[]
  init: () => Promise<void>
  refreshIdentity: () => Promise<void>
  identity: <T = unknown>(action: string, body?: unknown) => Promise<T | null>
  selectCompany: (orgId: string) => Promise<void>
  chooseCompany: () => void
  act: (method: ApiMethod, args: unknown[], successText?: string) => Promise<boolean>
  navigate: (route: Route) => void
  toast: (kind: Toast['kind'], text: string) => void
  dismissToast: (id: number) => void
}
let toastSeq = 0
let contextVersion = 0
let operationSeq = 0
const accessExpired = (code: string): boolean => /UNAUTHORIZED|UNAUTHENTICATED|ACCOUNT_DISABLED|FORBIDDEN|SESSION|MEMBERSHIP|AUTH_REQUIRED|PERMISSION_DENIED|^401$|^403$/.test(code)
const bridge = (globalThis as typeof globalThis & { window: { nexus: NexusBridge } }).window.nexus

export const useApp = create<AppStore>((set, get) => ({
  state: null, mode: null, identityStatus: null, choosingCompany: false, error: null,
  loading: true, busy: false, route: { page: 'dashboard' }, toasts: [],

  async init() {
    set({ loading: true, error: null })
    try {
      const mode = await bridge.mode()
      if (mode !== 'server' && mode !== 'demo') throw new Error('运行模式无效')
      set({ mode })
      if (mode === 'server') await get().refreshIdentity()
      else {
        const res = await bridge.call('getState')
        if (!res.ok) throw new Error(res.message)
        set({ state: res.state })
      }
    } catch (error) {
      set({ state: null, error: error instanceof Error ? error.message : '无法连接服务，请重试' })
    } finally { set({ loading: false }) }
  },

  async refreshIdentity() {
    if (get().mode !== 'server') return
    let requestVersion = contextVersion
    try {
      const result = await bridge.identity('status')
      if (requestVersion !== contextVersion) return
      if (!result.ok) {
        if (accessExpired(result.code)) {
          ++contextVersion
          const configured = get().identityStatus?.configured ?? true
          set({ state: null, identityStatus: { account: null, companies: [], actingOrgId: null, configured }, choosingCompany: false, error: result.message, route: { page: 'dashboard' } })
          get().toast('info', '登录会话已结束，请重新登录')
          return
        }
        throw new Error(result.message)
      }
      const status = result.data as IdentityStatus
      const previous = get().identityStatus
      const changed = previous?.account?.id !== status.account?.id || previous?.actingOrgId !== status.actingOrgId
      const company = status.companies.find((item) => item.id === status.actingOrgId)
      const previousRole = previous?.companies.find((item) => item.id === previous.actingOrgId)?.role
      if (previous?.account && (!status.account || (previous.actingOrgId && !company))) {
        get().toast('info', !status.account ? '登录会话已结束，请重新登录' : '当前企业访问权限已变化，请重新选择企业')
      } else if (previousRole && company && previousRole !== company.role) {
        get().toast('info', '企业角色已更新，正在重新加载权限')
      }
      if (changed || previousRole !== company?.role || (get().state && (!status.configured || !status.account || !company))) {
        ++contextVersion
        requestVersion = contextVersion
        set({ state: null, route: { page: 'dashboard' } })
      }
      set({ identityStatus: status, error: null })
      if (!status.configured || !status.account || !company || get().choosingCompany) return
      const res = await bridge.call('getState')
      if (requestVersion !== contextVersion) return
      if (res.ok) set({ state: res.state })
      else {
        ++contextVersion
        requestVersion = contextVersion
        set({ state: null, error: res.message, route: { page: 'dashboard' } })
        get().toast('error', res.message)
        if (accessExpired(res.code)) {
          const latest = await bridge.identity('status')
          if (requestVersion !== contextVersion) return
          if (latest.ok) set({ identityStatus: latest.data as IdentityStatus })
          else if (accessExpired(latest.code)) {
            const configured = get().identityStatus?.configured ?? true
            set({ identityStatus: { account: null, companies: [], actingOrgId: null, configured }, choosingCompany: false })
          }
        }
      }
    } catch (error) {
      if (requestVersion !== contextVersion) return
      ++contextVersion
      set({ state: null, error: error instanceof Error ? error.message : '无法验证当前会话，请重试', route: { page: 'dashboard' } })
    }
  },

  async identity<T = unknown>(action: string, body?: unknown): Promise<T | null> {
    const operation = ++operationSeq
    set({ busy: true })
    if (['logout', 'revoke-all', 'select-company', 'accept-invitation'].includes(action)) ++contextVersion
    if (['select-company', 'accept-invitation'].includes(action)) {
      set({ state: null, route: { page: 'dashboard' } })
    }
    const version = contextVersion
    try {
      const res = await bridge.identity(action, body)
      if (version !== contextVersion) return null
      if (!res.ok) {
        get().toast('error', res.message)
        if (accessExpired(res.code)) {
          ++contextVersion
          set({ state: null, route: { page: 'dashboard' } })
          await get().refreshIdentity()
        }
        return null
      }
      if (['logout', 'revoke-all'].includes(action)) {
        ++contextVersion
        const configured = get().identityStatus?.configured ?? true
        set({ state: null, identityStatus: { account: null, companies: [], actingOrgId: null, configured }, choosingCompany: false, route: { page: 'dashboard' } })
      }
      if (action === 'create-company') set({ choosingCompany: false })
      return res.data as T
    } catch {
      if (version === contextVersion) get().toast('error', '无法连接身份服务，请重试')
      return null
    } finally { if (operation === operationSeq) set({ busy: false }) }
  },

  async selectCompany(orgId) {
    const result = await get().identity('select-company', { orgId })
    if (result === null) { set({ choosingCompany: true }); return }
    set({ choosingCompany: false, error: null })
    await get().refreshIdentity()
  },

  chooseCompany() {
    ++contextVersion
    set({ state: null, choosingCompany: true, route: { page: 'dashboard' } })
  },

  async act(method, args, successText) {
    const version = contextVersion
    const operation = ++operationSeq
    set({ busy: true })
    try {
      const res = await bridge.call(method, ...args)
      if (version !== contextVersion) return false
      if (res.ok) {
        set({ state: res.state })
        if (successText) get().toast('success', successText)
        return true
      }
      get().toast('error', res.message)
      if (get().mode === 'server' && accessExpired(res.code)) {
        ++contextVersion
        set({ state: null, route: { page: 'dashboard' } })
        await get().refreshIdentity()
      }
      return false
    } catch {
      if (version === contextVersion) get().toast('error', '操作失败，请重试')
      return false
    } finally { if (operation === operationSeq) set({ busy: false }) }
  },

  navigate(route) { set({ route }) },
  toast(kind, text) {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 5000 : 2800)
  },
  dismissToast(id) { set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })) }
}))

export function useView(): ViewState {
  const state = useApp((s) => s.state)
  if (!state) throw new Error('state not loaded')
  return state
}
