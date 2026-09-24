/// <reference types="vite/client" />
/// <reference types="@ztools-center/ztools-api-types" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

// `window.services` 的类型契约已抽到 src/types/services.ts —— 那份文件是**唯一权威**,
// preload 侧的 services.js 也直接引用它(见该文件顶部说明)。
// 这里只导入以触发 global 声明(Window.services 在 types/services.ts 里 declare global)。
import './types/services'

export {}
