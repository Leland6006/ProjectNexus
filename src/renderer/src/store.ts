import { create } from 'zustand'
import type { ApiMethod } from '@shared/api'
import type { ViewState } from '@shared/types'

export type Page = 'dashboard' | 'transactions' | 'contracts' | 'collaboration' | 'performance' | 'organization' | 'settings'

export interface Route {
  page: Page
  transactionId?: string
  contractId?: string
}

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  text: string
}

interface AppStore {
  state: ViewState | null
  loading: boolean
  busy: boolean
  route: Route
  toasts: Toast[]
  init: () => Promise<void>
  /** Run a mutation. Returns true on success. Shows a toast either way unless silent. */
  act: (method: ApiMethod, args: unknown[], successText?: string) => Promise<boolean>
  navigate: (route: Route) => void
  toast: (kind: Toast['kind'], text: string) => void
  dismissToast: (id: number) => void
}

let toastSeq = 0

export const useApp = create<AppStore>((set, get) => ({
  state: null,
  loading: true,
  busy: false,
  route: { page: 'dashboard' },
  toasts: [],

  async init() {
    const res = await window.nexus.call('getState')
    if (res.ok) set({ state: res.state, loading: false })
    else {
      set({ loading: false })
      get().toast('error', res.message)
    }
  },

  async act(method, args, successText) {
    set({ busy: true })
    try {
      const res = await window.nexus.call(method, ...args)
      if (res.ok) {
        set({ state: res.state })
        if (successText) get().toast('success', successText)
        return true
      }
      get().toast('error', res.code === 'PERMISSION_DENIED' ? `权限不足：${res.message}` : res.message)
      return false
    } catch {
      get().toast('error', '操作失败，请重试')
      return false
    } finally {
      set({ busy: false })
    }
  },

  navigate(route) {
    set({ route })
  },

  toast(kind, text) {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 5000 : 2800)
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
}))

export function useView(): ViewState {
  const s = useApp((x) => x.state)
  if (!s) throw new Error('state not loaded')
  return s
}
