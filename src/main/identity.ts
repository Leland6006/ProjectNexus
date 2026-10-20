import { setTimeout as delay } from 'node:timers/promises'
import type { ApiResult } from '../shared/api.ts'
import type { IdentityResult, IdentityStatus } from '../shared/identity.ts'

type OpenExternal = (url: string) => Promise<void>
const signedOut = (configured: boolean): IdentityStatus => ({ account: null, companies: [], actingOrgId: null, configured })

export function apiEndpoint(value: string, development: boolean): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(development && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
    throw new Error('NEXUS_API_URL 必须是 HTTPS API 根地址；开发环境仅允许本机 HTTP')
  }
  return url.origin
}

/** Tokens live only in Electron's main-process memory, never renderer/JSON/localStorage. A restart requires login. */
export class IdentityBridge {
  private token: string | null = null
  private readonly endpoint: string | null
  private readonly openExternal: OpenExternal
  private readonly development: boolean
  private readonly configError: boolean
  private pendingLogin = false
  private epoch = 0
  private liveContext = ''
  private livePaused = 0
  private readonly liveListeners = new Set<() => void>()
  onLiveContextChange(listener: () => void): () => void {
    this.liveListeners.add(listener)
    return () => { this.liveListeners.delete(listener) }
  }
  private notifyLive(): void { for (const listener of this.liveListeners) listener() }
  private clearLive(): void { this.liveContext = ''; this.notifyLive() }
  async openLive(signal: AbortSignal): Promise<Response | null> {
    if (!this.endpoint || !this.token || !this.liveContext || this.livePaused) return null
    const epoch = this.epoch
    const token = this.token
    const response = await fetch(`${this.endpoint}/live`, {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` }, signal, redirect: 'error'
    })
    if (signal.aborted || epoch !== this.epoch || token !== this.token) { await response.body?.cancel(); return null }
    return response
  }
  constructor(endpoint: string | undefined, development: boolean, openExternal: OpenExternal) {
    this.development = development
    let configuredEndpoint: string | null = null
    let configError = false
    try { configuredEndpoint = endpoint ? apiEndpoint(endpoint, development) : null }
    catch { configError = true }
    this.endpoint = configuredEndpoint
    this.configError = configError
    this.openExternal = openExternal
  }
  private async request(path: string, method = 'GET', body?: unknown, authenticated = true): Promise<IdentityResult> {
    if (this.configError) return { ok: false, code: 'INVALID_CONFIG', message: '身份服务地址配置无效，请联系部署管理员' }
    if (!this.endpoint) return { ok: false, code: 'NOT_CONFIGURED', message: '尚未配置身份服务，请联系部署管理员' }
    const epoch = this.epoch
    const requestToken = this.token
    try {
      const response = await fetch(`${this.endpoint}${path}`, {
        method, headers: { 'Content-Type': 'application/json', ...(authenticated && this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000), redirect: 'error'
      })
      const result = await response.json() as IdentityResult
      if (authenticated && response.status === 401 && epoch === this.epoch && requestToken === this.token) {
        this.token = null; this.epoch++; this.clearLive()
      }
      if (!result || typeof result.ok !== 'boolean') throw new Error('Invalid API response')
      return result
    } catch { return { ok: false, code: 'SERVICE_UNAVAILABLE', message: '无法连接身份服务，请检查网络或联系部署管理员' } }
  }
  async business(method: unknown, args: unknown[]): Promise<ApiResult> {
    if (typeof method !== 'string' || ['switchUser', 'resetDemo', 'setRepresentingOrg'].includes(method)) {
      return { ok: false, code: 'PERMISSION_DENIED', message: '真实账号模式不支持模拟身份或委托方切换' }
    }
    const result = await this.request('/business', 'POST', { method, args })
    return result.ok ? result.data as ApiResult : result
  }
  private validateExternal(url: URL): void {
    if (url.username || url.password || (url.protocol !== 'https:' &&
      !(this.development && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
      throw new Error('Invalid identity provider URL')
    }
  }
  private async status(): Promise<IdentityResult> {
    if (this.configError) return { ok: false, code: 'INVALID_CONFIG', message: '身份服务地址配置无效，请联系部署管理员' }
    if (!this.token) return { ok: true, data: signedOut(!!this.endpoint) }
    const epoch = this.epoch
    const result = await this.request('/me')
    if (!result.ok && ['UNAUTHENTICATED', 'SESSION_EXPIRED', 'ACCOUNT_DISABLED'].includes(result.code)) return { ok: true, data: signedOut(!!this.endpoint) }
    if (result.ok && epoch === this.epoch && !this.livePaused) {
      const status = result.data as IdentityStatus
      const company = status.companies?.find((item) => item.id === status.actingOrgId)
      const next = status.account && company ? JSON.stringify([status.account.id, company.id, company.role]) : ''
      if (next !== this.liveContext) { this.liveContext = next; this.notifyLive() }
    }
    return result.ok ? { ok: true, data: { ...(result.data as object), configured: true } } : result
  }
  private async login(intent: string): Promise<IdentityResult> {
    if (this.pendingLogin) return { ok: false, code: 'CONFLICT', message: '已有登录窗口，请先完成或等待其超时' }
    this.pendingLogin = true
    const epoch = ++this.epoch
    try {
      const result = await this.request('/auth/begin', 'POST', { intent }, false)
      if (!result.ok) return result
      const { authorizationUrl, ticket } = result.data as { authorizationUrl: string; ticket: string }
      const url = new URL(authorizationUrl)
      this.validateExternal(url)
      await this.openExternal(url.href)
      const until = Date.now() + 10 * 60_000
      while (Date.now() < until && epoch === this.epoch) {
        await delay(1500)
        const poll = await this.request('/auth/poll', 'POST', { ticket }, false)
        if (!poll.ok) return poll
        const data = poll.data as { pending?: boolean; token?: string }
        if (data.token && /^[A-Za-z0-9_-]{43}$/.test(data.token)) {
          if (epoch !== this.epoch) break
          this.token = data.token
          return this.status()
        }
      }
      return { ok: false, code: 'AUTH_EXPIRED', message: '登录未完成或已取消，请重新登录' }
    } catch { return { ok: false, code: 'AUTH_FAILED', message: '无法打开或完成登录，请重试' } }
    finally { this.pendingLogin = false }
  }
  async identity(action: unknown, input?: unknown): Promise<IdentityResult> {
    const changesContext = typeof action === 'string' && ['login', 'register', 'recover', 'logout', 'revoke-all', 'select-company', 'create-company', 'accept-invitation'].includes(action)
    if (changesContext) { this.livePaused++; this.epoch++; this.clearLive() }
    try { return await this.performIdentity(action, input) }
    finally {
      if (changesContext) {
        this.livePaused--
        this.notifyLive()
      }
    }
  }
  private async performIdentity(action: unknown, input?: unknown): Promise<IdentityResult> {
    if (typeof action !== 'string') return { ok: false, code: 'INVALID_INPUT', message: '身份操作无效' }
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
    const id = typeof body.id === 'string' ? encodeURIComponent(body.id) : ''
    switch (action) {
      case 'status': return this.status()
      case 'login': case 'register': case 'recover': return this.login(action)
      case 'logout': {
        if (!this.token) { this.epoch++; return { ok: true, data: {} } }
        const result = await this.request('/logout', 'POST', {})
        if (result.ok) { this.token = null; this.epoch++ }
        return result
      }
      case 'account-security': {
        const result = await this.request('/account-security')
        if (!result.ok) return result
        try {
          const url = new URL((result.data as { url: string }).url)
          this.validateExternal(url)
          await this.openExternal(url.href)
          return { ok: true, data: {} }
        } catch { return { ok: false, code: 'INVALID_CONFIG', message: '无法打开账号安全页面，请检查身份服务配置' } }
      }
      case 'sessions': return this.request('/sessions')
      case 'revoke-session': return id ? this.request(`/sessions/${id}`, 'DELETE') : { ok: false, code: 'INVALID_INPUT', message: '缺少会话标识' }
      case 'revoke-all': {
        const result = await this.request('/sessions/revoke-all', 'POST', {})
        if (result.ok) { this.token = null; this.epoch++ }
        return result
      }
      case 'select-company': return this.request('/acting-company', 'POST', body)
      case 'create-company': return this.request('/companies', 'POST', body)
      case 'update-profile': return this.request('/me', 'PATCH', body)
      case 'members': case 'invitations': case 'my-invitations': {
        const result = await this.request(`/${action}`)
        return result.ok ? { ok: true, data: (result.data as Record<string, unknown>)[action === 'members' ? 'members' : 'invitations'] } : result
      }
      case 'partners': return this.request('/partners')
      case 'create-partner': return this.request('/partners', 'POST', { orgId: body.orgId })
      case 'partner-messages':
        return id ? this.request(`/partners/${id}/messages`) : { ok: false, code: 'INVALID_INPUT', message: '缺少合作关系标识' }
      case 'send-partner-message':
        return id ? this.request(`/partners/${id}/messages`, 'POST', { body: body.body }) : { ok: false, code: 'INVALID_INPUT', message: '缺少合作关系标识' }
      case 'accept-partner': case 'reject-partner': case 'withdraw-partner': case 'disconnect-partner':
        return id ? this.request(`/partners/${id}/${action.slice(0, -'-partner'.length)}`, 'POST', {}) : { ok: false, code: 'INVALID_INPUT', message: '缺少合作关系标识' }
      case 'invite': return this.request('/invitations', 'POST', body)
      case 'accept-invitation': case 'withdraw-invitation':
        return id ? this.request(`/invitations/${id}/${action === 'accept-invitation' ? 'accept' : 'withdraw'}`, 'POST', {}) : { ok: false, code: 'INVALID_INPUT', message: '缺少邀请标识' }
      case 'change-role': case 'remove-member':
        return id ? this.request(`/members/${id}`, action === 'change-role' ? 'PATCH' : 'DELETE', body) : { ok: false, code: 'INVALID_INPUT', message: '缺少成员标识' }
      case 'transfer-ownership': return this.request('/ownership', 'POST', body)
      default: return { ok: false, code: 'INVALID_INPUT', message: '未知身份操作' }
    }
  }
}
