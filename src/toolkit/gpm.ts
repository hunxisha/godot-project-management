// 工具箱 · `window.gpm` 受限层的组装(Q27 / §5.3 / Q12=B′)。
//
// ★★ 这一层是**契约边界,不是安全边界**。★★
// 宿主实测 `contextIsolation:false` + `webSecurity:false` + `nodeIntegration:false`:
// 插件 JS 拿不到裸 `require`,但能拿到 `window.services` 与全部 `window.ztools`,
// 还能用 `createBrowserWindow(url,{webPreferences.preload})` 提权到裸 Node。
// `new Function` 的作用域包裹挡不住 `globalThis`(语言语义,不是实现难度)。
// 所以本文件里**没有任何一行代码在试图挡住恶意插件** —— 它做的只有两件事:
//   1. 给插件一张**清晰、可测、防手滑**的 API 面(而不是让它去摸 window.services 的全部);
//   2. 把「写盘」这个动作留在框架手里(见 orchestrate.ts 的三段式),插件默认拿不到裸写。
// UI 必须把上面这段权限面明示给用户(§7 A-12),措辞里不许出现「沙箱 / 隔离 / 安全」。
//
// 三条组装判据:
//   · **能力门**:`capabilities` 没声明的能力,对应的 API 直接**不存在**(不是「调了就抛」) ——
//     声明与给到的能力一致,插件作者写 `ctx.scanTree` 时不需要 try;
//   · **前缀隔离**:`store` 的 key 由框架拼 `gpm/plugin/<toolId>/`,插件传不进完整 id
//     (§D #10:隔离做在这一层,而不是靠 preload 校验 —— `src/services/bridge.ts` 的
//     `putDoc`/`getDoc` 根本没有前缀闸,靠约定等于没有);
//   · **pid 由框架注入**(Q26):`projectId` 是只读快照,插件不许自己挑项目 ——
//     否则「用户选中的是 A 而插件读了 B」这种错没有任何一处能发现。

import type { TreeEntry } from '../types/godot'
import { buildRefIndex } from '../tools/refIndex'
import type { RefIndex } from '../tools/refIndex'
import { computed, h, onMounted, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'

/** 能力令牌:与 `src/toolkit/manifest.ts` 的枚举一一对应,不要在这里加新值 */
export type GpmCapability = 'tree' | 'text' | 'ref' | 'write' | 'store' | 'ui'

/** 框架侧的注入物:渲染层(useToolPage)把它交给 buildGpm,插件永远看不到这个对象本身 */
export interface GpmHost {
  /** 宿主 services 里被本层用到的那几个方法(白名单,不是整个 services) */
  services: {
    listProjects?: () => Promise<unknown[]> | unknown[]
    getProject?: (id: string) => Promise<unknown> | unknown
    scanProjectTree?: (pid: string, opts?: { includeCache?: boolean, exts?: string[], skipDirs?: string[], maxEntries?: number }) => Promise<unknown> | unknown
    readProjectText?: (pid: string, rel: string, opts?: { maxBytes?: number }) => Promise<unknown> | unknown
    writeProjectText?: (pid: string, rel: string, text: string, opts?: { backup?: boolean }) => Promise<unknown> | unknown
    movePathsToTrash?: (pid: string, rels: string[]) => Promise<unknown> | unknown
    hashPaths?: (pid: string, rels: string[]) => Promise<unknown> | unknown
    getDoc?: (id: string) => Promise<unknown> | unknown
    putDoc?: (id: string, data: object) => Promise<unknown> | unknown
    removeDoc?: (id: string) => Promise<unknown> | unknown
    notify?: (text: string) => unknown
    openDialog?: (opts?: unknown) => Promise<unknown> | unknown
    saveDialog?: (opts?: unknown) => Promise<unknown> | unknown
    copyText?: (text: string) => unknown
    shellOpenPath?: (p: string) => unknown
  }
  toolId: string
  toolName: string
  projectId: string
  capabilities: readonly GpmCapability[]
  /** manifest 的 unsafe:true 才给裸写三件套(§5.2:view 型的唯一出口) */
  unsafe: boolean
  /** 进度与日志的落点(渲染层拿去更新 UI) */
  onLog?: (level: string, msg: string) => void
  onProgress?: (done: number, total: number) => void
  /** 取消:框架持有一个 ref,插件只能读 + 挂回调 */
  cancelled?: () => boolean
  onCancel?: (fn: () => void) => void
}

/** 插件拿到的 `ctx`(§5.3 的那张表) */
export interface GpmCtx {
  readonly toolId: string
  readonly toolName: string
  /** 框架注入的只读快照:插件不许自己挑项目(Q26) */
  readonly projectId: string
  readonly capabilities: readonly GpmCapability[]
  /** 这个 ctx 到底给了哪些能力(诊断与骨架模板打印用) */
  listProjects(): Promise<unknown[]>
  getProject(id?: string): Promise<unknown>
  scanTree(opts?: { exts?: string[], skipDirs?: string[], includeCache?: boolean }): Promise<{ files: TreeEntry[], truncated: boolean, error: string }>
  readText(rel: string, opts?: { maxBytes?: number }): Promise<{ text: string, truncated: boolean, skippedBinary: boolean, bytes: number, error: string }>
  hashPaths(rels: string[]): Promise<{ hashes: { rel: string, sha256: string }[], failed: unknown[], error: string }>
  refIndex(): Promise<{ index: RefIndex | null, error: string }>
  /** 宿主 UI 五件套:都做成「不可用时静默 no-op + log」,不让插件去判 undefined */
  notify(text: string): void
  openDialog(opts?: unknown): Promise<{ paths: string[], canceled: boolean }>
  saveDialog(opts?: unknown): Promise<{ path: string, canceled: boolean }>
  copyText(text: string): void
  shellOpenPath(p: string): void
  store?: {
    get(key: string): Promise<unknown>
    put(key: string, value: unknown): Promise<boolean>
    remove(key: string): Promise<boolean>
    /** 插件自己的前缀(只给看,不给改) */
    prefix: string
  }
  log(level: string, msg: string): void
  progress(done: number, total: number): void
  readonly cancelled: boolean
  onCancel(fn: () => void): void
  /** render 型工具的框架级 Vue 入口(不引运行时编译器,Q10=D) */
  vue: { h: typeof h, ref: typeof ref, computed: typeof computed, onMounted: typeof onMounted }
  /** 仅 unsafe:true 可见:裸写三件套里的两个(rename 的原语第 2 批才建) */
  writeText?: (rel: string, text: string) => Promise<unknown>
  movePathsToTrash?: (rels: string[]) => Promise<unknown>
}

export const STORE_PREFIX_ROOT = 'gpm/plugin'

/**
 * 插件存储的完整 doc id:`gpm/plugin/<toolId>/<key>`。
 *
 * 判据方向是**拒**而不是洗:key 里出现 `/` 之外的路径语义(`..`、绝对、盘符)一律拒,
 * 因为一旦允许 `../other-tool/x`,前缀隔离就成了装饰。
 * 空 key 也拒 —— 拼出 `gpm/plugin/id/` 这种带尾斜杠的 id,以后没人能读回来。
 * @returns {{ok:true, id:string} | {ok:false, error:string}}
 */
export function storeKeyOf(toolId: string, key: unknown): { ok: true, id: string } | { ok: false, error: string } {
  if (typeof toolId !== 'string' || !toolId) return { ok: false, error: '工具 id 缺失,存储无处归属' }
  if (typeof key !== 'string' || !key.trim()) return { ok: false, error: 'store 的 key 必须是非空字符串' }
  const k = key.trim()
  if (k.startsWith('/') || /^[a-zA-Z]:/.test(k)) return { ok: false, error: `store 的 key 不许是绝对路径:${k}` }
  for (const seg of k.split('/')) {
    if (seg === '..') return { ok: false, error: `store 的 key 不许含 ..(那会跳出本插件的前缀):${k}` }
    if (seg === '.') return { ok: false, error: `store 的 key 不许含 . 段:${k}` }
    if (!seg) return { ok: false, error: `store 的 key 有空段:${k}` }
  }
  return { ok: true, id: `${STORE_PREFIX_ROOT}/${toolId}/${k}` }
}

/** 这个 doc id 是不是该插件自己的(回读/清理时用) */
export function storeKeyBelongs(id: unknown, toolId: string): boolean {
  return typeof id === 'string' && id.startsWith(`${STORE_PREFIX_ROOT}/${toolId}/`) && id.length > `${STORE_PREFIX_ROOT}/${toolId}/`.length
}

/** 宿主写文档的回报形态不止一种(bridge 的 putDoc 回 boolean,别处可能回 {ok});一律收口成布尔 */
function wroteOk(r: unknown): boolean {
  if (r === true) return true
  if (r && typeof r === 'object' && (r as { ok?: boolean }).ok === true) return true
  return false
}

/** 能力有没有给到:缺能力时对应 API 是**不存在**,所以这里只回答「该不该存在」 */
function has(o: GpmHost, c: GpmCapability): boolean {
  return Array.isArray(o.capabilities) && o.capabilities.includes(c)
}

async function callMaybe<T>(fn: unknown, ...args: unknown[]): Promise<T | null> {
  if (typeof fn !== 'function') return null
  return (await (fn as (...a: unknown[]) => unknown)(...args)) as T | null
}

/**
 * 组装一个工具的 ctx。
 *
 * 每换一个项目、每重进一次工具页都重新组一次(pid 注入进来就定死了这一轮的上下文)。
 */
export function buildGpm(host: GpmHost): GpmCtx {
  const o = host
  const svc = (o.services || {}) as GpmHost['services']
  const toolId = typeof o.toolId === 'string' ? o.toolId : ''
  const prefix = `${STORE_PREFIX_ROOT}/${toolId}/`

  const toolName = typeof o.toolName === 'string' ? o.toolName : ''
  const projectId = typeof o.projectId === 'string' ? o.projectId : ''
  const caps: readonly GpmCapability[] = Array.isArray(o.capabilities) ? Object.freeze([...o.capabilities]) : Object.freeze([])

  const ctx: GpmCtx = {
    // 三个身份字段用 getter 而不是普通属性:插件里 `ctx.projectId = '别的项目'` 在严格模式下会当场抛,
    // 而不是悄悄改掉这一轮读写的目标(Q26 的「pid 由框架注入」要有牙,不能只靠注释提醒)。
    get toolId() { return toolId },
    get toolName() { return toolName },
    get projectId() { return projectId },
    get capabilities() { return caps },
    vue: { h, ref, computed, onMounted },

    async listProjects() {
      const r = await callMaybe<unknown[]>(svc.listProjects)
      return Array.isArray(r) ? r : []
    },
    async getProject(id) {
      return await callMaybe<unknown>(svc.getProject, id || ctx.projectId)
    },

    async scanTree(opts) {
      const bad = { files: [] as TreeEntry[], truncated: false, error: '本工具没声明 tree 能力' }
      if (!has(o, 'tree')) return bad
      const r = await callMaybe<{ ok?: boolean, files?: TreeEntry[], truncated?: boolean, error?: string }>(
        svc.scanProjectTree, ctx.projectId, opts || {})
      if (!r || r.ok !== true || !Array.isArray(r.files)) {
        return { files: [], truncated: false, error: (r && typeof r.error === 'string' && r.error) || '文件树读不出来' }
      }
      return { files: r.files, truncated: r.truncated === true, error: '' }
    },

    async readText(rel, opts) {
      const bad = { text: '', truncated: false, skippedBinary: false, bytes: 0, error: '本工具没声明 text 能力' }
      if (!has(o, 'text')) return bad
      const r = await callMaybe<{ ok?: boolean, text?: string, bytes?: number, truncated?: boolean, skippedBinary?: boolean, error?: string }>(
        svc.readProjectText, ctx.projectId, rel, opts || {})
      if (!r || r.ok !== true) {
        return { text: '', truncated: false, skippedBinary: false, bytes: 0, error: (r && typeof r.error === 'string' && r.error) || '读取失败' }
      }
      // truncated / skippedBinary 一律原样透出:它们表示「ok 但没给正文」,
      // 插件若按「有正文」继续算,就会把空串当成一份合法的文件内容去改写
      return {
        text: typeof r.text === 'string' ? r.text : '',
        truncated: r.truncated === true,
        skippedBinary: r.skippedBinary === true,
        bytes: typeof r.bytes === 'number' ? r.bytes : 0,
        error: ''
      }
    },

    async hashPaths(rels) {
      const bad = { hashes: [] as { rel: string, sha256: string }[], failed: [] as unknown[], error: '本工具没声明 text 能力' }
      if (!has(o, 'text')) return bad
      const r = await callMaybe<{ ok?: boolean, hashes?: { rel: string, sha256: string }[], failed?: unknown[], error?: string }>(
        svc.hashPaths, ctx.projectId, Array.isArray(rels) ? rels : [])
      if (!r || r.ok !== true) return { hashes: [], failed: [], error: (r && typeof r.error === 'string' && r.error) || '哈希失败' }
      return { hashes: Array.isArray(r.hashes) ? r.hashes : [], failed: Array.isArray(r.failed) ? r.failed : [], error: '' }
    },

    async refIndex() {
      if (!has(o, 'ref')) return { index: null, error: '本工具没声明 ref 能力' }
      const t = await ctx.scanTree({})
      if (t.error) return { index: null, error: t.error }
      // 只喂 RefScanSource 的三个成员(tree/truncated/readText),这正是第 0 批 DEV-3 收窄入参换来的东西
      const index = await buildRefIndex({
        tree: t.files,
        truncated: t.truncated,
        readText: async (rel) => {
          const r = await ctx.readText(rel)
          if (r.error || r.truncated || r.skippedBinary) return { skipped: true }
          return { text: r.text }
        }
      })
      return { index, error: '' }
    },

    notify(text) {
      if (!has(o, 'ui')) { ctx.log('warn', '没声明 ui 能力,notify 被忽略'); return }
      void callMaybe(svc.notify, String(text ?? ''))
    },
    async openDialog(opts) {
      if (!has(o, 'ui')) return { paths: [], canceled: true }
      const r = await callMaybe<{ canceled?: boolean, filePaths?: string[] }>(svc.openDialog, opts)
      return { paths: r && Array.isArray(r.filePaths) ? r.filePaths : [], canceled: !r || r.canceled === true }
    },
    async saveDialog(opts) {
      if (!has(o, 'ui')) return { path: '', canceled: true }
      const r = await callMaybe<{ canceled?: boolean, filePath?: string }>(svc.saveDialog, opts)
      return { path: r && typeof r.filePath === 'string' ? r.filePath : '', canceled: !r || r.canceled === true }
    },
    copyText(text) {
      if (!has(o, 'ui')) { ctx.log('warn', '没声明 ui 能力,copyText 被忽略'); return }
      void callMaybe(svc.copyText, String(text ?? ''))
    },
    shellOpenPath(p) {
      if (!has(o, 'ui')) { ctx.log('warn', '没声明 ui 能力,shellOpenPath 被忽略'); return }
      void callMaybe(svc.shellOpenPath, String(p ?? ''))
    },

    log(level, msg) {
      if (typeof o.onLog === 'function') o.onLog(String(level), String(msg ?? ''))
    },
    progress(done, total) {
      const d = Number(done)
      const t = Number(total)
      if (!Number.isFinite(d) || !Number.isFinite(t) || t <= 0) return
      if (typeof o.onProgress === 'function') o.onProgress(Math.max(0, Math.min(d, t)), t)
    },
    get cancelled() {
      return typeof o.cancelled === 'function' ? o.cancelled() === true : false
    },
    onCancel(fn) {
      if (typeof fn === 'function' && typeof o.onCancel === 'function') o.onCancel(fn)
    }
  }

  // ---- store:只在声明了 store 能力时存在,且前缀由框架拼 ----
  if (has(o, 'store')) {
    ctx.store = {
      prefix,
      async get(key) {
        const g = storeKeyOf(toolId, key)
        if (!g.ok) { ctx.log('warn', g.error); return null }
        const doc = await callMaybe<Record<string, unknown> | null>(svc.getDoc, g.id)
        return doc && typeof doc === 'object' ? doc.value ?? null : null
      },
      async put(key, value) {
        const g = storeKeyOf(toolId, key)
        if (!g.ok) { ctx.log('warn', g.error); return false }
        // 存成一个带 value 字段的文档:LMDB 的文档必须是对象,而插件想存任意 JSON 值(含字符串与数字)
        const r = await callMaybe<unknown>(svc.putDoc, g.id, { value })
        return wroteOk(r)
      },
      async remove(key) {
        const g = storeKeyOf(toolId, key)
        if (!g.ok) { ctx.log('warn', g.error); return false }
        const r = await callMaybe<unknown>(svc.removeDoc, g.id)
        return wroteOk(r)
      }
    }
  }

  // ---- unsafe:true 才存在的裸写(§5.2:view 型的唯一写盘出口) ----
  if (o.unsafe === true) {
    ctx.writeText = async (rel, text) => await callMaybe(svc.writeProjectText, ctx.projectId, rel, text)
    ctx.movePathsToTrash = async (rels) => await callMaybe(svc.movePathsToTrash, ctx.projectId, Array.isArray(rels) ? rels : [])
    // 这里**没有 rename**:仓库里还没有项目内改名原语(§F DEV-11,第 2 批建)。
    // 宁可少给一个 API,也不拿 writeText + trash 拼一个会丢 .uid 边车与 mtime 语义的假改名。
  }

  return ctx
}

/** 给 UI/骨架看的「这一轮给了哪些能力」的一句话(措辞唯一来源) */
export function grantedText(ctx: GpmCtx): string {
  const caps = [...ctx.capabilities]
  const bare = ctx.writeText ? ' + 裸写(unsafe)' : ''
  return `${caps.length ? caps.join(' / ') : '无能力'}${bare}`
}

/** 类型守卫:渲染层拿到的 params 与 ctx 都来自插件产物,过一遍形状再传 */
export function isGpmCtx(x: unknown): x is GpmCtx {
  return !!x && typeof x === 'object' && typeof (x as GpmCtx).toolId === 'string' &&
    typeof (x as GpmCtx).readText === 'function'
}

/** 供 useToolPage 持有的进度/取消容器(框架侧,不是插件侧) */
export interface CancelBox {
  cancelled: boolean
  readonly ref: Ref<boolean>
  readonly isCancelled: () => boolean
  readonly onCancel: (fn: () => void) => void
  cancel(): void
  readonly callbacks: (() => void)[]
}

export function makeCancelBox(): CancelBox {
  const r = ref(false)
  const callbacks: (() => void)[] = []
  const box: CancelBox = {
    get cancelled() { return r.value === true },
    ref: r as Ref<boolean>,
    isCancelled: () => r.value === true,
    onCancel: (fn) => { if (typeof fn === 'function') callbacks.push(fn) },
    cancel() {
      if (r.value === true) return
      r.value = true
      for (const fn of [...callbacks]) {
        try { fn() } catch (e) { /* 一个回调炸了不许挡住其余的取消动作 */ }
      }
    },
    callbacks
  }
  return box
}

/** `ComputedRef` 只在进度条的显示上用,导出来是为了类型可复用 */
export type ProgressRef = ComputedRef<string>
