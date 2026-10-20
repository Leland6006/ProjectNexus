import { useCallback, useEffect, useState } from 'react'
import { type IdentitySession } from '@shared/identity'
import { Button, Card, CardHeader, Field, Input, PageHeader } from '@/components/ui'
import { useApp } from '@/store'

export default function IdentitySettings() {
  const account = useApp((s) => s.identityStatus?.account)
  const busy = useApp((s) => s.busy)
  const identity = useApp((s) => s.identity)
  const refresh = useApp((s) => s.refreshIdentity)
  const [name, setName] = useState(account?.name ?? '')
  const [sessions, setSessions] = useState<IdentitySession[]>([])
  const [confirmAll, setConfirmAll] = useState(false)
  const load = useCallback(async () => {
    const result = await identity<IdentitySession[]>('sessions')
    if (result) setSessions(result)
  }, [identity])
  useEffect(() => {
    void load()
  }, [load])
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <PageHeader title="账号设置" subtitle="管理个人资料、登录安全和已登录的设备。" />
      <Card>
        <CardHeader title="个人资料" />
        <form
          className="space-y-3 p-4"
          onSubmit={async (event) => {
            event.preventDefault()
            if ((await identity('update-profile', { name })) !== null) await refresh()
          }}
        >
          <Field label="姓名">
            <Input
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="登录邮箱">
            <Input value={account?.email ?? ''} readOnly />
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            保存资料
          </Button>
        </form>
      </Card>
      <Card>
        <CardHeader title="登录与安全" subtitle="在系统浏览器中管理密码和多因素认证。" />
        <div className="p-4">
          <Button disabled={busy} onClick={() => void identity('account-security')}>
            打开安全设置
          </Button>
        </div>
      </Card>
      <Card>
        <CardHeader
          title="登录会话"
          action={
            <Button size="sm" disabled={busy} onClick={() => void load()}>
              刷新
            </Button>
          }
        />
        <div className="divide-y divide-slate-100">
          {sessions.length === 0 && (
            <p className="p-4 text-sm text-ink-500">暂无可显示的登录会话。</p>
          )}
          {sessions.map((session) => (
            <div className="flex items-center justify-between gap-4 p-4" key={session.id}>
              <div>
                <p className="text-sm font-medium">
                  {session.current ? '当前设备' : '其他登录设备'}
                </p>
                <p className="text-xs text-ink-500">
                  登录时间：{new Date(session.createdAt).toLocaleString('zh-CN')}
                </p>
              </div>
              <Button
                disabled={busy}
                onClick={async () => {
                  if ((await identity('revoke-session', { id: session.id })) !== null) {
                    await refresh()
                    await load()
                  }
                }}
              >
                {session.current ? '退出当前会话' : '撤销会话'}
              </Button>
            </div>
          ))}
        </div>
        <div className="border-t border-slate-100 p-4">
          {confirmAll ? (
            <div className="space-y-2">
              <p className="text-sm text-ink-700">确认撤销所有登录会话？之后需要重新登录。</p>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  loading={busy}
                  onClick={async () => {
                    if ((await identity('revoke-all')) !== null) {
                      setSessions([])
                      await refresh()
                    }
                  }}
                >
                  确认全部退出
                </Button>
                <Button onClick={() => setConfirmAll(false)}>取消</Button>
              </div>
            </div>
          ) : (
            <Button onClick={() => setConfirmAll(true)}>退出所有设备</Button>
          )}
        </div>
      </Card>
    </div>
  )
}
