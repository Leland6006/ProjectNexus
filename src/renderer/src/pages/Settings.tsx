import { useState } from 'react'
import { RotateCcw, ShieldAlert } from 'lucide-react'
import { Button, Card, CardHeader, PageHeader } from '@/components/ui'
import { useApp, useView } from '@/store'

export default function SettingsPage() {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader title="设置" />
      <div className="space-y-4">
        <Card>
          <CardHeader title="关于 Nexus" />
          <div className="space-y-1 px-4 py-3 text-sm text-ink-700">
            <p>面向创业者的 AI 联合创始人工作空间 · 本地桌面版（第一轮产品框架）</p>
            <p>数据保存在本机，不会上传到任何服务器。</p>
          </div>
        </Card>

        <Card>
          <CardHeader title="AI 连接" />
          <div className="space-y-1 px-4 py-3 text-sm text-ink-700">
            <p>
              当前状态：
              {s.runtime.connected ? <span className="font-medium text-emerald-700">已连接（{s.runtime.id}）</span> : <span className="font-medium">未连接</span>}
            </p>
            <p className="text-ink-500">
              未连接时，Nexus 会保存你的消息并如实说明无法回答，不会生成模拟的分析结果，也不会修改业务数据。接入模型或 DeepSeek Harness 计划在后续轮次评估。
            </p>
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
                <p className="mb-2 text-sm text-rose-800">这会清除你在本机创建的所有业务、合同、评论、履约节点和对话，并恢复为初始演示数据。此操作无法撤销。</p>
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
