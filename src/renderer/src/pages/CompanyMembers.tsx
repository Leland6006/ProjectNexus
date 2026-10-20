import { useCallback, useEffect, useState } from 'react'
import { IDENTITY_ROLE_LABEL, type IdentityInvitation, type IdentityMember, type IdentityRole } from '@shared/identity'
import { Badge, Button, Card, CardHeader, Field, Input, PageHeader, Select } from '@/components/ui'
import { useApp } from '@/store'

const ROLES: IdentityRole[] = ['admin', 'business', 'finance', 'legal', 'readonly']
const STATUS_LABEL: Record<string, string> = { pending: '待接受', accepted: '已接受', withdrawn: '已撤回', expired: '已过期', active: '有效', removed: '已移除', revoked: '已撤回' }
export default function CompanyMembers() {
  const status = useApp((s) => s.identityStatus)
  const busy = useApp((s) => s.busy)
  const identity = useApp((s) => s.identity)
  const refresh = useApp((s) => s.refreshIdentity)
  const company = status?.companies.find((item) => item.id === status.actingOrgId)
  const canManage = company?.role === 'owner' || company?.role === 'admin'
  const [members, setMembers] = useState<IdentityMember[]>([])
  const [invitations, setInvitations] = useState<IdentityInvitation[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<IdentityRole>('business')
  const [confirmation, setConfirmation] = useState<{ action: string; body: unknown; text: string } | null>(null)
  const load = useCallback(async () => {
    const result = await identity<IdentityMember[]>('members')
    if (result) setMembers(result)
    if (canManage) { const items = await identity<IdentityInvitation[]>('invitations'); if (items) setInvitations(items) }
  }, [identity, canManage])
  useEffect(() => { void load() }, [load])
  const mutate = async (action: string, body: unknown) => {
    if (await identity(action, body) !== null) { setConfirmation(null); await refresh(); await load() }
  }
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <PageHeader title="公司档案与记忆" subtitle="企业资料、成员与角色。企业记忆将随真实业务逐步积累。" />
      <Card><CardHeader title={company?.name ?? '当前企业'} /><div className="space-y-2 p-4 text-sm"><p className="text-ink-500">企业简称：{company?.shortName || company?.name}</p><p>我的角色：{company && IDENTITY_ROLE_LABEL[company.role]}</p><p className="text-xs text-ink-500">企业级记忆尚无独立管理功能；业务上下文可在具体项目与建议中查看。</p></div></Card>
      <Card><CardHeader title="企业成员" action={<Button size="sm" disabled={busy} onClick={() => void load()}>刷新</Button>} />
        <ul className="divide-y divide-slate-100">{members.length === 0 && <li className="p-4 text-sm text-ink-500">暂无可显示的成员。</li>}{members.map((member) => {
          const self = member.userId === status?.account?.id
          const editable = canManage && member.role !== 'owner' && (company?.role === 'owner' || member.role !== 'admin') && !self
          return <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="text-sm font-medium">{member.name}{self ? '（我）' : ''}</p><p className="text-xs text-ink-500">{member.email} · {STATUS_LABEL[member.status] ?? '成员'}</p></div><div className="flex items-center gap-2">{editable ? <Select aria-label={`设置${member.name}的角色`} value={member.role} disabled={busy} onChange={(event) => setConfirmation({ action: 'change-role', body: { id: member.id, role: event.target.value }, text: `将 ${member.name} 的角色改为${IDENTITY_ROLE_LABEL[event.target.value as IdentityRole]}？` })}>{ROLES.filter((item) => company?.role === 'owner' || item !== 'admin').map((item) => <option key={item} value={item}>{IDENTITY_ROLE_LABEL[item]}</option>)}</Select> : <Badge>{IDENTITY_ROLE_LABEL[member.role]}</Badge>}{editable && <Button size="sm" disabled={busy} onClick={() => setConfirmation({ action: 'remove-member', body: { id: member.id }, text: `确认移除 ${member.name}？该成员将失去当前企业的访问权限。` })}>移除</Button>}{company?.role === 'owner' && !self && member.role !== 'owner' && <Button size="sm" disabled={busy} onClick={() => setConfirmation({ action: 'transfer-ownership', body: { userId: member.userId }, text: `确认将企业所有权转交给 ${member.name}？转交后你的管理角色将发生变化。` })}>转交所有权</Button>}</div></li>
        })}</ul>
      </Card>
      {confirmation && <div role="alert" className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4"><p className="text-sm text-amber-900">{confirmation.text}</p><div className="flex gap-2"><Button variant="primary" loading={busy} onClick={() => void mutate(confirmation.action, confirmation.body)}>确认</Button><Button onClick={() => setConfirmation(null)}>取消</Button></div></div>}
      {canManage && <Card><CardHeader title="邀请成员" subtitle="受邀人使用同一邮箱登录后，在企业选择页接受邀请。" /><form className="flex flex-wrap items-end gap-3 p-4" onSubmit={async (event) => { event.preventDefault(); if (await identity('invite', { email, role }) !== null) { setEmail(''); await load() } }}><div className="min-w-48 flex-1"><Field label="邮箱"><Input type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="成员登录邮箱" /></Field></div><Field label="企业角色"><Select value={role} onChange={(event) => setRole(event.target.value as IdentityRole)}>{ROLES.filter((item) => company?.role === 'owner' || item !== 'admin').map((item) => <option value={item} key={item}>{IDENTITY_ROLE_LABEL[item]}</option>)}</Select></Field><Button variant="primary" type="submit" loading={busy}>发送邀请</Button></form></Card>}
      {canManage && <Card><CardHeader title="企业邀请记录" /><ul className="divide-y divide-slate-100">{invitations.length === 0 && <li className="p-4 text-sm text-ink-500">暂无邀请。</li>}{invitations.map((item) => <li key={item.id} className="flex items-center justify-between gap-3 p-4"><div><p className="text-sm font-medium">{item.email}</p><p className="text-xs text-ink-500">{IDENTITY_ROLE_LABEL[item.role]} · {STATUS_LABEL[item.status] ?? '邀请记录'} · 有效期至 {new Date(item.expiresAt).toLocaleDateString('zh-CN')}</p></div>{item.status === 'pending' && <Button size="sm" disabled={busy} onClick={() => setConfirmation({ action: 'withdraw-invitation', body: { id: item.id }, text: `确认撤回发送给 ${item.email} 的邀请？` })}>撤回邀请</Button>}</li>)}</ul></Card>}
    </div>
  )
}
