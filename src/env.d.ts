/// <reference types="vite/client" />
/// <reference types="@ztools-center/ztools-api-types" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

// Preload services 类型声明(对应 src-ztools/preload/services.js)
// Node 能力(fs/网络/进程)按里程碑在此扩展
interface Services {}

declare global {
  interface Window {
    services: Services
  }
}

export {}
