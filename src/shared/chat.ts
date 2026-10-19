// Nexus conversations: limits, helpers and the runtime adapter boundary.
//
// The runtime is whatever eventually answers a message (a model API, DeepSeek Harness,
// something else). This build ships without one. The boundary exists so that wiring a
// runtime later changes one object in the main process, not the data model or the UI.
//
// Two rules hold regardless of which runtime is plugged in:
// - A runtime never writes business data or company memory directly. Anything it wants
//   to change must come back through NexusService and be checked there.
// - When no runtime is connected, Nexus says so. It never fabricates an answer.

import type { ChatRole, Conversation } from './types.ts'

export const CHAT_MESSAGE_MAX = 4000
export const CHAT_TITLE_MAX = 60
const AUTO_TITLE_LENGTH = 24

export interface RuntimeRequest {
  conversationId: string
  userId: string
  text: string
}

export interface RuntimeReply {
  /** 'system' for status notices, 'assistant' only for real runtime output. */
  role: Exclude<ChatRole, 'user'>
  body: string
  /** Identifier of the runtime that produced the reply. */
  runtime: string
}

export interface NexusRuntime {
  id: string
  connected: boolean
  reply(req: RuntimeRequest): Promise<RuntimeReply>
}

export const NOT_CONNECTED_NOTICE =
  '尚未连接 AI。你的消息已保存在本会话中，但 Nexus 目前不会生成回答，也不会据此修改任何业务数据。可以先通过下方入口直接处理相关业务。'

/** The runtime used when nothing is connected: an honest status notice, nothing more. */
export const NO_RUNTIME: NexusRuntime = {
  id: 'none',
  connected: false,
  reply: async () => ({ role: 'system', body: NOT_CONNECTED_NOTICE, runtime: 'none' })
}

/** Title taken from the first message so the history list is readable. */
export function conversationTitle(firstMessage: string): string {
  const flat = firstMessage.replace(/\s+/g, ' ').trim()
  if (!flat) return '新对话'
  return flat.length > AUTO_TITLE_LENGTH ? `${flat.slice(0, AUTO_TITLE_LENGTH)}…` : flat
}

/** Newest first, optionally filtered by a case-insensitive title match. */
export function searchConversations(conversations: Conversation[], query: string): Conversation[] {
  const needle = query.trim().toLowerCase()
  return conversations
    .filter((c) => !needle || c.title.toLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
