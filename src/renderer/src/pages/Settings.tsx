import { useState } from 'react'
import { RotateCcw, ShieldAlert } from 'lucide-react'
import { Button, Card, CardHeader, PageHeader, Field, Input } from '@/components/ui'
import { useApp, useView } from '@/store'

export default function SettingsPage() {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const [confirming, setConfirming] = useState(false)
  const [key, setKey] = useState('')
  const [model, setModel] = useState('deepseek-flash')
  const [consent, setConsent] = useState(false)

  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader title="设置" />
      <div className="space-y-4">
        <Card>
          <CardHeader title="关于 Nexus" />
          <div className="space-y-1 px-4 py-3 text-sm text-ink-700">
            <p>面向创业者的 AI 联合创始人工作空间 · 本地桌面版 · 企业经营、协同任务与资金台账</p>
            <p>业务数据保存在本机。启用 AI 后，本次聊天和相关授权企业数据会发送至 DeepSeek。</p>
          </div>
        </Card>

        <Card>
          <CardHeader title="AI 连接" />
          <div className="space-y-1 px-4 py-3 text-sm text-ink-700">
            <p>
              当前状态：
              {s.runtime.connected ? <span className="font-medium text-emerald-700">已配置（{s.runtime.id}）</span> : <span className="font-medium">未连接</span>}
            </p>
            <p className="text-ink-500">
              未连接时，Nexus 会保存你的消息并如实说明无法回答，不会生成模拟的分析结果，也不会修改业务数据。启用后支持真实模型回答与只读业务查询；公司经营资料的修改会先生成草稿，需你点击确认；其他业务数据只读。Harness 尚未集成。
            </p>
            <form className="mt-4 space-y-3" onSubmit={async (e) => {
              e.preventDefault()
              await act('configureAi', [{ apiKey: key.trim(), model: model.trim() }], 'AI 连接已配置，首次回答将验证服务是否可用')
              setKey('')
            }}>
              <Field label="DeepSeek 模型名称"><Input required value={model} maxLength={100} onChange={(e) => setModel(e.target.value)} /></Field>
              <Field label="DeepSeek API Key" hint="输入仅用于本次保存；之后由系统加密保存在独立配置文件，不随业务数据库或 Git 同步。"><Input required type="password" autoComplete="off" value={key} maxLength={512} onChange={(e) => setKey(e.target.value)} /></Field>
              <label className="flex items-start gap-2 text-xs text-ink-600"><input type="checkbox" required checked={consent} onChange={(e) => setConsent(e.target.checked)} />我了解聊天及相关企业数据会发送至 DeepSeek，并可能产生 API 费用。</label>
              <div className="flex gap-2"><Button type="submit" variant="primary" loading={busy} disabled={!key.trim() || !consent}>保存并启用</Button>{s.runtime.connected && <Button type="button" loading={busy} onClick={() => void act('disconnectAi', [], '已断开 AI 并移除本机密钥')}>断开并移除密钥</Button>}</div>
            </form>
          </div>
        </Card>

        <Card>
          <CardHeader title="安全与权限说明" />
          <div className="flex gap-3 px-4 py-3 text-sm text-ink-700">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p>
              账号与经营企业切换仅用于本地演示，用来展示企业之间、企业与外部律师之间的数据隔离逻辑。它<strong>不是</strong>真实的身份认证，不能用于保护真实的商业机密。
            </p>
          </div>
        </Card>

        <Card>
          <CardHeader title="演示数据" subtitle="所有企业、人员与合同内容均为虚构" />
          <div className="px-4 py-3">
            {!confirming ? (
              <Button onClick={() => setConfirming(true)}>
                <RotateCcw className="h-3.5 w-3.5" />
                重置为初始演示数据
              </Button>
            ) : (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                <p className="mb-2 text-sm text-rose-800">这会清除你在本机创建的所有业务、合同、任务、资金台账、发票材料和对话，并恢复为初始演示数据。此操作无法撤销。</p>
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    loading={busy}
                    onClick={async () => {
                      if (await act('resetDemo', [], '已恢复演示数据')) setConfirming(false)
                    }}
                  >
                    确认重置
                  </Button>
                  <Button onClick={() => setConfirming(false)}>取消</Button>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
