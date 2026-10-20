export type LiveSource = {
  openLive(signal: AbortSignal): Promise<Response | null>
  onLiveContextChange(listener: () => void): () => void
}

/** 只解析有界失效帧，业务内容始终由普通鉴权接口重新读取。 */
export async function readInvalidations(response: Response, signal: AbortSignal, invalidate: () => void): Promise<void> {
  if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'text/event-stream' || !response.body) {
    await response.body?.cancel()
    throw new Error('实时连接不可用')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  let pending = ''
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done || signal.aborted) return
      pending += decoder.decode(value, { stream: true }).replace(/\r/g, '')
      if (pending.length > 16_384) throw new Error('实时消息超出限制')
      let end: number
      while ((end = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, end)
        pending = pending.slice(end + 2)
        if (frame.split('\n').some((line) => line === 'event: invalidate') && !signal.aborted) invalidate()
      }
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export class LiveSync {
  private readonly source: LiveSource
  private readonly invalidate: () => void
  private readonly retryBase: number
  private readonly idleTimeout: number
  private controller: AbortController | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private generation = 0
  private failures = 0
  private running = false
  constructor(source: LiveSource, invalidate: () => void, retryBase = 1000, idleTimeout = 45_000) {
    this.source = source
    this.invalidate = invalidate
    this.retryBase = retryBase
    this.idleTimeout = idleTimeout
  }
  start(): void {
    if (this.running) return
    this.running = true
    this.unsubscribe = this.source.onLiveContextChange(() => this.restart())
    this.restart()
  }
  stop(): void {
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = null
    this.cancel()
  }
  private cancel(): void {
    ++this.generation
    this.controller?.abort()
    this.controller = null
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
  }
  private restart(): void {
    this.cancel()
    this.failures = 0
    if (this.running) void this.connect(this.generation)
  }
  private async connect(generation: number): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    // 心跳也会重置此计时；代理保持TCP却不再转发时必须重新连接。
    let idle = setTimeout(() => controller.abort(), this.idleTimeout)
    const activity = () => {
      clearTimeout(idle)
      idle = setTimeout(() => controller.abort(), this.idleTimeout)
    }
    let opened = false
    try {
      const response = await this.source.openLive(controller.signal)
      if (controller.signal.aborted || generation !== this.generation) { await response?.body?.cancel(); return }
      if (!response) return
      opened = true
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || response.status === 409) this.invalidate()
        await response.body?.cancel()
        throw new Error('实时连接不可用')
      }
      // 每次重连都补一次重新读取，覆盖连接断开期间发生的写入。
      if (response.headers.get('content-type')?.split(';')[0] !== 'text/event-stream') {
        await response.body?.cancel()
        throw new Error('实时连接格式无效')
      }
      this.invalidate()
      const body = response.body
      if (!body) throw new Error('实时连接缺少消息流')
      const monitored = new Response(body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) { activity(); stream.enqueue(chunk) }
      })), { status: response.status, headers: response.headers })
      await readInvalidations(monitored, controller.signal, () => {
        if (generation === this.generation && !controller.signal.aborted) this.invalidate()
      })
    } catch {
      // 30秒普通刷新继续工作；禁止记录携带认证头的原始网络错误。
      opened = true
    } finally {
      clearTimeout(idle)
      if (generation === this.generation) this.controller = null
      if (this.running && generation === this.generation && opened) {
        const backoff = Math.min(30_000, this.retryBase * 2 ** Math.min(this.failures++, 5))
        this.retry = setTimeout(() => { this.retry = null; void this.connect(generation) }, backoff + Math.floor(Math.random() * this.retryBase / 4))
      }
    }
  }
}
