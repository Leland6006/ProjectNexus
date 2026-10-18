/// <reference types="react" />
/// <reference types="react-dom" />

import type { NexusBridge } from '@shared/api'

declare global {
  interface Window {
    nexus: NexusBridge
  }
}

export {}
