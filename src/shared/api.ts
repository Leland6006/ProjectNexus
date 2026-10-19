// The only surface the renderer may call. Names double as an allowlist in the main process.

import type { ViewState } from './types.ts'

export const API_METHODS = [
  'getState',
  'saveCashPlan',
  'cancelCashPlan',
  'recordCashEntry',
  'voidCashEntry',
  'saveInvoiceCase',
  'advanceInvoiceCase',
  'createCounterparty',
  'selectContractImport',
  'confirmContractImport',
  'requestInternalReview',
  'decideInternalReview',
  'pauseAnalysis',
  'resumeAnalysis',
  'createTask',
  'updateTask',
  'completeTaskStep',
  'updateCompanyProfile',
  'confirmProfileUpdate',
  'saveCashAccount',
  'saveCostItem',
  'configureAi',
  'disconnectAi',
  'cancelChat',
  'retryChat',
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

export type ApiResult = { ok: true; state: ViewState; notice?: string } | { ok: false; code: string; message: string }

export interface ChatProgress {
  userId: string
  conversationId: string
  body: string
  stage: 'start' | 'delta' | 'end'
  state?: ViewState
}

export interface NexusBridge {
  onWorkflowProgress: (listener: (state: ViewState) => void) => () => void
  onChatProgress: (listener: (event: ChatProgress) => void) => () => void
  call(method: ApiMethod, ...args: unknown[]): Promise<ApiResult>
}
