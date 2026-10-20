import { contextBridge, ipcRenderer } from 'electron'
import type { ApiMethod, ApiResult, NexusBridge } from '../shared/api'

// Expose only the typed business, identity and mode bridges. Main validates sender and inputs.
const bridge: NexusBridge = {
  call: (method: ApiMethod, ...args: unknown[]): Promise<ApiResult> => ipcRenderer.invoke('nexus:call', method, args),
  identity: (action: string, body?: unknown) => ipcRenderer.invoke('nexus:identity', action, body),
  mode: () => ipcRenderer.invoke('nexus:mode'),
  onInvalidate: (listener) => {
    const notify = () => listener()
    ipcRenderer.on('nexus:invalidate', notify)
    return () => { ipcRenderer.removeListener('nexus:invalidate', notify) }
  }
}

contextBridge.exposeInMainWorld('nexus', bridge)
