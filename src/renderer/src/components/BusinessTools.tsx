import { useState } from 'react'
import type { ContractImportDraft } from '@shared/types'
import { Button, Dialog, Field, Input, Select } from './ui'
import { currentUser } from '@/lib/selectors'
import { contractRoute } from '@/routes'
import { useApp, useView } from '@/store'

export function CounterpartyButton({ onCreated }: { onCreated?: (id: string) => void }) {
  const s = useView(), act = useApp((s) => s.act), busy = useApp((s) => s.busy)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(''), [contactName, setContact] = useState(''), [email, setEmail] = useState('')
  const save = async () => {
    if (await act('createCounterparty', [{ name, contactName, email }], '交易对象已保存')) {
      const cp = useApp.getState().state?.counterparties.find((c) => c.name.toLowerCase() === name.trim().toLowerCase())
      if (cp) onCreated?.(cp.id)
      setOpen(false); setName(''); setContact(''); setEmail('')
    }
  }
  return <><Button onClick={() => setOpen(true)}>新增交易对象</Button>{open && <Dialog open onClose={() => setOpen(false)} title="新增交易对象">
    <div className="space-y-3">
      <p className="text-sm text-ink-500">无需对方注册。此记录仅保存在本企业，不会发送邀请或邮件。</p>
      <Field label="企业名称"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <Field label="联系人（选填）"><Input value={contactName} onChange={(e) => setContact(e.target.value)} /></Field>
      <Field label="联系邮箱（选填）"><Input value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      {s.counterparties.length > 0 && <p className="text-xs text-ink-500">本企业已记录 {s.counterparties.length} 个交易对象</p>}
      <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void save()}>保存交易对象</Button>
    </div>
  </Dialog>}</>
}

function ImportReview({ draft, onClose }: { draft: ContractImportDraft; onClose: () => void }) {
  const s = useView(), me = currentUser(s), act = useApp((x) => x.act), busy = useApp((x) => x.busy), navigate = useApp((x) => x.navigate)
  const value = (field: string) => draft.candidates.find((c) => c.field === field)?.value ?? ''
  const [target, setTarget] = useState('new')
  const [ownSide, setOwnSide] = useState('')
  const [form, setForm] = useState({ title: draft.fileName.replace(/\.(pdf|docx)$/i, '').slice(0, 100), name: '', counterpartyName: '', amount: value('amount').replace(/[,，]/g, ''), expectedSignDate: '' })
  const [acknowledged, setAcknowledged] = useState(false)
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => { setForm({ ...form, [key]: e.target.value }); setAcknowledged(false) }
  const submit = async () => {
    const ok = await act('confirmContractImport', [draft.id, { ...form, amount: Number(form.amount), transactionId: target === 'new' ? undefined : target, acknowledged }], '合同文字已导入；付款安排请另行核对')
    if (ok) {
      const id = useApp.getState().state?.importDrafts.find((d) => d.id === draft.id)?.contractId
      onClose(); if (id) navigate(contractRoute(id))
    }
  }
  return <Dialog open onClose={onClose} title="核对合同导入" width="max-w-2xl">
    <div className="space-y-3">
      <p className="text-sm font-medium">{draft.fileName} · 本机解析 · 待人工确认</p>
      <div className="rounded-lg bg-amber-50 p-3 text-xs leading-6 text-amber-900">{draft.warnings.map((w) => <p key={w}>{w}</p>)}</div>
      <details className="rounded border p-3 text-sm"><summary>规则识别的候选信息及原文（非已确认事实）</summary>
        {draft.candidates.length ? draft.candidates.map((c) => <div key={c.field} className="mt-2 border-t pt-2"><strong>{{ partyA: '甲方', partyB: '乙方', amount: '合同金额', date: '签订日期' }[c.field]}：{c.value}</strong><p className="text-xs text-ink-500">原文：{c.quote}</p></div>) : <p className="mt-2">未识别到明确字段，请手动录入。</p>}
      </details>
      <details className="rounded border p-3 text-sm"><summary>核对提取正文（{draft.rawText.length} 字）</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-sans text-xs leading-6">{draft.rawText}</pre></details>
      <Field label="导入位置"><Select value={target} onChange={(e) => { setTarget(e.target.value); setAcknowledged(false) }}><option value="new">建立新业务</option>{s.transactions.filter((t) => t.initiatorOrgId === me.orgId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
      <Field label="合同名称"><Input value={form.title} onChange={set('title')} /></Field>
      {target === 'new' ? <>
        <Field label="我方在原合同中的身份" hint="确认身份后可带入对方企业名称，仍可手动修改。"><Select value={ownSide} onChange={(e) => { setOwnSide(e.target.value); setForm({ ...form, counterpartyName: value(e.target.value === 'partyA' ? 'partyB' : 'partyA') }); setAcknowledged(false) }}><option value="">请核对并选择</option><option value="partyA">我方是甲方</option><option value="partyB">我方是乙方</option></Select></Field>
        <Field label="交易对象企业名称"><Input value={form.counterpartyName} onChange={set('counterpartyName')} /></Field>
        <Field label="新业务名称"><Input value={form.name} onChange={set('name')} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="业务金额（元）"><Input type="number" min={0} value={form.amount} onChange={set('amount')} /></Field><Field label="预计签约日期（请人工核对）"><Input type="date" value={form.expectedSignDate} onChange={set('expectedSignDate')} /></Field></div>
      </> : <p className="text-sm text-ink-500">将创建一份新合同草稿。现有业务的交易对象、金额、日期不会被导入信息覆盖，请自行核对是否匹配。</p>}
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />我已核对原文件、提取正文及业务归属，了解格式、附件和签章不在导入结果中。</label>
      <div className="flex justify-end gap-2"><Button onClick={onClose}>稍后继续</Button><Button variant="primary" loading={busy} disabled={!acknowledged || !form.title.trim() || (target === 'new' && (!form.name.trim() || !form.counterpartyName.trim() || !form.expectedSignDate || form.amount === ''))} onClick={() => void submit()}>确认并创建合同草稿</Button></div>
    </div>
  </Dialog>
}

export function ContractImportButton() {
  const s = useView(), act = useApp((x) => x.act), busy = useApp((x) => x.busy)
  const [id, setId] = useState<string | null>(null), [list, setList] = useState(false)
  const pending = s.importDrafts.filter((d) => d.status === 'pending')
  const select = async () => {
    const before = new Set(s.importDrafts.map((d) => d.id))
    if (await act('selectContractImport', [])) {
      const draft = useApp.getState().state?.importDrafts.find((d) => !before.has(d.id))
      if (draft) { setList(false); setId(draft.id) }
    }
  }
  const draft = s.importDrafts.find((d) => d.id === id && d.status === 'pending')
  return <><Button loading={busy} onClick={() => pending.length ? setList(true) : void select()}>导入合同{pending.length ? ` · ${pending.length} 待核对` : ''}</Button>
    {list && <Dialog open onClose={() => setList(false)} title="合同导入草稿"><div className="space-y-3">{pending.map((d) => <Button key={d.id} onClick={() => { setId(d.id); setList(false) }}>继续核对：{d.fileName}</Button>)}<Button variant="primary" loading={busy} onClick={() => void select()}>选择新的 DOCX / PDF 文件</Button></div></Dialog>}
    {draft && <ImportReview key={draft.id} draft={draft} onClose={() => setId(null)} />}
  </>
}
