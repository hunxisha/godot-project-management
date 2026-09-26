// ZTools preload 的**沙箱边界声明**(路线 B:手写精简声明)。
//
// 为什么不用 `@types/node`:`docs/backup-redesign-plan.md` §15 记录过一次真实事故 ——
// preload 里用了 Node 专有的 `setImmediate`,只跑 Node 测试全绿,一进宿主就
// `setImmediate is not defined`。`@types/node` 会把 `setImmediate` 声明成合法全局,
// 编译器从此不再提醒这件事。这份声明**刻意不声明 `setImmediate`**,于是它始终是 TS2304
// —— 护栏交给编译器,而不是交给一份需要人工维护的白名单。
//
// 维护约定(新增 node API 用法时):
//   1. 先在这里补声明。**参数一律写实**,返回值是不透明对象时才用 `any`。
//   2. 回调参数写 `(...a: any[]) => void`:调用点就能拿到上下文类型,不必逐个补 JSDoc。
//   3. 懒得补声明就是「在扩大对宿主运行时能力的依赖」,那正是应该被 review 看到的改动。
//      能查到这个文件的人,也就看到了 §15 的教训。
//
// 已知的、有意为之的宽松处:`Buffer` 声明为 `any` 而不是完整接口。原因是
// `extract.js` 已经用 `ByteBuf` typedef 精确描述了**我们实际用到的 Buffer 子集**
// (索引签名 + 方法签名),那才是真实依赖面的清单;这里再写一份只会造成两份真相。
// `process` 则声明为具体结构(它的用法面很小且稳定)。

// ---------- 跨模块共用的不透明结构 ----------

/** 可写流(createWriteStream 的返回;用到 .on / .destroy / 被 pipe 接管) */
interface GpmWritable {
  on(ev: string, fn: (...a: any[]) => void): unknown
  destroy(): void
  write(data: any): boolean
  end(): void
}

/** 读/写流与 socket 的公共面 */
interface GpmSocket {
  on(ev: string, fn: (...a: any[]) => void): unknown
  destroy(): void
}

/** HTTP 响应(用到 statusCode / headers / resume / on / pipe) */
interface GpmIncoming {
  statusCode: number
  headers: Record<string, string>
  resume(): void
  on(ev: string, fn: (...a: any[]) => void): unknown
  pipe(dest: any): any
}

/** HTTP 请求句柄(用到 on / end / destroy) */
interface GpmRequest {
  on(ev: string, fn: (...a: any[]) => void): unknown
  end(): void
  destroy(): void
}

/** stat 结果(只声明被用到的字段) */
interface GpmStats {
  size: number
  mtime: any
  mtimeMs: number
  isDirectory(): boolean
  isFile(): boolean
}

/** 子进程句柄(spawn 的返回) */
interface GpmChildProcess {
  stdout: GpmSocket | null
  stderr: GpmSocket | null
  on(ev: string, fn: (...a: any[]) => void): unknown
  kill(signal?: string): boolean
  unref(): void
  pid?: number
}

// ---------- 全局 ----------

/**
 * Buffer 声明为 `any` 是**有意的**:真实依赖面由 `extract.js` 的 `ByteBuf` 描述。
 * 若将来 ByteBuf 不够用,应该先去扩它,而不是在这里放一个更松的接口。
 */
declare const Buffer: any

/** process 的用法面很小且稳定,因此写实结构(env 缺失值为 undefined,故用可选) */
declare const process: {
  nextTick(fn: (...a: any[]) => void): void
  platform: string
  env: Record<string, string | undefined>
  cwd(): string
  execPath: string
}

// 注意:这里**故意没有** `declare const setImmediate`。沙箱内不存在该全局,
// 让它在类型检查里保持报错,是 §15 那次事故留下的唯一自动护栏。

// ---------- node 内建模块 ----------

declare module 'node:fs' {
  /** readdirSync(withFileTypes) 的条目 */
  export interface Dirent {
    name: string
    isDirectory(): boolean
    isFile(): boolean
  }
  // 编码字面量优先,这样 readFileSync(p, 'utf8') 能拿到 string
  export function readFileSync(path: string, encoding: 'utf8' | 'utf-8' | 'ascii'): string
  export function readFileSync(path: string, encoding: string): any
  export function readFileSync(path: string): any
  export function writeFileSync(path: string, data: any, opts?: any): void
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, opts?: { recursive?: boolean; mode?: number }): string | undefined
  export function mkdtempSync(prefix: string): string
  export function readdirSync(path: string, opts: { withFileTypes: true }): Dirent[]
  export function readdirSync(path: string, opts?: any): string[]
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void
  export function rmdirSync(path: string): void
  export function unlinkSync(path: string): void
  export function renameSync(oldPath: string, newPath: string): void
  export function copyFileSync(src: string, dest: string): void
  export function cpSync(src: string, dest: string, opts?: any): void
  export function chmodSync(path: string, mode: number | string): void
  export function statSync(path: string): GpmStats
  export function fstatSync(fd: number): GpmStats
  export function openSync(path: string, flags: string): number
  export function closeSync(fd: number): void
  export function readSync(fd: number, buf: any, offset: number, length: number, position: number): number
  export function writeSync(fd: number, buf: any, offset?: number, length?: number, position?: number): number
  export function createWriteStream(path: string, opts?: any): GpmWritable
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export function dirname(p: string): string
  export function basename(p: string, ext?: string): string
  export function extname(p: string): string
  export const sep: string
}

declare module 'node:os' {
  export function tmpdir(): string
  export function homedir(): string
  export function platform(): string
  export function cpus(): any[]
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: any, inputEncoding?: string): any
    digest(encoding: 'hex' | 'base64'): string
    digest(): any
  }
  export function randomUUID(): string
  export function randomBytes(size: number): any
}

declare module 'node:zlib' {
  export function deflateRawSync(buf: any, opts?: any): any
  export function inflateRawSync(buf: any, opts?: any): any
  export function gunzipSync(buf: any, opts?: any): any
}

declare module 'node:events' {
  export class EventEmitter {
    on(ev: string, fn: (...a: any[]) => void): this
    once(ev: string, fn: (...a: any[]) => void): this
    off(ev: string, fn: (...a: any[]) => void): this
    emit(ev: string, ...args: any[]): boolean
    listenerCount(ev: string): number
    removeAllListeners(ev?: string): this
    /** http.js 的代理路径会在 stub 上挂这个方法来模拟请求句柄 */
    destroy(): void
  }
}

declare module 'node:url' {
  export class URL {
    constructor(input: string, base?: string)
    protocol: string
    hostname: string
    port: string
    pathname: string
    search: string
    username: string
    password: string
  }
}

declare module 'node:http' {
  export function request(opts: any, cb?: (res: GpmIncoming) => void): GpmRequest
  export function get(url: string, opts?: any, cb?: (res: GpmIncoming) => void): GpmRequest
}

declare module 'node:https' {
  export function get(
    url: string,
    opts: any,
    cb: (res: GpmIncoming) => void
  ): GpmRequest
  export function get(url: string, cb: (res: GpmIncoming) => void): GpmRequest
  export function get(opts: any, cb: (res: GpmIncoming) => void): GpmRequest
  export function request(opts: any, cb?: (res: GpmIncoming) => void): GpmRequest
}

declare module 'node:tls' {
  export function connect(opts: any, cb?: () => void): GpmSocket
}

declare module 'node:child_process' {
  /** 与全局 GpmChildProcess 同一份描述,避免两处各写一遍然后漂移 */
  export type ChildProcess = GpmChildProcess
  export function spawn(command: string, args?: string[], opts?: any): ChildProcess
  export function exec(command: string, opts?: any, cb?: (...a: any[]) => void): ChildProcess
  export function execFile(file: string, args?: string[], opts?: any, cb?: (...a: any[]) => void): ChildProcess
  export function execSync(command: string, opts?: any): any
}
