// 项目文件树的纯函数工具(spec §5.1)。全部不依赖宿主:进 TreeEntry[]、出统计,可单测。
//
// 红线:这里**不许**碰 window / services / DOM / vue —— 渲染层要能在 Node 里被打包测试,
// 而且同一批统计口径将来还会被 Tauri 端复用。rel 的形状由原语层保证(inspectfs.js /
// src-tauri 的 scan):正斜杠、相对项目根、保留原始大小写,ext 为小写无点(无点则空串)。
import type { TreeEntry } from '../types/godot'

/**
 * 是否 `.godot` 缓存目录下的条目。
 *
 * 按**路径段**逐段比对,而不是子串匹配:
 *   · 子串匹配(`rel.includes('.godot')`)会把 `project.godot` 误判成缓存 —— 每个 Godot
 *     项目根下都必有 project.godot,一旦误判,「缓存体积」和「源码体积」两条统计同时错。
 *   · 目录名叫 `res.godot`(或文件 `a.godot`)也不该算缓存,同理。
 *   · 与 Rust 侧同源:`src-tauri/src/inspectfs.rs` 的判据就是
 *     `rel.split('/').any(|c| c == ".godot")`,两端必须同语义,否则双端体检结果对不上。
 * 认任意层级(Godot 允许子目录里也有 .godot),也认裸的 `.godot` 这一段。
 */
export function isCache(rel: string): boolean {
  if (typeof rel !== 'string' || !rel) return false
  return rel.split('/').some((c) => c === '.godot')
}

/** 去掉缓存条目,只留源文件/资源(体积与数量统计的常用口径) */
export function noCache(tree: TreeEntry[]): TreeEntry[] {
  return tree.filter((f) => !isCache(f.rel))
}

/**
 * 路径里任意一段是 `.git` ⇒ 这条是 VCS 元数据,不是项目的源文件。
 *
 * 为什么单独一份(spec §3.1 的口径修补,2026-10-05):`scanProjectTree(pid, { includeCache: true })`
 * 不给 skipDirs,而 fsutil 的 `makeExcluder(undefined)` 返回 null = 什么都不排除,所以 `.git/**`
 * 会整批进清单。混在「源文件」里的后果有两处,都不小:体积卡把一个有二进制历史的项目报成
 * 「源文件几百 MB」,cache 卡的膨胀分母被 VCS 对象撑大到漏报。
 * 与 `isCache` 同一条理由按**路径段**而不是子串判:`foo/gitbar/`、`my.git/` 都不算。
 */
export function isVcs(rel: string): boolean {
  if (typeof rel !== 'string' || !rel) return false
  return rel.split('/').some((c) => c === '.git')
}

/**
 * 「源文件」的**唯一**口径:既不是引擎缓存、也不是 VCS 元数据。
 * size 与 cache 两张卡共用它 —— 分叉成两份判据的话,两张卡会对同一个项目说两种话。
 * 刻意不叫 `noCache` 的近义词:`noCache` 只排缓存,那一条另有「缓存 vs 源」二分处的用法。
 */
export function sourceFiles(tree: TreeEntry[]): TreeEntry[] {
  return tree.filter((f) => f && !isCache(f.rel) && !isVcs(f.rel))
}

export function sumBytes(tree: TreeEntry[]): number {
  return tree.reduce((a, f) => a + f.size, 0)
}

export interface ExtGroup { ext: string; bytes: number; count: number }

/**
 * 三个 top-N 函数共用的截取规则(审查 F-2):**n 省略或 <= 0 → 返回整个降序清单**;
 * n > 0 → 取前 n(n 超长自然得全量)。
 *
 * 为什么 0 不返回空:对体积排名来说「看 0 组」不是一个请求,静默给空数组比给全量
 * 更糟(界面上会渲染出一块「什么都没有」的空白)。旧实现三处分叉 —— 两个 group 函数
 * `n ? slice(0,n) : out`(0=全量、-1=悄悄丢最小一组)、topFiles `slice(0, Math.max(0,n))`
 * (0/-1=空)—— 统一收敛到这一个实现,防止再各漂各的。
 */
function takeTop<T>(sorted: T[], n?: number): T[] {
  return typeof n === 'number' && n > 0 ? sorted.slice(0, n) : sorted
}

/** 按扩展名聚合(体积降序);ext 为空串时归入 `(无扩展名)`。n 省略或 <= 0 → 返回全部组 */
export function groupByExt(tree: TreeEntry[], n?: number): ExtGroup[] {
  const m = new Map<string, ExtGroup>()
  for (const f of tree) {
    const k = f.ext || '(无扩展名)'
    const g = m.get(k) || { ext: k, bytes: 0, count: 0 }
    g.bytes += f.size
    g.count += 1
    m.set(k, g)
  }
  return takeTop([...m.values()].sort((a, b) => b.bytes - a.bytes), n)
}

export interface DirGroup { dir: string; bytes: number; count: number }

/** 按顶层目录聚合(体积降序);根目录文件归入 `(根目录)`。n 省略或 <= 0 → 返回全部组 */
export function groupByTopDir(tree: TreeEntry[], n?: number): DirGroup[] {
  const m = new Map<string, DirGroup>()
  for (const f of tree) {
    const i = f.rel.indexOf('/')
    const k = i < 0 ? '(根目录)' : f.rel.slice(0, i)
    const g = m.get(k) || { dir: k, bytes: 0, count: 0 }
    g.bytes += f.size
    g.count += 1
    m.set(k, g)
  }
  return takeTop([...m.values()].sort((a, b) => b.bytes - a.bytes), n)
}

/** 体积最大的前 n 个文件(降序);n 省略或 <= 0 → 返回整个清单(与 groupBy* 同规则)。不改动入参:先复制再排序 */
export function topFiles(tree: TreeEntry[], n?: number): TreeEntry[] {
  return takeTop([...tree].sort((a, b) => b.size - a.size), n)
}

/** rel 查表集:断链检查按 rel 判存在性,O(1) */
export function relSet(tree: TreeEntry[]): Set<string> {
  return new Set(tree.map((f) => f.rel))
}

/**
 * 任意 rel 串集合 → 小写像(B6 评审裁定 2 收到的共享底座:原来三份各写一遍)。
 *
 * 为什么要有这一份:Windows 文件系统大小写不敏感,同一个目标的 `Art/A.PNG`、`art/a.png`、
 * `ART/a.Png` 在盘上是**同一个文件**。工具页里三条拿「清单里查得到/查不到」当证据的判据
 * (imports 的失效边车与缺边车、uid 的孤儿与缺边车、orphans 的引用比对)都会撞上同一件事:
 * 只用原样 rel 判,就会把「其实存在、只是写法不同」的东西说成不存在 —— 而这三条里有一条带着删除按钮。
 *
 * ⚠ 方向纪律:小写像只会让「查得到」更容易成立,于是
 *   · 「查不到 ⇒ 主张(缺失/失效/孤儿)」那一侧永远只会**少报**(安全,本工具唯一的破坏面方向);
 *   · 「别人的边车在 ⇒ 闸门放行」那一侧会**解除抑制**,但解出来的主张是真的(主体自己确实没有边车)。
 * 两条工具的调用点各自注释,别在这里笼统承诺「只会藏」。
 *
 * 红线:纯函数;`tree` 里混进非字符串 rel 时跳过(与原语两端的防御口径一致)。
 */
export function lowerSet(values: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const v of values) {
    if (typeof v === 'string' && v) out.add(v.toLowerCase())
  }
  return out
}

/** relSet 的大小写不敏感版:把整份清单的 rel 收成小写像(存在性比对的唯一一份小写口径) */
export function lowerRelSet(tree: TreeEntry[]): Set<string> {
  return lowerSet(tree.map((f) => (f && typeof f.rel === 'string' ? f.rel : '')))
}

/**
 * 字符串**码元序**(UTF-16)比较器 —— 全站结论顺序、`related`、`rels` 排序的唯一一份判据。
 *
 * 为什么收成一份(B10b 债 8):这条判据原本有五份逐字相同的副本(`uid` / `orphans` / `imports` /
 * `addons` / `format` 各一份),而它决定的是**用户看到的顺序与结论 id 的稳定性** ——
 * 「改一处、另一处悄悄留在旧口径」正是本仓点名的 hazard(见 finding.ts:3-8、fixPlan.ts:58-65)。
 * `ini.ts` 那侧本来就没再抄一份(它用数组默认 `.sort()`,同为 UTF-16 码元序),这条不在收敛范围内。
 *
 * ⚠ 为什么是 `<`/`>` 而不是 `localeCompare`:locale 随宿主语言环境变,而排序结果会进
 * `Finding.id`、`related` 与确认框的执行清单 —— 换台机器就换一批结论键是不可接受的。
 * 这条不是风格问题:各工具文件头写的那句「逐字节确定」全靠它。
 *
 * 红线:纯函数,不碰任何宿主对象;调用方自己保证传字符串(与原来那五份实现同一前提,不加运行时判型)。
 */
export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * rel 的扩展名(小写、无点),与**两端原语逐字同形**:
 *   · JS  端 `src-ztools/preload/lib/inspectfs.js:263` 的 `path.extname(rel).slice(1).toLowerCase()`
 *   · Rust 端 `src-tauri/src/inspectfs.rs:83-88` 的 `ext_of(name)`,name 就是文件名(按最后一个点切)
 * (两端形状记录同时见 `refIndex.ts:59-63`。basename 以 `.` 开头 → 空串,不是「整段当扩展名」。)
 *
 * 什么时候用它、什么时候不用(B10b 债 8 把 imports.ts 那份生产实现收进来,口径原样搬,一条判定没改):
 *   · 清单里的条目**一律用 `TreeEntry.ext`**(原语已经算好,别在这里重算第二套口径);
 *   · 只有「rel 是拼出来的、清单里没有对应条目」时才用它 —— 例如边车名切掉 `.import` 之后那个资源
 *     (源已被删掉/边车被改名)、`source_file` 指出去的那条路径。
 *
 * 测试夹具里也各留了一份同规则的实现(extOf 在 tools/uid/orphans/imports/refIndex/addons/format/ini
 * 的 .test.mjs 里各有的一份,共 9 份:再加 gate)—— 那是**刻意的独立重述**,用来钉「夹具与两端原语同口径」;
 * 把夹具改成调用这里的实现就等于自己给自己背书,所以没收,但 tools.test.mjs 另加了一条两侧逐字一致的比对。
 */
export function extOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/**
 * 顶层或任一段叫 `addons` 的条目(**精确大小写**,B10b 债 8 从 orphans.ts / imports.ts 两份相同实现收进来)。
 *
 * 用途:addons/ 内部整体不进候选 —— 归 B7 的插件体检管(orphan 与 import 两条判据都这么让路)。
 * 这一侧漏判 `Addons/` 的代价是**少报一条结论**(方向安全),所以保持精确比对。
 *
 * ⚠ 与 `hasAddonSegCI` 是**刻意的两份**,不是分叉:格式化工具要挡的是「改写第三方插件的代码」,
 *   那种漏判是越界改动而不是少报,所以那边必须大小写不敏感(Windows 上 `Addons/` 与 `addons/` 是同一个目录)。
 *   合并成一条就有一侧的方向被反过来 —— 两边的注释各自记着理由,别在这里笼统统一。
 */
export function hasAddonSeg(rel: string): boolean {
  return rel.split('/').includes('addons')
}

/** `hasAddonSeg` 的大小写不敏感版:给「漏判会越界动文件」的那一侧用(见 format.ts 的读入面判据) */
export function hasAddonSegCI(rel: string): boolean {
  return rel.split('/').some((c) => c.toLowerCase() === 'addons')
}


/** 小写像里认不认得 rel(任意大小写写法命中都算) —— 传进来的必须是 lowerSet/lowerRelSet 的产物 */
export function hasRelCI(lower: Set<string>, rel: string): boolean {
  return typeof rel === 'string' && !!rel && lower.has(rel.toLowerCase())
}

/**
 * `.gdignore` 屏蔽目录集合(B6 评审 Important 1)。
 *
 * 引擎的语义(Godot 官方:`.gdignore` 是放在**目录里**的空标记文件,编辑器扫描时跳过该目录**及其所有子目录**):
 * `art/.gdignore` 屏蔽 `art/` 与 `art/**`。仓库里已经有两处把这份标记当回事
 * (`src-ztools/preload/lib/assetsinstall.js:96` 安装资产时显式不搬它、`src-tauri/src/main.rs:596` Rust 侧同规则),
 * 所以它不是本工具臆造的目录概念。
 * 标记条目回到 ctx.tree 时是点文件:`ext === ''`(见 tools.test.mjs:107「点文件与无点文件合并进 (无扩展名) 组」),
 * 所以这里按 **basename** 判,不看 ext。
 *
 * 返回的是**目录前缀**(含尾斜杠、已小写);根目录的标记给空串 `''`,含义是「整棵树都被屏蔽」。
 * 与 isCache 同理由按路径段而不是子串匹配:前缀必须停在 `/` 上,否则 `art/` 的标记会把 `arts/`、`art2/` 一起藏掉。
 */
export function gdignoredDirs(tree: TreeEntry[]): Set<string> {
  const out = new Set<string>()
  for (const f of tree) {
    const rel = f && typeof f.rel === 'string' ? f.rel : ''
    if (!rel) continue
    const base = rel.slice(rel.lastIndexOf('/') + 1)
    // 标记名按小写比对:Windows 上不敏感(盘上可能是 `.GDIGNORE`),而这一侧多匹配只会**少报**结论
    if (base.toLowerCase() !== '.gdignore') continue
    out.add(dirOf(rel).toLowerCase())
  }
  return out
}

/** rel(某个文件)是否落在某个被 `.gdignore` 屏蔽的目录里 —— 逐级祖先比对,含根标记给出的空前缀 */
export function isGdignored(dirs: Set<string>, rel: string): boolean {
  if (!dirs || dirs.size === 0) return false
  if (dirs.has('')) return true // 根目录的标记屏蔽整棵树
  if (typeof rel !== 'string' || !rel) return false
  const lower = rel.toLowerCase()
  let i = lower.indexOf('/')
  while (i >= 0) {
    if (dirs.has(lower.slice(0, i + 1))) return true
    i = lower.indexOf('/', i + 1)
  }
  return false
}

/** rel 的目录部分(含尾斜杠);根目录文件返回空串 */
export function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i + 1)
}

/**
 * 字节数 → 人类可读(1024 进制)。负数 / NaN / Infinity 一律给 `0 B`,不在界面上显示 'NaN KB'。
 *
 * ⚠ 本应用里已有另一个字节格式化函数:`src/utils/format.ts:2` 的 `fmtSize`
 * (资产页 / 备份页在用,输出整数风格,如 `1024 KB` / `3 MB`)。两者**刻意不同** ——
 * 工具页计划书钉死的是「一位小数」口径(`1.0 KB` / `1.4 MB`)。是否全站统一成一份
 * 文案属产品决策,留待终审由人拍板,本轮**不合并**(审查 F-4 裁决:只登记不合并)。
 * 新代码请勿再写第三份。
 */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  // 档位估算要双向钳制:下界 0(小数输入 log 为负,floor 出 -1,u[-1] 会印出
  // "409.6 undefined" —— 旧代码只钳了上界),上界最后一档 TB。
  let i = Math.min(Math.max(Math.floor(Math.log(n) / Math.log(1024)), 0), u.length - 1)
  let v = n / Math.pow(1024, i)
  // 显示进位则升一级:1048575 的档位估算是 KB、v=1023.999,`.toFixed(1)` 却印成
  // "1024.0 KB"(B 档同理,1023.5 → "1024 B")。判据必须看**渲染值**而不是 v 本身 ——
  // 单纯 `v >= 1024` 抓不到 1023.999。有更高档才升;顶档没有,接受 "1024.0 TB" 饱和。
  const rendered = i === 0 ? Math.round(v) : Number(v.toFixed(1))
  if (rendered >= 1024 && i < u.length - 1) {
    i++
    v = n / Math.pow(1024, i)
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${u[i]}`
}

/**
 * 毫秒 → 人类可读(扫描耗时展示,`900 ms` / `2.5 s`)。
 *
 * ⚠ 与 `src/utils/format.ts:37` 的 `fmtDuration`(项目卡片 / 备份列表在用,中文文案:
 * `2.5 秒`、超过一分钟折算成 `1 分 05 秒`)是双胞胎,**输出刻意不同**:工具页计划书
 * 钉的是紧凑英文单位串,且不做分钟折算(扫描耗时以秒为量级)。全站统一与否同 `fmtBytes`,
 * 待终审决策,本轮不合并。
 */
export function fmtMs(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 ms'
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`
}

/**
 * 根目录某个文件名在**清单里真存在的那个写法**(优先引擎自己的拼写,其次大小写异体里码元序第一个)。
 *
 * 为什么要共享(B8 修复轮 Minor 6):`inspectors/ini.ts` 的根配置选举与 `inspectors/addons.ts`
 * 原来的 `iniRelOf` 是同一条规则,两份各写一遍就是下一条分叉之路(与本文件 `lowerSet` 当初的
 * 收敛理由同源 —— 三份各写一遍的小写像,审查后才合并)。语义逐条对齐原来那两份实现:
 *   · **只认根目录那一份** —— 带 `/` 的 rel 是子目录里的同名文件,不是项目配置;
 *   · 优先逐字拼写(引擎写盘就是那个名字),没有再退到大小写异体里码元序最小的那个;
 *   · 返回的是**清单里那个写法**而不是硬拼的入参:硬拼 `project.godot` 在只有 `Project.godot`
 *     的清单上会读空(Windows 上本就是同一个文件),而结论的 rel 还要进 related/跳转,
 *     指一个清单里没有的名字就是死链。
 *
 * 红线:纯函数;非字符串 rel 跳过(与 lowerRelSet 同一防御口径);`basename` 按小写常量传入。
 */
export function rootRelOf(tree: TreeEntry[], basename: string): string | undefined {
  let alt: string | undefined
  for (const f of tree) {
    const rel = f && typeof f.rel === 'string' ? f.rel : ''
    if (!rel || rel.includes('/')) continue
    if (rel === basename) return rel
    if (rel.toLowerCase() === basename && (alt === undefined || rel < alt)) alt = rel
  }
  return alt
}
