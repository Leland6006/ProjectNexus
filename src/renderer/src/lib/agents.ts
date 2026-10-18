import { proposalSignature } from '@shared/proposalView'
import type { Proposal } from '@shared/types'
import { useApp } from '@/store'

function pendingSignatures(proposals: Proposal[]): Set<string> {
  return new Set(proposals.filter((p) => p.status === 'pending').map(proposalSignature))
}

/**
 * Runs the agent graph for one transaction and reports what actually changed.
 *
 * Re-running refreshes the pending draft instead of adding another one, so "nothing new"
 * has to be judged from the content, not from the number of rows.
 */
export async function runAgentAnalysis(transactionId: string): Promise<void> {
  const store = useApp.getState()
  const before = pendingSignatures(store.state?.proposals ?? [])
  if (!(await store.act('runAgents', [transactionId]))) return

  const after = (useApp.getState().state?.proposals ?? []).filter((p) => p.status === 'pending')
  const fresh = after.filter((p) => !before.has(proposalSignature(p)))
  const toast = useApp.getState().toast
  if (before.size === 0 && after.length > 0) toast('success', `已生成 ${after.length} 条待确认建议`)
  else if (fresh.length > 0) toast('success', '建议已根据最新条款更新')
  else if (after.length > 0) toast('info', '条款没有新的变化，结论与之前一致')
  else toast('info', '未检测到需要协同分析的经营变化')
}
