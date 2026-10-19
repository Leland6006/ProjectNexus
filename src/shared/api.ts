// The only surface the renderer may call. Names double as an allowlist in the main process.

import type { ViewState } from './types.ts'

export const API_METHODS = [
  'getState',
  'switchUser',
  'setRepresentingOrg',
  'resetDemo',
  'createTransaction',
  'updateTransaction',
  'inviteCounterparty',
  'acceptInvitation',
  'grantCounsel',
  'createContract',
  'shareContract',
  'updateClauses',
  'updatePaymentTerms',
  'runAgents',
  'approveProposal',
  'rejectProposal',
  'confirmClaim',
  'saveVersion',
  'restoreVersion',
  'confirmFinal',
  'addComment',
  'createSuggestion',
  'resolveSuggestion',
  'sendMessage',
  'createMilestone',
  'updateMilestone',
  'startConversation',
  'sendChatMessage',
  'renameConversation'
] as const

export type ApiMethod = (typeof API_METHODS)[number]

export type ApiResult = { ok: true; state: ViewState } | { ok: false; code: string; message: string }

export interface NexusBridge {
  call(method: ApiMethod, ...args: unknown[]): Promise<ApiResult>
}
