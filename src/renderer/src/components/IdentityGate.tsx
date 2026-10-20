import { useEffect, useState } from 'react'
import { Building2, LogIn, Mail } from 'lucide-react'
import { IDENTITY_ROLE_LABEL, type IdentityInvitation } from '@shared/identity'
import { Button, Card, CardHeader, Field, Input } from './ui'
import { useApp } from '@/store'

export default function IdentityGate() {
  const status = useApp((s) => s.identityStatus)
  const error = useApp((s) => s.error)
  const busy = useApp((s) => s.busy)
  const identity = useApp((s) => s.identity)
  const refresh = useApp((s) => s.refreshIdentity)
  const selectCompany = useApp((s) => s.selectCompany)
  const init = useApp((s) => s.init)
  const [name, setName] = useState('')
  const [invitations, setInvitations] = useState<IdentityInvitation[]>([])
  const accountId = status?.account?.id
  useEffect(() => {
    let active = true
    if (accountId)
      void identity<IdentityInvitation[]>('my-invitations').then((items) => {
        if (active && items) setInvitations(items)
      })
    else setInvitations([])
    return () => {
      active = false
    }
  }, [accountId, identity])
  const authenticate = async (action: string) => {
    const result = await identity(action)
    if (result !== null) await refresh()
  }
  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 p-8">
      <div className="w-full max-w-xl space-y-5">
        <div className="mb-8 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-lg font-semibold text-white">
            N
          </span>
          <span className="text-xl font-semibold">Project Nexus</span>
        </div>
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
          >
            {error}
          </div>
        )}
        {!status || !status.configured ? (
          <Card>
            <CardHeader
              title="身份服务尚未就绪"
              subtitle="请检查服务器地址和登录服务配置后重试。"
            />
            <div className="p-4">
              <Button onClick={() => void init()}>重新连接</Button>
            </div>
          </Card>
        ) : !status.account ? (
          <Card>
            <CardHeader
              title="登录你的工作空间"
              subtitle="使用系统浏览器安全登录，完成后将自动返回。"
            />
            <div className="space-y-4 p-5">
              <p className="text-sm text-ink-500">
                使用同一账号加入不同企业，企业内权限由成员角色决定。
              </p>
              <Button
                variant="primary"
                size="lg"
                loading={busy}
                onClick={() => void authenticate('login')}
              >
                <LogIn className="h-4 w-4" />
                登录
              </Button>
              <div className="flex gap-3">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void authenticate('register')}
                >
                  注册账号
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void authenticate('recover')}
                >
                  找回密码
                </Button>
              </div>
            </div>
          </Card>
        ) : (
          <>
            <div>
              <h1 className="text-xl font-semibold">选择工作企业</h1>
              <p className="mt-1 text-sm text-ink-500">
                {status.account.name} · {status.account.email}
              </p>
            </div>
            <Card>
              <CardHeader title="我的企业" />
              <div className="divide-y divide-slate-100">
                {status.companies.length === 0 && (
                  <p className="p-4 text-sm text-ink-500">
                    尚未加入企业。你可以创建企业或接受下方邀请。
                  </p>
                )}
                {status.companies.map((company) => (
                  <button
                    disabled={busy}
                    key={company.id}
                    onClick={() => void selectCompany(company.id)}
                    className="flex w-full items-center gap-3 p-4 text-left hover:bg-slate-50 disabled:opacity-50"
                  >
                    <Building2 className="h-5 w-5 text-brand-600" />
                    <span className="flex-1">
                      <span className="block font-medium">{company.name}</span>
                      <span className="text-xs text-ink-500">
                        {IDENTITY_ROLE_LABEL[company.role]}
                      </span>
                    </span>
                    <span className="text-xs text-brand-600">进入企业</span>
                  </button>
                ))}
              </div>
            </Card>
            {invitations.filter((item) => item.status === 'pending').length > 0 && (
              <Card>
                <CardHeader title="待接受的企业邀请" />
                <div className="divide-y divide-slate-100">
                  {invitations
                    .filter((item) => item.status === 'pending')
                    .map((item) => (
                      <div key={item.id} className="flex items-center gap-3 p-4">
                        <Mail className="h-4 w-4 text-brand-600" />
                        <div className="flex-1">
                          <p className="text-sm font-medium">{item.orgName}</p>
                          <p className="text-xs text-ink-500">
                            {IDENTITY_ROLE_LABEL[item.role]} · 有效期至{' '}
                            {new Date(item.expiresAt).toLocaleDateString('zh-CN')}
                          </p>
                        </div>
                        <Button
                          loading={busy}
                          onClick={async () => {
                            if ((await identity('accept-invitation', { id: item.id })) !== null) {
                              setInvitations((items) => items.filter((x) => x.id !== item.id))
                              await refresh()
                            }
                          }}
                        >
                          接受邀请
                        </Button>
                      </div>
                    ))}
                </div>
              </Card>
            )}
            <Card>
              <CardHeader title="创建企业" />
              <form
                className="flex items-end gap-3 p-4"
                onSubmit={async (event) => {
                  event.preventDefault()
                  if ((await identity('create-company', { name })) !== null) {
                    setName('')
                    await refresh()
                  }
                }}
              >
                <div className="flex-1">
                  <Field label="企业名称">
                    <Input
                      required
                      maxLength={120}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="输入企业名称"
                    />
                  </Field>
                </div>
                <Button type="submit" loading={busy} disabled={!name.trim()}>
                  创建企业
                </Button>
              </form>
            </Card>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                if ((await identity('logout')) !== null) await refresh()
              }}
            >
              退出登录
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
