// 项目体检用的文件系统原语(见 docs/tools-page-plan.md §5.4)。
//
// 设计红线:
//   · 渲染层只拿 rel(相对项目根、正斜杠),绝对路径由这里拼 —— 误删面最小,
//     也让 JS / Rust 两端只需比对 rel/size 序列就能验证 parity。
//   · 读 / 写 / 删的 rel 过两道闸:resolveRel 挡字面越界(`..`、绝对路径、盘符),
//     resolveInside 再挡「项目内的符号链接指向项目外」(realpath 后必须仍在根内)。
//     第一道只看 rel 的字面形态,第二道才看真实落点 —— 读取漏第二道只是泄漏内容,
//     写 / 删漏第二道改的就是**别人家的文件**(资产站 zip 解压正是项目内长链接的主路径)。
//     遍历(scanProjectTree)不走这两道闸:它只列出 root 下的条目、由 fsutil.walkFiles
//     自己逐级下钻,既不接收外部 rel 也不写盘,没有可越界的入参。
//   · 读 / 写 / 删原语都不抛异常,一律返回 { ok:false, error } —— 工具页要在结论里显示原因。
const fs = require('node:fs')
const path = require('node:path')
const { getDoc } = require('./store')
const { walkFiles, makeExcluder, stampSec, rmQuiet, uniquePath, trashPaths } = require('./fsutil')

const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_ENTRIES = 200000

/**
 * projectId(完整文档 id,如 godot/project/xxx)→ 项目根;拿不到返回 null
 * @param {string} projectId
 * @returns {string|null}
 */
function projectRoot(projectId) {
  const doc = projectId ? getDoc(String(projectId)) : null
  return doc && doc.path ? String(doc.path) : null
}

/**
 * rel → 绝对路径。越界/绝对/含 `..` 一律返回 null。
 * @param {string|null} root
 * @param {unknown} rel
 * @returns {string|null}
 */
function resolveRel(root, rel) {
  if (!root || typeof rel !== 'string' || !rel) return null
  const norm = rel.replace(/\\/g, '/')
  if (norm.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(norm)) return null
  const stack = []
  for (const p of norm.split('/')) {
    if (!p || p === '.') continue
    if (p === '..') return null
    stack.push(p)
  }
  if (!stack.length) return null
  return path.join(root, ...stack)
}

/**
 * 文本闸 + **真实路径包含校验**:用来挡住「项目内的符号链接指向项目外」这类绕过。
 * 目标不存在时(将要新建的文件),退到**最近的已存在祖先**做包含校验。
 * realpath 失败(权限等)按保守处理:拒绝。
 *
 * 为什么需要第二道闸:resolveRel 只做字面判断(`..` / 绝对 / 盘符),而 fs.statSync、
 * fs.readFileSync 会跟随符号链接 —— 项目内一条指向 ~/.ssh/id_rsa 的链接就能读出去。
 * 资产站 zip 解压正是项目内出现符号链接的主路径。错误串**刻意复用** '非法路径':
 * 不新增文案、不透露被挡掉的到底是哪一类(Rust 侧 Task 6-7 也只需镜像同一批串)。
 * @param {string|null} root
 * @param {unknown} rel
 * @returns {{abs?: string, error?: string}}
 */
function resolveInside(root, rel) {
  if (!root) return { error: '项目不存在' }
  const abs = resolveRel(root, rel)
  if (!abs) return { error: '非法路径' }
  let realRoot
  try { realRoot = fs.realpathSync(root) } catch (e) { return { error: '路径无法解析' } }
  let real
  if (fs.existsSync(abs)) {
    try { real = fs.realpathSync(abs) } catch (e) { return { error: '路径无法解析' } }
  } else {
    // 目标还不存在(写新文件的路径):逐级上溯到最近的已存在祖先,realpath 它,再把剩余段接回去
    const rest = []
    let cursor = abs
    /** @type {string|null} */
    let ancestor = null
    for (;;) {
      rest.unshift(path.basename(cursor))
      const parent = path.dirname(cursor)
      if (!parent || parent === cursor) break // 已到文件系统根仍不存在
      cursor = parent
      if (fs.existsSync(cursor)) {
        try { ancestor = fs.realpathSync(cursor) } catch (e) { return { error: '路径无法解析' } }
        break
      }
    }
    if (!ancestor) return { error: '目标目录不存在' }
    real = path.join(ancestor, ...rest)
  }
  // 包含比较的前缀:**先剥掉 realRoot 的结尾分隔符再补一个**。realpathSync 对文件系统根
  // ('C:\\'、'/')会保留尾分隔符,直接 realRoot + path.sep 就得到 'C:\\\\' / '//',
  // 而没有任何子路径以它开头 —— 项目正好装在盘根时,每一次合法写/删都会被误判 '非法路径'。
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  if (real !== realRoot && !real.startsWith(prefix)) return { error: '非法路径' }
  return { abs } // 返回 resolveRel 的原始 abs:普通文件行为与今日逐字节一致,rel 仍是对外唯一的键
}

/**
 * 读项目内文本文件。默认限额 1MB;超限只报 truncated,不返回内容。
 * 前 512 字节含 NUL 视为二进制(不按扩展名维护黑名单)。
 * @param {string} projectId
 * @param {string} rel
 * @param {{maxBytes?:number}} [opts]
 * @returns {import('../../../src/types/godot').ReadTextResult}
 */
function readProjectText(projectId, rel, opts) {
  const o = opts || {}
  const root = projectRoot(projectId)
  const g = resolveInside(root, rel)
  const abs = g.abs
  if (!abs) return { ok: false, error: g.error || '非法路径' }
  let st
  try { st = fs.statSync(abs) } catch (e) { return { ok: false, error: '文件不存在' } }
  if (!st.isFile()) return { ok: false, error: '文件不存在' }
  const max = o.maxBytes && o.maxBytes > 0 ? o.maxBytes : DEFAULT_MAX_BYTES
  if (st.size > max) return { ok: true, bytes: st.size, truncated: true }
  let buf
  try { buf = fs.readFileSync(abs) } catch (e) { return { ok: false, error: '读取失败' } }
  if (buf.subarray(0, 512).includes(0)) return { ok: true, bytes: st.size, skippedBinary: true }
  // bytes 取 buf.length 而不是 st.size:stat 与 read 之间 Godot 编辑器可能改写过文件,
  // 只有刚读进内存的字节数才真正描述返回的这段 text。
  return { ok: true, text: buf.toString('utf8'), bytes: buf.length, truncated: false }
}

/**
 * rel → **目录前缀**(规范正斜杠、带尾斜杠;项目根下的文件返回 '')。
 * 与 resolveRel 用同一套切段归一(`./`、重复斜杠、反斜杠都吃掉),所以这里产出的前缀
 * 与 scanProjectTree 给出的 rel **同形** —— 对外只有 rel 这一个键,渲染层就是按 rel 找文件的。
 * (刻意不用 path.relative:它没在 sandbox.d.ts 里声明,不值得为一段字符串拼接扩大沙箱声明面。)
 * @param {unknown} rel
 * @returns {string}
 */
function relDirPrefix(rel) {
  const stack = []
  for (const p of String(rel == null ? '' : rel).replace(/\\/g, '/').split('/')) {
    if (!p || p === '.') continue
    if (p === '..') return '' // 越界早被 resolveRel 拒了,这里只是防御性收口
    stack.push(p)
  }
  stack.pop() // 最后一段是文件名,不属于前缀
  return stack.length ? `${stack.join('/')}/` : ''
}

/**
 * 写项目内文本文件:**同目录临时文件 + rename** 原子落盘,默认先把原文件备份成
 * `<名><扩展>.gpm-bak-<stampSec>`(marker 收尾,例:`player.gd.gpm-bak-20260301_1200_00`)。
 * 备份名**不保留原扩展名收尾**:否则 `player.gpm-bak-<ts>.gd` 仍以 .gd 结尾,Godot 会把它
 * 当成真脚本导入、scanProjectTree 会把它数成一份真实 .gd 资源、
 * 导出预设 `filter include *` 甚至能把它一起打进发布包。不自动创建目录(避免把 typo 路径变成新文件)。
 * 注意:fsutil.tempPath 对文件会加 `.zip` 后缀,这里不能用它。
 *
 * 闸用 resolveInside 而不是 resolveRel:写是**动物件**的一翼。项目内一条指向项目外的
 * 符号链接在字面闸看来完全合法(resolveRel 只看 rel 的形态),真实落点却在项目外 ——
 * 读取时这只是泄漏内容,写入时它改的是别人的文件。
 * 错误串一律取闸返回的原话('项目不存在' / '非法路径' / '路径无法解析' / '目标目录不存在'),
 * 备份与写入各自的失败也只报 '备份失败' / '写入失败':工具页要把原因显示给用户,
 * 而 Node 的 EPERM 英文串既不稳定也无处对照(Rust 侧 Task 7 逐字镜像同一批串)。
 * @param {string} projectId
 * @param {string} rel
 * @param {string} text
 * @param {{backup?:boolean}} [opts]
 * @returns {import('../../../src/types/godot').WriteTextResult}
 */
function writeProjectText(projectId, rel, text, opts) {
  const o = opts || {}
  const root = projectRoot(projectId)
  const g = resolveInside(root, rel)
  const abs = g.abs
  if (!abs) return { ok: false, error: g.error || '非法路径' }
  if (typeof text !== 'string') return { ok: false, error: '内容不是文本' }
  let isDir = false
  let exists = false
  try {
    const st = fs.statSync(abs)
    if (st.isDirectory()) isDir = true
    else if (st.isFile()) exists = true
    // stat 问得到、但既不是目录也不是**普通文件**(FIFO / socket / 设备文件):
    // 当「普通文件」去 copyFileSync,读一个没人写的 FIFO 会把 preload 线程挂死(整个界面冻结);
    // 当「不存在」去 rename,就是把名字覆到特殊文件上。两边都只能拒。
    else return { ok: false, error: '写入失败' }
  } catch (e) {
    // **只有 ENOENT** 才是「原文件不存在」(那是新建文件,本来就不需要备份)。
    // EACCES / ELOOP / EIO 意味着文件在、只是我们问不到它:当成不存在就等于不备份直接覆写,
    // 把用户唯一的退路烧掉 —— 比这次干脆不写更糟。
    if (!e || e.code !== 'ENOENT') return { ok: false, error: '写入失败' }
  }
  if (isDir) return { ok: false, error: '不能覆盖目录' }
  const dir = path.dirname(abs)
  // 缺父目录一律拒绝而不是 mkdir -p:否则一个拼错的 rel 会在项目里静默长出垃圾目录树。
  if (!fs.existsSync(dir)) return { ok: false, error: '目标目录不存在' }

  const ext = path.extname(abs)
  const base = path.basename(abs, ext)
  // 临时名以目标**真实扩展名**结尾(与 fsutil.tempPath 的 .zip 形态区分开)。
  // flag 'wx' = 独占创建:临时名 `.gpm-tmp-<毫秒>-<base><ext>` 是可预测的,而包含闸只审过最终
  // abs、没审 tmp —— 项目里预置一个同名文件(最坏是同名符号链接指向项目外)时,普通写入会
  // 跟随它把内容落到别人名下;wx 让「名字已被占」当场失败,宁可这次不写。
  const tmp = path.join(dir, `.gpm-tmp-${Date.now()}-${base}${ext}`)
  let backupRel
  if (exists && o.backup !== false) {
    const bak = `${base}${ext}.gpm-bak-${stampSec()}`
    // stampSec 只到秒 → 同一秒内第二次改同一个文件必然撞同一个名字,copy 上去就是把**上一次的
    // 备份**(用户以为还能还原到那一版)静默销毁。uniquePath 在没有碰撞时原样返回,
    // 碰撞时退到 `<bak>_2` 这类没人占的名字。
    const bakAbs = uniquePath(path.join(dir, bak))
    try {
      fs.copyFileSync(abs, bakAbs)
    } catch (e) {
      // copyFileSync 可能已经写了半截:半份备份比没有备份更危险(用户会拿它还原)。
      // 这里的删除是**无条件安全**的 —— bakAbs 由 uniquePath 挑出来,挑的时候那个名字还不存在,
      // 所以那个路径上若有东西,一定是这次刚写出来的半截。
      // (旧实现在此靠 `bakPreExisted` 守卫跳过清理,那是为了「撞名时不删上一份真备份」;
      //  那种撞名现在由 uniquePath 直接换名避开,守卫反而算错了对象 —— 它查的是碰撞前的名字,
      //  于是清理被跳过、半截备份留在盘上。测试第 5 节 ① 钉住这一点。)
      rmQuiet(bakAbs)
      return { ok: false, error: '备份失败' }
    }
    // backupRel 回的是**真实落盘的那个名字**(换名后可能与 bak 不同)+ 规范化的目录前缀。
    backupRel = relDirPrefix(rel) + path.basename(bakAbs)
  }
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' })
    fs.renameSync(tmp, abs)
  } catch (e) {
    // 失败路径一律清临时文件:原文件此刻还是旧的,磁盘上不该留下 .gpm-tmp-* 残骸。
    rmQuiet(tmp)
    return { ok: false, error: '写入失败' }
  }
  return { ok: true, backupRel }
}

/**
 * 遍历项目文件树。默认**跳过**任意层级的 `.godot`(与 fsutil.walkFiles 的默认相反)。
 * @param {string} projectId
 * @param {{includeCache?:boolean, exts?:string[], skipDirs?:string[], maxEntries?:number}} [opts]
 * @returns {import('../../../src/types/godot').ScanTreeResult}
 */
function scanProjectTree(projectId, opts) {
  const o = opts || {}
  const root = projectRoot(projectId)
  if (!root) return { ok: false, error: '项目不存在' }
  if (!fs.existsSync(root)) return { ok: false, error: '项目目录已不存在' }
  const exts = Array.isArray(o.exts) && o.exts.length
    ? new Set(o.exts.map((e) => String(e).toLowerCase().replace(/^\./, '')))
    : null
  const max = o.maxEntries && o.maxEntries > 0 ? o.maxEntries : DEFAULT_MAX_ENTRIES
  /** @type {import('../../../src/types/godot').TreeEntry[]} */
  const files = []
  let walked
  try {
    walked = walkFiles(root, {
      includeCache: o.includeCache === true,
      exclude: makeExcluder(o.skipDirs)
    })
  } catch (e) {
    return { ok: false, error: (e && e.message) || '遍历失败' }
  }
  for (const f of walked) {
    const rel = String(f.rel).split(path.sep).join('/')
    const ext = path.extname(rel).slice(1).toLowerCase()
    if (exts && !exts.has(ext)) continue
    let st
    try { st = fs.statSync(f.abs) } catch (e) { continue }
    files.push({ rel, size: st.size, mtimeMs: Math.round(st.mtimeMs), ext })
    if (files.length >= max) return { ok: true, files, truncated: true }
  }
  return { ok: true, files, truncated: false }
}

/**
 * 批量移入回收站(Windows)/永久删除(其他平台,见 fsutil.trashPath :215-219)。
 * 单个失败**不中断其余**,失败项原样返回 { rel, error } —— 调用方据此提示「N 项成功、M 项失败」;
 * ok 仅在零失败时为 true,moved 只计真正成功的那几项。空清单不是错误(→ ok:true, moved:0)。
 *
 * rels **必须是数组**:不是数组(含字符串)一律按空清单处理。兄弟原语 readProjectText /
 * writeProjectText 收的是单个 rel 字符串,把同一个串手滑传进这个批量接口是真实形态,而字符串可迭代 ——
 * 按 `for (const raw of rels)` 会把它**拆成字符**('a.txt' → 'a' / '.' / 't' / 'x' / 't'),
 * 项目根上任何单字符名字的文件都会被这一下送进回收站;`{}` / 数字则会直接抛 TypeError,
 * 违反本模块「读 / 写 / 删原语都不抛异常」的红线。
 *
 * 计数与复核的三条约定:
 *   · **按解析后的绝对路径去重**:同一个文件被点名两次('g.txt' 与 './g.txt' 也是同一个)只交批量一次,
 *     回报沿用**首次出现**的那个 rel 串。不去重时 moved 会算歪 —— 失败集合是去重的、items 不是,
 *     ['x','x'] 全失败也报 moved:1,而盘上什么都没少,且同一个 rel 在 failed 里出现两遍。
 *   · **批次跑完后按磁盘实况复核**,fsutil.trashPaths 的回报不再作为计数依据(两个方向都会谎报):
 *     批前逐项 stat、批后「没抛异常就算成功」在 ['sub','sub/c.txt'] 上是错的 —— 父目录整棵先走,
 *     随后对**已消失**的 sub/c.txt 报错 → 点名的两样都没了却回「1 项失败」;换成 ['sub/c.txt','sub']
 *     又回 ok:true,**结果依赖输入顺序**。反向也成立:Windows 侧 execSync 退出 0 不等于盘上真没了。
 *     复核只看 existsSync:还在盘上的一律记 '移入回收站失败',已经不在的一律计入 moved
 *     (被连带带走的子文件算成功,因为它本来就是用户点名要删的东西)。
 *     残留盲区:父目录无检索权限时 existsSync 也返回 false,那一项会被计成成功 —— 与只信回报相比仍严格更好。
 *   · 对外**只有 rel 一个键**(fsutil 回的是绝对路径,不外泄)。failed 的 rel 刻意分两种形态:
 *     闸拒绝的项回报**调用方原样**的串(那一项根本没碰到盘,归一化后对不回用户点名的哪一条),
 *     trash / 复核阶段的失败回报归一后的 rel。Rust 侧 Task 7 同样镜像这两态。
 *
 * 闸用 resolveInside,与 writeProjectText 同一道:删除是读/写/删三翼里最重的一翼 ——
 * resolveRel 只看 rel 的字面形态,项目内一条指向项目外的链接(资产站 zip 解压带进来的形态)
 * 在它看来完全合法,而 PowerShell / rmSync 会跟随真实落点,把**别人家的一棵树**送进回收站。
 * 错误串一律取闸的原话('非法路径' / '路径无法解析';闸的 '目标目录不存在' 在删除侧够不着,
 * 因为项目根总是那个已存在的祖先,缺失形态统一由 stat 收敛到 '文件不存在'),
 * '项目不存在' 只来自 projectRoot,'移入回收站失败' 来自复核:
 * Node 的 EPERM 英文串既不稳定也无处对照(Rust 侧 Task 7 逐字镜像同一批串)。
 * @param {string} projectId
 * @param {string[]} rels
 * @returns {import('../../../src/types/godot').TrashResult}
 */
function movePathsToTrash(projectId, rels) {
  const root = projectRoot(projectId)
  if (!root) return { ok: false, error: '项目不存在' }
  /** @type {{path: string, isDir: boolean, rel: string}[]} */
  const items = []
  /** 已交给批量的绝对路径:同一个 abs 点名两次只删一次、只计一次(见 JSDoc 的去重约定) */
  const queuedAbs = new Set()
  /** @type {{rel: string, error: string}[]} */
  const failed = []
  const list = Array.isArray(rels) ? rels : []
  for (const raw of list) {
    const rel = typeof raw === 'string' ? raw.replace(/\\/g, '/') : ''
    const g = resolveInside(root, rel)
    const abs = g.abs
    // 闸的失败项带的是**调用方原样**的 rel(非字符串也 String 化):这一项根本没碰到盘,
    // 归一化后的形态反而让渲染层对不回它点名的那一条。
    if (!abs) { failed.push({ rel: String(raw), error: g.error || '非法路径' }); continue }
    let st
    try { st = fs.statSync(abs) } catch (e) { failed.push({ rel, error: '文件不存在' }); continue }
    if (queuedAbs.has(abs)) continue // 重复点名:沿用首次那条 rel
    queuedAbs.add(abs)
    items.push({ path: abs, isDir: st.isDirectory(), rel })
  }
  trashPaths(items.map((i) => ({ path: i.path, isDir: i.isDir })))
  // 复核以盘为准(见 JSDoc):报失败但其实没了 → 计成功;报成功但其实还在 → 补失败。
  let moved = 0
  for (const i of items) {
    if (fs.existsSync(i.path)) { failed.push({ rel: i.rel, error: '移入回收站失败' }); continue }
    moved++
  }
  return { ok: failed.length === 0, moved, failed }
}

module.exports = { projectRoot, resolveRel, resolveInside, DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, scanProjectTree, readProjectText, writeProjectText, movePathsToTrash }
