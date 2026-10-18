import { contextBridge, ipcRenderer } from 'electron'
import type { ApiMethod, ApiResult, NexusBridge } from '../shared/api'

// Expose exactly one function. The main process validates the method name and every argument.
const bridge: NexusBridge = {
  call: (method: ApiMethod, ...args: unknown[]): Promise<ApiResult> => ipcRenderer.invoke('nexus:call', method, args)
}

contextBridge.exposeInMainWorld('nexus', bridge)
