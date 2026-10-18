// Maps allowlisted API method names to service calls. The acting user is held here in the
// main process, so the renderer can never claim to be someone else on a per-call basis.
// (Still a DEMO: switching accounts is unauthenticated by design.)

import { buildViewState } from '../shared/permissions.ts'
import { createSeedDatabase, DEFAULT_USER_ID } from '../shared/seed.ts'
import { NexusService, type ActorContext } from '../shared/service.ts'
import type { ApiMethod, ApiResult } from '../shared/api.ts'
import { API_METHODS } from '../shared/api.ts'
import { NexusError, type Database } from '../shared/types.ts'

export interface Session {
  service: NexusService
  currentUserId: string
  /**
   * Organisation an external counsel is acting for, null for everybody else. A counsel
   * granted by both parties must pick one; see permissions.effectiveOrgId.
   * The service reads through the same object, so both stay in sync.
   */
  actor: ActorContext
}

export function createSession(db: Database, currentUserId: string, onChange: (s: Session) => void): Session {
  const session: Session = {
    service: null as unknown as NexusService,
    currentUserId,
    actor: { representingOrgId: null }
  }
  session.service = new NexusService(db, () => onChange(session), undefined, session.actor)
  return session
}

function str(v: unknown): string {
  if (typeof v !== 'string') throw new NexusError('INVALID_INPUT', '参数无效')
  return v
}

function obj<T>(v: unknown): T {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new NexusError('INVALID_INPUT', '参数无效')
  return v as T
}

export function handleCall(session: Session, method: unknown, args: unknown[]): ApiResult {
  try {
    if (typeof method !== 'string' || !(API_METHODS as readonly string[]).includes(method)) {
      throw new NexusError('INVALID_INPUT', '未知操作')
    }
    const s = session.service
    const me = session.currentUserId
    const m = method as ApiMethod
    switch (m) {
      case 'getState':
        break
      case 'switchUser': {
        const id = str(args[0])
        if (!s.db.users.some((u) => u.id === id)) throw new NexusError('NOT_FOUND', '账号不存在')
        session.currentUserId = id
        // A different account cannot inherit the previous one's delegated authority.
        session.actor.representingOrgId = null
        s.notifyChanged()
        break
      }
      case 'setRepresentingOrg': {
        const orgId = args[0] === null || args[0] === undefined ? null : str(args[0])
        const user = s.db.users.find((u) => u.id === me)
        if (!user || user.role !== 'external_counsel') {
          throw new NexusError('PERMISSION_DENIED', '只有外部律师可以切换代表的委托方')
        }
        if (orgId !== null) {
          const granted = s.db.transactions.some((t) =>
            t.counselGrants.some((g) => g.userId === me && g.grantedByOrgId === orgId)
          )
          if (!granted) throw new NexusError('PERMISSION_DENIED', '该律师未被此企业授权')
        }
        session.actor.representingOrgId = orgId
        s.notifyChanged()
        break
      }
      case 'resetDemo': {
        const fresh = createSeedDatabase()
        Object.assign(s.db, fresh)
        session.currentUserId = DEFAULT_USER_ID
        session.actor.representingOrgId = null
        s.notifyChanged()
        break
      }
      case 'createTransaction':
        s.createTransaction(me, obj(args[0]))
        break
      case 'updateTransaction':
        s.updateTransaction(me, str(args[0]), obj(args[1]))
        break
      case 'inviteCounterparty':
        s.inviteCounterparty(me, str(args[0]))
        break
      case 'acceptInvitation':
        s.acceptInvitation(me, str(args[0]))
        break
      case 'grantCounsel':
        s.grantCounsel(me, str(args[0]), str(args[1]))
        break
      case 'createContract':
        s.createContract(me, str(args[0]), str(args[1]), args[2] === undefined ? undefined : str(args[2]))
        break
      case 'shareContract':
        s.shareContract(me, str(args[0]))
        break
      case 'updateClauses':
        if (!Array.isArray(args[1])) throw new NexusError('INVALID_INPUT', '参数无效')
        s.updateClauses(me, str(args[0]), args[1])
        break
      case 'saveVersion':
        s.saveVersion(me, str(args[0]), str(args[1]), args[2] === undefined ? '' : str(args[2]))
        break
      case 'restoreVersion':
        s.restoreVersion(me, str(args[0]), str(args[1]))
        break
      case 'confirmFinal':
        s.confirmFinal(me, str(args[0]), str(args[1]))
        break
      case 'addComment': {
        const vis = str(args[3])
        if (vis !== 'shared' && vis !== 'internal' && vis !== 'counsel') throw new NexusError('INVALID_INPUT', '参数无效')
        s.addComment(me, str(args[0]), str(args[1]), str(args[2]), vis, args[4] == null ? null : str(args[4]))
        break
      }
      case 'createSuggestion':
        s.createSuggestion(me, str(args[0]), str(args[1]), str(args[2]), str(args[3]))
        break
      case 'resolveSuggestion':
        s.resolveSuggestion(me, str(args[0]), args[1] === true)
        break
      case 'sendMessage': {
        const vis = str(args[2])
        if (vis !== 'shared' && vis !== 'internal') throw new NexusError('INVALID_INPUT', '参数无效')
        s.sendMessage(me, str(args[0]), str(args[1]), vis)
        break
      }
      case 'createMilestone':
        s.createMilestone(me, obj(args[0]))
        break
      case 'updateMilestone':
        s.updateMilestone(me, str(args[0]), obj(args[1]))
        break
    }
    return {
      ok: true,
      state: buildViewState(s.db, session.currentUserId, {
        representingOrgId: session.actor.representingOrgId,
        // Local demo only: hand the renderer every account so it can switch between them.
        demoDirectory: true
      })
    }
  } catch (err) {
    if (err instanceof NexusError) return { ok: false, code: err.code, message: err.message }
    console.error('[handlers] unexpected error', err)
    return { ok: false, code: 'INTERNAL', message: '操作失败，请重试' }
  }
}
