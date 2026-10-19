import { contextBridge, ipcRenderer } from 'electron'
import type { ViewState } from '../shared/types'
import type { ApiMethod, ApiResult, NexusBridge, ChatProgress } from '../shared/api'

// Expose the allowlisted call function and one fixed, read-only progress subscription.
const bridge: NexusBridge = {
  onWorkflowProgress: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, state: ViewState) => listener(state)
    ipcRenderer.on('nexus:workflow-progress', receive)
    return () => ipcRenderer.removeListener('nexus:workflow-progress', receive)
  },
  onChatProgress: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, data: ChatProgress) => listener(data)
    ipcRenderer.on('nexus:chat-progress', receive)
    return () => ipcRenderer.removeListener('nexus:chat-progress', receive)
  },
  call: (method: ApiMethod, ...args: unknown[]): Promise<ApiResult> => ipcRenderer.invoke('nexus:call', method, args)
}

contextBridge.exposeInMainWorld('nexus', bridge)
