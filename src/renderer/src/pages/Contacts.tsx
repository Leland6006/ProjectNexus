import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, RefreshCw, Users } from 'lucide-react'
import type { IdentityPartner, IdentityPartners, IdentityPartnerStatus, PartnerMessage, PartnerMessages } from '@shared/identity'
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Textarea } from '@/components/ui'
import { useApp } from '@/store'

const STATUS_LABEL: Record<IdentityPartnerStatus, string> = {
  pending: '待确认', accepted: '已建立合作', rejected: '已拒绝', withdrawn: '已撤回', disconnected: '已断开'
}
const ACTION_LABEL = { accept: '接受申请', reject: '拒绝申请', withdraw: '撤回申请', disconnect: '断开合作' }
type PartnerAction = keyof typeof ACTION_LABEL

function partnerScope(): string | null {
  const state = useApp.getState()
  const status = state.identityStatus
  if (state.mode !== 'server' || !state.state || state.choosingCompany || !status?.account || !status.actingOrgId) return null
  const company = status.companies.find((item) => item.id === status.actingOrgId)
  return company ? JSON.stringify([status.account.id, company.id, company.role]) : null
}

// 列表和候选共用同一读取规则，响应只能写回发起请求时的企业作用域。
export function usePartners() {
  const mode = useApp((s) => s.mode)
  const status = useApp((s) => s.identityStatus)
  const choosingCompany = useApp((s) => s.choosingCompany)
  const hasState = useApp((s) => !!s.state)
  const identity = useApp((s) => s.identity)
  const scope = partnerScope()
  const epoch = useRef(0)
  const accepted = useRef<string | null>(null)
  const [result, setResult] = useState<{ scope: string | null; partners: IdentityPartner[] | null; loading: boolean; error: string | null }>({ scope: null, partners: null, loading: false, error: null })
  const reload = useCallback(async () => {
    if (!scope || partnerScope() !== scope) return
    const request = ++epoch.current
    setResult((previous) => ({ scope, partners: previous.scope === scope ? previous.partners : null, loading: true, error: null }))
    const data = await identity<IdentityPartners>('partners')
    if (request !== epoch.current || partnerScope() !== scope) return
    if (data === null || !Array.isArray(data.partners)) {
      setResult((previous) => ({ scope, partners: previous.scope === scope ? previous.partners : null, loading: false, error: '未能加载企业联系人，请重试。' }))
      return
    }
    setResult({ scope, partners: data.partners, loading: false, error: null })
    const signature = JSON.stringify(data.partners.filter((item) => item.status === 'accepted').map((item) => item.partner.id).sort())
    const previous = accepted.current
    accepted.current = signature
    if (signature !== previous && (previous !== null || signature !== '[]')) await useApp.getState().refreshIdentity()
  }, [scope, identity])
  useEffect(() => {
    accepted.current = null
    void reload()
    if (!scope) return
    const timer = setInterval(() => void reload(), 30_000)
    const onFocus = () => void reload()
    window.addEventListener('focus', onFocus)
    window.addEventListener('nexus:invalidate', onFocus)
    return () => { ++epoch.current; clearInterval(timer); window.removeEventListener('focus', onFocus); window.removeEventListener('nexus:invalidate', onFocus) }
  }, [reload, scope, mode, status?.account?.id, status?.actingOrgId, choosingCompany, hasState])
  const current = scope !== null && result.scope === scope
  return { partners: current ? result.partners : null, loading: current ? result.loading : scope !== null, error: current ? result.error : null, reload }
}

export function usePartnerMessages(relationship: IdentityPartner) {
  const status = useApp((s) => s.identityStatus)
  const mode = useApp((s) => s.mode)
  const hasState = useApp((s) => !!s.state)
  const choosingCompany = useApp((s) => s.choosingCompany)
  const identity = useApp((s) => s.identity)
  const company = status?.companies.find((item) => item.id === status.actingOrgId)
  const scope = partnerScope()
  const readable = relationship.status === 'accepted' || relationship.status === 'disconnected'
  const key = scope && readable ? JSON.stringify([scope, relationship.id]) : null
  const current = useRef(key)
  current.current = key
  const session = useRef(0)
  const epoch = useRef(0)
  const locked = useRef(false)
  const draftVersion = useRef(0)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [result, setResult] = useState<{ key: string | null; messages: PartnerMessage[] | null; loading: boolean; error: string | null }>({ key: null, messages: null, loading: false, error: null })
  const matches = () => key !== null && current.current === key && partnerScope() === scope
  const reload = useCallback(async () => {
    if (!key || partnerScope() !== scope || current.current !== key) return
    const request = ++epoch.current
    setResult((previous) => ({ key, messages: previous.key === key ? previous.messages : null, loading: true, error: null }))
    const data = await identity<PartnerMessages>('partner-messages', { id: relationship.id })
    if (request !== epoch.current || current.current !== key || partnerScope() !== scope) return
    setResult(data !== null && Array.isArray(data.messages)
      ? { key, messages: data.messages, loading: false, error: null }
      : { key, messages: null, loading: false, error: '未能加载企业会话，请重试。' })
  }, [key, scope, relationship.id, identity])
  useEffect(() => {
    ++session.current; current.current = key
    setDraft(''); ++draftVersion.current; setSendError(null); setSending(false); locked.current = false
    void reload()
    if (!key) return
    const timer = setInterval(() => void reload(), 30_000)
    const onFocus = () => void reload()
    window.addEventListener('focus', onFocus)
    window.addEventListener('nexus:invalidate', onFocus)
    return () => { ++session.current; ++epoch.current; current.current = null; clearInterval(timer); window.removeEventListener('focus', onFocus); window.removeEventListener('nexus:invalidate', onFocus) }
  }, [reload, key, mode, status?.account?.id, status?.actingOrgId, choosingCompany, hasState])
  const canSend = !!key && relationship.status === 'accepted' && !!company && company.role !== 'readonly'
  const characterCount = [...draft.trim()].length
  const updateDraft = (text: string) => { ++draftVersion.current; setDraft(text); setSendError(null) }
  const send = async () => {
    if (!canSend || locked.current || !matches() || characterCount === 0 || characterCount > 10_000) return
    const version = draftVersion.current
    const sendingSession = session.current
    const active = () => sendingSession === session.current && matches()
    locked.current = true; setSending(true); setSendError(null)
    try {
      const data = await identity<{ message: PartnerMessage }>('send-partner-message', { id: relationship.id, body: draft })
      if (!active()) return
      if (data === null) { setSendError('消息发送失败，已保留草稿，请重试。'); return }
      if (draftVersion.current === version) setDraft('')
      await reload()
    } finally { if (active()) { locked.current = false; setSending(false) } }
  }
  const visible = key !== null && result.key === key
  return { messages: visible ? result.messages : null, loading: visible ? result.loading : !!key, error: visible ? result.error : null, draft, characterCount, updateDraft, send, sending, sendError, canSend, reload }
}

export function PartnerConversation({ relationship }: { relationship: IdentityPartner }) {
  const status = useApp((s) => s.identityStatus)
  const orgId = status?.actingOrgId
  const company = status?.companies.find((item) => item.id === orgId)
  const { messages, loading, error, draft, characterCount, updateDraft, send, sending, sendError, canSend, reload } = usePartnerMessages(relationship)
  return <Card>
    <CardHeader title={`与 ${relationship.partner.name} 的企业会话`} subtitle="显示最近 100 条消息；无需交易项目即可沟通。消息对双方企业成员可见。" action={<Button size="sm" disabled={loading} onClick={() => void reload()}>刷新会话</Button>} />
    {error ? <div role="alert"><EmptyState title="会话加载失败" hint={error} action={<Button onClick={() => void reload()}>重试</Button>} /></div> : messages === null ? <p className="p-4 text-sm text-ink-500" role="status">正在加载企业会话…</p> : messages.length === 0 ? <EmptyState title="暂无企业消息" hint={relationship.status === 'accepted' ? '发送第一条消息，开始企业间沟通。' : '这段合作关系尚无历史消息。'} /> : <ol className="max-h-96 space-y-3 overflow-y-auto p-4" aria-label="企业消息" aria-busy={loading}>
      {messages.map((message) => <li key={message.id} className={`rounded-md border p-3 ${message.orgId === orgId ? 'border-brand-100 bg-brand-50' : 'border-slate-100 bg-slate-50'}`}>
        <p className="mb-1 text-xs text-ink-500">{message.orgId === orgId ? `我方 · ${company?.shortName || company?.name || '当前企业'}` : `对方 · ${relationship.partner.shortName || relationship.partner.name}`} · <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString('zh-CN')}</time></p>
        <p className="whitespace-pre-wrap break-words text-sm text-ink-900">{message.body}</p>
      </li>)}
    </ol>}
    <div className="space-y-3 border-t border-slate-100 p-4">
      {relationship.status === 'disconnected' ? <p className="text-sm text-ink-500">合作已断开，可查看本次合作的历史消息，不能继续发送。重新合作后将建立新的会话记录。</p> : !canSend ? <p className="text-sm text-ink-500">当前角色仅可阅读企业会话，不能发送消息。</p> : <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void send() }}>
        <Field label="发送企业消息" hint="消息最多 10,000 个 Unicode 字符（忽略首尾空白）；发送后双方企业成员可见。"><Textarea value={draft} onChange={(event) => updateDraft(event.target.value)} placeholder="输入发给合作企业的消息" /></Field>
        {characterCount > 10_000 && <p role="alert" className="text-xs text-rose-700">消息超过 10,000 个字符，请缩短后发送。</p>}
        {sendError && <p role="alert" className="text-xs text-rose-700">{sendError}</p>}
        <div className="flex items-center justify-between"><span className="text-xs text-ink-500">{characterCount.toLocaleString()} / 10,000</span><Button variant="primary" type="submit" loading={sending} disabled={characterCount === 0 || characterCount > 10_000}>发送消息</Button></div>
      </form>}
    </div>
  </Card>
}

export default function Contacts() {
  const mode = useApp((s) => s.mode)
  const status = useApp((s) => s.identityStatus)
  const company = status?.companies.find((item) => item.id === status.actingOrgId)
  if (mode !== 'server') return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader title="好友与联系人" subtitle="企业之间的合作关系与申请记录" />
      <Card><EmptyState icon={<Users className="h-7 w-7" />} title="企业联系人需要真实账号模式" hint="演示模式不创建或模拟好友关系。连接身份服务并登录企业后，可通过企业 ID 申请合作。" /></Card>
    </div>
  )
  if (!company || !status?.account) return <EmptyState title="请先选择企业" hint="登录并选择当前企业后，可查看企业联系人。" />
  return <CompanyContacts key={`${status.account.id}:${company.id}:${company.role}`} />
}

function CompanyContacts() {
  const status = useApp((s) => s.identityStatus)
  const identity = useApp((s) => s.identity)
  const busy = useApp((s) => s.busy)
  const toast = useApp((s) => s.toast)
  const company = status?.companies.find((item) => item.id === status.actingOrgId)
  const canManage = company && ['owner', 'admin', 'business'].includes(company.role)
  const { partners, loading, error, reload } = usePartners()
  const [orgId, setOrgId] = useState('')
  const [working, setWorking] = useState(false)
  const [confirmation, setConfirmation] = useState<IdentityPartner | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = partners?.find((item) => item.id === selectedId && ['accepted', 'disconnected'].includes(item.status))
  const locked = useRef(false)
  const scope = partnerScope()
  const mutate = async (action: 'create' | PartnerAction, item?: IdentityPartner) => {
    if (locked.current || busy || !canManage || !scope || partnerScope() !== scope) return
    const target = orgId.trim()
    if (action === 'create' && (!target || target === company?.id)) return
    locked.current = true
    setWorking(true)
    try {
      const data = await identity(`${action}-partner`, action === 'create' ? { orgId: target } : { id: item?.id })
      if (partnerScope() !== scope || data === null) return
      if (action === 'create') setOrgId('')
      setConfirmation(null)
      toast('success', action === 'create' ? '合作申请已发送，等待对方企业确认' : `${ACTION_LABEL[action]}成功`)
      if (action === 'accept' || action === 'disconnect') await useApp.getState().refreshIdentity()
      if (partnerScope() === scope) await reload()
    } finally {
      locked.current = false
      if (partnerScope() === scope) setWorking(false)
    }
  }
  const copyId = async () => {
    if (!company) return
    try { await navigator.clipboard.writeText(company.id); if (partnerScope() === scope) toast('success', '企业 ID 已复制') }
    catch { if (partnerScope() === scope) toast('error', '复制失败，请手动选择企业 ID 复制') }
  }
  const disabled = busy || working || loading
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <PageHeader title="好友与联系人" subtitle="由企业双方确认合作，接受后可发起交易项目" actions={<Button disabled={disabled} onClick={() => void reload()}><RefreshCw className="h-4 w-4" />刷新</Button>} />
      <Card>
        <CardHeader title={company?.name ?? '当前企业'} subtitle="将企业 ID 分享给合作方，对方可向当前企业申请合作。" />
        <div className="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-48 flex-1"><Field label="当前企业 ID"><Input readOnly value={company?.id ?? ''} onFocus={(event) => event.target.select()} /></Field></div>
          <Button onClick={() => void copyId()}><Copy className="h-4 w-4" />复制企业 ID</Button>
        </div>
      </Card>
      {canManage ? <Card>
        <CardHeader title="申请企业合作" subtitle="请向合作方确认其企业 ID，申请须由对方企业接受后生效。" />
        <form className="flex flex-wrap items-end gap-3 p-4" onSubmit={(event) => { event.preventDefault(); void mutate('create') }}>
          <div className="min-w-48 flex-1"><Field label="对方企业 ID"><Input required maxLength={128} value={orgId} disabled={working} onChange={(event) => setOrgId(event.target.value)} placeholder="粘贴对方提供的企业 ID" /></Field></div>
          <Button type="submit" variant="primary" loading={working} disabled={disabled || !orgId.trim() || orgId.trim() === company?.id}>发送合作申请</Button>
          {orgId.trim() === company?.id && <p role="alert" className="w-full text-xs text-rose-700">不能向当前企业申请合作。</p>}
        </form>
      </Card> : <p className="text-sm text-ink-500">所有成员均可查看联系人；仅企业所有者、管理员和业务成员可管理合作关系。</p>}
      <Card>
        <CardHeader title="企业合作关系" subtitle="待确认申请可接受、拒绝或撤回。已建立的合作可由任一方断开，历史交易仍按原有权限访问。" />
        {error ? <div role="alert"><EmptyState title="联系人加载失败" hint={error} action={<Button disabled={disabled} onClick={() => void reload()}>重试</Button>} /></div> : partners === null ? <div className="p-6 text-sm text-ink-500" role="status">正在加载企业联系人…</div> : partners.length === 0 ? <EmptyState title="尚无企业合作关系" hint="分享当前企业 ID，或输入对方企业 ID 发起申请。双方确认后即可创建交易。" /> : <ul className="divide-y divide-slate-100" aria-busy={loading}>
          {partners.map((item) => {
            const outgoing = item.requesterOrgId === company?.id
            const actions: PartnerAction[] = item.status === 'pending' ? outgoing ? ['withdraw'] : ['accept', 'reject'] : item.status === 'accepted' ? ['disconnect'] : []
            return <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">{item.partner.name} <Badge tone={item.status === 'accepted' ? 'green' : item.status === 'pending' ? 'amber' : 'gray'}>{STATUS_LABEL[item.status]}</Badge></p>
                <p className="break-all text-xs text-ink-500">企业 ID：{item.partner.id}</p>
                <p className="text-xs text-ink-500">{outgoing ? '我方发起' : '对方发起'} · {new Date(item.createdAt).toLocaleString('zh-CN')}{item.status === 'pending' ? outgoing ? ' · 等待对方确认' : ' · 等待我方确认' : ['rejected', 'withdrawn', 'disconnected'].includes(item.status) ? ' · 如需合作，可重新发起申请' : ''}</p>
              </div>
              <div className="flex gap-2">{['accepted', 'disconnected'].includes(item.status) && <Button size="sm" disabled={working} onClick={() => setSelectedId(item.id)}>{selectedId === item.id ? '当前会话' : item.status === 'disconnected' ? '查看历史消息' : '企业会话'}</Button>}{canManage && actions.map((action) => <Button key={action} size="sm" variant={action === 'accept' ? 'primary' : 'secondary'} disabled={disabled} onClick={() => action === 'disconnect' ? setConfirmation(item) : void mutate(action, item)}>{ACTION_LABEL[action]}</Button>)}</div>
            </li>
          })}
        </ul>}
      </Card>
      {selected && <PartnerConversation key={`${scope}:${selected.id}`} relationship={selected} />}
      <Dialog open={confirmation !== null} onClose={() => { if (!working) setConfirmation(null) }} title="断开企业合作">
        <p className="text-sm">确认断开与 {confirmation?.partner.name} 的合作？断开后双方不能新建交易；已有交易与合同仍按原有权限访问。</p>
        <div className="mt-4 flex justify-end gap-2"><Button disabled={working} onClick={() => setConfirmation(null)}>取消</Button><Button variant="danger" loading={working} disabled={disabled} onClick={() => { if (confirmation) void mutate('disconnect', confirmation) }}>断开合作</Button></div>
      </Dialog>
    </div>
  )
}
