/// <reference types="vite/client" />
/// <reference types="@ztools-center/ztools-api-types" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

// Preload services 类型声明(对应 src-ztools/preload/services.js)
interface DownloadParams {
  tag: string
  variant: import('./types/godot').Variant
  platform: import('./types/godot').Platform
  url: string
  fileName: string
  totalSize: number
}

interface Services {
  currentPlatform(): import('./types/godot').Platform
  fetchReleases(force?: boolean): Promise<import('./types/godot').GodotRelease[]>
  /** 下载并安装版本(入队),返回任务 id */
  downloadAndInstall(
    params: DownloadParams,
    opts: { mirror?: string, versionsRoot: string }
  ): string
  cancelTask(id: string): void
  dismissTask(id: string): void
  /** 订阅下载任务快照,返回取消订阅函数 */
  watchTasks(fn: (tasks: import('./types/godot').DownloadTask[]) => void): () => void
  importLocalExe(exePath: string): Promise<{ ok: boolean, error?: string, version?: import('./types/godot').GodotVersion }>
  deleteVersion(v: { id: string, installDir?: string, managed: boolean }): { ok: boolean, error?: string }
  /** 添加项目(目录或 project.godot 文件路径) */
  addProject(inputPath: string): {
    ok: boolean
    error?: string
    project?: import('./types/godot').GodotProject
    exists?: boolean
  }
  /** 递归扫描目录,返回所有含 project.godot 的目录 */
  scanProjects(rootDir: string): string[]
  /** 删除项目记录 */
  removeProject(id: string): { ok: boolean }
  /** 启动项目(editor=编辑器,run=运行) */
  launchProject(opts: { projectId: string, action: 'editor' | 'run' }): {
    ok: boolean
    error?: string
    project?: import('./types/godot').GodotProject & { _id: string }
  }
}

declare global {
  interface Window {
    services: Services
  }
}

export {}
