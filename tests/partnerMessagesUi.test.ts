import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type {
  IdentityPartner,
  IdentityRole,
  IdentityStatus,
  PartnerMessage
} from '../src/shared/identity.ts'

const status = (orgId = 'org-a', role: IdentityRole = 'owner'): IdentityStatus => ({
  configured: true,
  account: { id: 'user-a', name: '测试成员', email: 'private@example.test' },
  actingOrgId: orgId,
  companies: [{ id: orgId, name: '当前企业', shortName: '当前', role }]
})
const partner = (
  id = 'relationship-a',
  state: IdentityPartner['status'] = 'accepted'
): IdentityPartner => ({
  id,
  requesterOrgId: 'org-a',
  recipientOrgId: 'org-b',
  partner: { id: 'org-b', name: '合作企业', shortName: '合作方' },
  status: state,
  revision: 1,
  createdAt: '2026-10-20T00:00:00Z'
})
const message = (body: string, relationshipId = 'relationship-a'): PartnerMessage => ({
  id: `message-${body}`,
  relationshipId,
  authorId: 'user-a',
  orgId: 'org-a',
  body,
  createdAt: '2026-10-20T01:00:00Z'
})
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

type HookResult = {
  messages: PartnerMessage[] | null
  loading: boolean
  error: string | null
  draft: string
  characterCount: number
  updateDraft: (text: string) => void
  send: () => Promise<void>
  sending: boolean
  sendError: string | null
  canSend: boolean
  reload: () => Promise<void>
}
type Element = {
  type: string
  props: {
    children?: unknown
    value?: string
    disabled?: boolean
    placeholder?: string
    subtitle?: string
    maxLength?: number
    onChange?: (event: { target: { value: string } }) => void
  }
}
function harness(
  identity: (action: string, body?: unknown) => Promise<unknown>,
  component = false
) {
  let cursor = 0
  const slots: { value?: unknown; deps?: unknown[]; cleanup?: () => void }[] = []
  const effects: (() => void)[] = []
  const timers = new Set<() => void>()
  const listeners = new Map<string, () => void>()
  const state = {
    mode: 'server',
    state: {} as object | null,
    choosingCompany: false,
    identityStatus: status(),
    identity
  }
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const react = {
    useRef(initial: unknown) {
      const i = cursor++
      if (!slots[i]) slots[i] = { value: { current: initial } }
      return slots[i].value
    },
    useState(initial: unknown) {
      const i = cursor++
      if (!slots[i]) slots[i] = { value: initial }
      return [
        slots[i].value,
        (value: unknown) => {
          slots[i].value = typeof value === 'function' ? value(slots[i].value) : value
        }
      ]
    },
    useCallback(callback: () => unknown, deps: unknown[]) {
      const i = cursor++
      if (!same(slots[i]?.deps, deps)) slots[i] = { value: callback, deps }
      return slots[i].value
    },
    useEffect(callback: () => (() => void) | undefined, deps: unknown[]) {
      const i = cursor++
      if (same(slots[i]?.deps, deps)) return
      const previous = slots[i]
      slots[i] = { deps }
      effects.push(() => {
        previous?.cleanup?.()
        slots[i].cleanup = callback()
      })
    }
  }
  const useApp = Object.assign((select: (value: typeof state) => unknown) => select(state), {
    getState: () => state
  })
  const nativeRequire = createRequire(import.meta.url)
  const module = {
    exports: {} as {
      usePartnerMessages: (item: IdentityPartner) => HookResult
      PartnerConversation: (props: { relationship: IdentityPartner }) => unknown
    }
  }
  runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('../src/renderer/src/pages/Contacts.tsx', import.meta.url), 'utf8'),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX
        }
      }
    ).outputText,
    {
      module,
      exports: module.exports,
      require: (name: string) =>
        name === 'react'
          ? react
          : name === '@/store'
            ? { useApp }
            : name === '@/components/ui'
              ? Object.fromEntries(
                  [
                    'Badge',
                    'Button',
                    'Card',
                    'CardHeader',
                    'Dialog',
                    'EmptyState',
                    'Field',
                    'Input',
                    'PageHeader',
                    'Textarea'
                  ].map((item) => [item, item])
                )
              : name === 'lucide-react'
                ? {}
                : nativeRequire(name),
      window: {
        addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
        removeEventListener: (name: string) => listeners.delete(name)
      },
      setInterval: (callback: () => void, milliseconds: number) => {
        assert.equal(milliseconds, 30_000)
        timers.add(callback)
        return callback
      },
      clearInterval: (callback: () => void) => timers.delete(callback)
    }
  )
  return {
    state,
    timers,
    listeners,
    render(item = partner()) {
      cursor = 0
      const result = module.exports.usePartnerMessages(item)
      effects.splice(0).forEach((effect) => effect())
      return result
    },
    nodes(item = partner()) {
      assert.equal(component, true)
      cursor = 0
      const nodes: Element[] = []
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk)
        else if (value && typeof value === 'object' && 'props' in value) {
          nodes.push(value as Element)
          walk((value as Element).props.children)
        }
      }
      walk(module.exports.PartnerConversation({ relationship: item }))
      effects.splice(0).forEach((effect) => effect())
      return nodes
    },
    unmount() {
      slots.forEach((slot) => slot.cleanup?.())
    }
  }
}

test('切换伙伴后丢弃迟到消息，且切回同一关系不会恢复旧响应', async () => {
  const stale = deferred<unknown>()
  let reads = 0
  const app = harness(async () =>
    ++reads === 1 ? stale.promise : { messages: [message(`latest-${reads}`)] }
  )
  app.render()
  app.render(partner('relationship-b'))
  await settle()
  assert.equal(app.render(partner('relationship-b')).messages?.[0].body, 'latest-2')
  app.render()
  await settle()
  stale.resolve({ messages: [message('private-old')] })
  await settle()
  assert.equal(app.render().messages?.[0].body, 'latest-3')
  app.unmount()
})

test('切企业、切账号和退出均隔离迟到消息并清除timer及事件监听', async () => {
  for (const action of ['switch', 'account', 'logout']) {
    const pending = deferred<unknown>()
    let reads = 0
    const app = harness(async () => (++reads === 1 ? pending.promise : null))
    app.render()
    assert.equal(app.timers.size, 1)
    if (action === 'switch') app.state.identityStatus = status('org-c')
    else if (action === 'account')
      app.state.identityStatus = {
        ...status(),
        account: { id: 'user-b', name: '另一成员', email: 'other@example.test' }
      }
    else {
      app.state.identityStatus = { ...status(), account: null, actingOrgId: null }
      app.state.state = null
    }
    app.render()
    pending.resolve({ messages: [message('old-enterprise')] })
    await settle()
    assert.equal(app.render().messages, null)
    app.unmount()
    assert.equal(app.timers.size, 0)
    assert.equal(app.listeners.size, 0)
  }
})

test('发送失败保留草稿，发送中续写成功后也不被清空，禁止重复发送', async () => {
  let response: unknown = null
  let pending: ReturnType<typeof deferred<unknown>> | null = null
  const sent: unknown[] = []
  const app = harness(async (action, body) => {
    if (action === 'partner-messages') return { messages: [] }
    sent.push(body)
    return pending ? pending.promise : response
  })
  app.render()
  await settle()
  app.render().updateDraft('第一条消息')
  await app.render().send()
  assert.equal(app.render().draft, '第一条消息')
  assert.match(app.render().sendError ?? '', /保留草稿/)
  pending = deferred<unknown>()
  const start = app.render().send()
  void app.render().send()
  app.render().updateDraft('第一条消息，续写保留')
  pending.resolve({ message: message('第一条消息') })
  await start
  assert.equal(app.render().draft, '第一条消息，续写保留')
  assert.equal(sent.length, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1])), {
    id: 'relationship-a',
    body: '第一条消息'
  })
  pending = null
  response = { message: message('第一条消息，续写保留') }
  await app.render().send()
  assert.equal(app.render().draft, '')
  app.unmount()
})

test('发送中切换关系后旧成功不会清空新草稿或改变新发送状态', async () => {
  const old = deferred<unknown>()
  const app = harness(async (action) =>
    action === 'partner-messages' ? { messages: [] } : old.promise
  )
  app.render()
  await settle()
  app.render().updateDraft('旧会话草稿')
  const sending = app.render().send()
  app.render(partner('relationship-b'))
  app.render(partner('relationship-b')).updateDraft('新会话草稿')
  old.resolve({ message: message('旧会话草稿') })
  await sending
  assert.equal(app.render(partner('relationship-b')).draft, '新会话草稿')
  assert.equal(app.render(partner('relationship-b')).sending, false)
  app.unmount()
})

test('finance和legal可发送，readonly或断开合作禁止发送，pending不读取会话', async () => {
  for (const role of ['finance', 'legal', 'readonly'] as const) {
    let sent = 0
    const app = harness(async (action) => {
      if (action === 'send-partner-message') sent++
      return action === 'partner-messages' ? { messages: [] } : { message: message('测试消息') }
    })
    app.state.identityStatus = status('org-a', role)
    app.render()
    await settle()
    app.render().updateDraft('测试消息')
    await app.render().send()
    assert.equal(sent, role === 'readonly' ? 0 : 1)
    assert.equal(app.render(partner('relationship-a', 'disconnected')).canSend, false)
    app.unmount()
  }
  let reads = 0
  const app = harness(async () => {
    reads++
    return { messages: [] }
  })
  assert.equal(app.render(partner('pending', 'pending')).canSend, false)
  await settle()
  assert.equal(reads, 0)
  app.unmount()
})

test('消息超长不发出；focus和定时轮询更新，失败显示错误和重试', async () => {
  let fail = true
  let sent = 0
  const app = harness(async (action) => {
    if (action === 'send-partner-message') sent++
    return fail ? null : { messages: [message('最新消息')] }
  })
  app.render()
  await settle()
  assert.match(app.render().error ?? '', /未能加载/)
  app.render().updateDraft('字'.repeat(10_001))
  await app.render().send()
  assert.equal(sent, 0)
  fail = false
  app.listeners.forEach((callback) => callback())
  await settle()
  assert.equal(app.render().messages?.[0].body, '最新消息')
  app.timers.forEach((callback) => callback())
  await settle()
  assert.equal(app.render().error, null)
  app.unmount()
})

test('消息按去除首尾空白后的Unicode码点计数，支持5001及10000个emoji并拒绝10001个', async () => {
  const supplementary = String.fromCodePoint(0x1f600)
  const sent: { body: string }[] = []
  const app = harness(async (action, body) => {
    if (action === 'partner-messages') return { messages: [] }
    sent.push(body as { body: string })
    return { message: message('成功') }
  })
  app.render()
  await settle()
  for (const count of [1, 5_001, 10_000, 10_001]) {
    const draft = ` \n${supplementary.repeat(count)}\t `
    const before = sent.length
    app.render().updateDraft(draft)
    assert.equal(app.render().characterCount, count)
    await app.render().send()
    assert.equal(sent.length, before + (count <= 10_000 ? 1 : 0))
    if (count <= 10_000) {
      assert.equal(sent.at(-1)?.body, draft)
      assert.equal(app.render().draft, '')
    } else assert.equal(app.render().draft, draft)
  }
  app.render().updateDraft(' \n\t ')
  assert.equal(app.render().characterCount, 0)
  const before = sent.length
  await app.render().send()
  assert.equal(sent.length, before)
  app.unmount()
})

test('实际输入框不按UTF-16截断，Unicode计数与发送禁用及超限提示一致', async () => {
  const app = harness(async () => ({ messages: [] }), true)
  app.nodes()
  await settle()
  for (const count of [5_001, 10_000, 10_001]) {
    let nodes = app.nodes()
    const input = nodes.find((node) => node.type === 'Textarea')!
    assert.equal(input.props.maxLength, undefined)
    const draft = ` ${String.fromCodePoint(0x1f600).repeat(count)} `
    input.props.onChange?.({ target: { value: draft } })
    nodes = app.nodes()
    assert.equal(nodes.find((node) => node.type === 'Textarea')?.props.value, draft)
    assert.equal(
      nodes.find((node) => node.type === 'Button' && node.props.children === '发送消息')?.props
        .disabled,
      count > 10_000
    )
    assert.ok(
      nodes.some(
        (node) =>
          node.type === 'span' &&
          JSON.stringify(node.props.children) ===
            JSON.stringify([count.toLocaleString(), ' / 10,000'])
      )
    )
    assert.equal(JSON.stringify(nodes).includes('消息超过 10,000 个字符'), count > 10_000)
  }
  app.unmount()
})

test('实时失效通知刷新消息但不清空草稿，切企业后旧通知响应无效', async () => {
  const stale = deferred<unknown>()
  let reads = 0
  const app = harness(async () =>
    ++reads === 3 ? stale.promise : { messages: [message(`最新-${reads}`)] }
  )
  app.render()
  await settle()
  app.render().updateDraft('保留正在编辑的消息')
  assert.ok(app.listeners.has('nexus:invalidate'))
  app.listeners.get('nexus:invalidate')?.()
  await settle()
  assert.equal(app.render().messages?.[0].body, '最新-2')
  assert.equal(app.render().draft, '保留正在编辑的消息')
  app.listeners.get('nexus:invalidate')?.()
  app.state.identityStatus = status('org-c')
  app.render()
  await settle()
  stale.resolve({ messages: [message('旧企业消息')] })
  await settle()
  assert.equal(app.render().messages?.[0].body, '最新-4')
  app.unmount()
  assert.equal(app.listeners.size, 0)
})

test('实际会话组件标识最近100条和企业侧时间，不呈现邮箱，断开历史只读', async () => {
  const app = harness(async () => ({ messages: [message('保留换行\n的正文')] }), true)
  app.nodes()
  await settle()
  const nodes = app.nodes()
  assert.ok(
    nodes.some((node) => node.type === 'CardHeader' && node.props.subtitle?.includes('100'))
  )
  assert.ok(nodes.some((node) => node.type === 'time'))
  const text = JSON.stringify(nodes)
  assert.match(text, /我方/)
  assert.match(text, /保留换行/)
  assert.doesNotMatch(text, /private@example/)
  assert.ok(nodes.some((node) => node.type === 'Textarea'))
  assert.equal(
    app.nodes(partner('relationship-a', 'disconnected')).some((node) => node.type === 'Textarea'),
    false
  )
  app.unmount()
})
