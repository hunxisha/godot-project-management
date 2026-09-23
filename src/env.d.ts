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
  /** 搜索 Asset Library */
  searchAssets(
    filter: string,
    godotVersion?: string,
    page?: number
  ): Promise<{ result: import('./types/godot').MarketAsset[], page: number, pages: number }>
  /** 列出项目已安装插件 */
  listAddons(projectId: string): import('./types/godot').AddonInfo[]
  /** 安装市场插件 */
  installAsset(
    opts: { projectId: string, assetId: number },
    onProgress?: (p: { stage: 'downloading' | 'extracting', received?: number, total?: number }) => void
  ): Promise<{
    ok: boolean
    error?: string
    addon?: { title: string, versionString: string, dirNames: string[], enabled: boolean }
  }>
  /** 更新插件(覆盖安装) */
  updateAsset(
    opts: { projectId: string, assetId: number },
    onProgress?: (p: { stage: 'downloading' | 'extracting', received?: number, total?: number }) => void
  ): Promise<{ ok: boolean, error?: string, addon?: { title: string, versionString: string, dirNames: string[], enabled: boolean } }>
  /** 检查插件更新 */
  checkAddonUpdate(opts: { projectId: string, assetId: number }): Promise<{ hasUpdate: boolean, latest?: string, error?: string }>
  /** 卸载插件 */
  uninstallAddon(opts: { projectId: string, dirName: string }): { ok: boolean, error?: string }
  /** 启用/禁用插件 */
  setAddonEnabled(opts: { projectId: string, dirName: string, enabled: boolean }): { ok: boolean, error?: string }
}

declare global {
  interface Window {
    services: Services
  }
}

export {}
