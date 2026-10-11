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
const crypto = require('node:crypto')
const { getDoc } = require('./store')
const { walkFiles, makeExcluder, stampSec, rmQuiet, uniquePath, trashPaths } = require('./fsutil')

const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_ENTRIES = 200000
/** hashPaths 的分块读大小(1 MiB):重复检测的候选几百 MB 也只占这么点内存 */
const HASH_CHUNK = 1024 * 1024

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
 * rel 的**规范形态**:反斜杠归正斜杠、吃掉空段与 `.` 段、见到 `..` 直接判非法。
 * 与 `resolveRel` 的切段规则同一个,但产出的是 rel 而不是绝对路径 —— 对外只有 rel 一个键,
 * 回报里的 from/to 必须与 scanProjectTree 给的 rel 同形,否则渲染层对不回自己点名的那一条。
 * @param {unknown} v
 * @returns {string} 归一后的 rel;非法(非字符串 / 空 / 越界)给空串
 */
function canonRel(v) {
  if (typeof v !== 'string' || !v) return ''
  const stack = []
  for (const p of v.replace(/\\/g, '/').split('/')) {
    if (!p || p === '.') continue
    if (p === '..') return ''
    stack.push(p)
  }
  return stack.join('/')
}

/**
 * 改名**边车**的尾缀:Godot 由主文件生成的旁路文件。
 * 名字一律是「主 rel + 尾缀」(`player.gd.uid`、`icon.png.import`)—— 旧 `inspectors/uid.ts`
 * 的 UID_SUFFIX 注释点过这个坑:`X.a.b.uid` 的源是 `X.a.b`,用 dirOf/basename 重拼会拼错。
 * 边车**只有是普通文件才算**(目录名撞成 `*.uid` 的形态不搬、也不报错)。
 */
const SIDECAR_SUFFIXES = ['.uid', '.import']

/**
 * 项目内改名(含边车)。**唯一**能改名字的原语 —— 渲染层拿不到 fs。
 *
 * 为什么不能用 `movePathsToTrash` + `writeProjectText` 拼(§F DEV-11 判死过这条):
 *   1. 写完新文件 mtime 就是「现在」,Godot 的导入器按 mtime 判是否重导 ⇒ 每个被改名的资产都被重导一遍;
 *   2. `.uid` / `.import` 边车留在旧名底下 ⇒ 旧边车成孤儿、新文件掉回未导入态;
 *   3. `writeProjectText` 会为新名**落一份 `.gpm-bak-` 备份**,而它备份的是「新名那个还不存在的文件」= 没有。
 * `rename` 是同一 inode 的移动:内容、mtime、边车(搬完仍指同一份内容)全部原样,uid 也不必重算。
 *
 * 三条纪律与兄弟原语同形:
 *   · 闸用 `resolveInside`(旧名与新名各过一道):字面越界与「项目内链接通向外面」都拒,
 *     错误串一律 `'非法路径'` —— 不透露挡掉的是哪一类(见文件头那段);
 *   · **预检在动盘之前**:每个目标都不许已被占(含边车槽位被占)、父目录必须存在(绝不 mkdir);
 *     唯一放行形态是「目标与源是同一份真实文件」——大小写不敏感的平台把 `Foo.gd` 与 `foo.gd`
 *     看成同一个,这类改名要做得成,不能误报「目标已存在」;
 *   · **主文件先搬、边车随后**:最常见失败(Windows 上文件被编辑器占用)落在第一步,此时盘上干净;
 *     后续步失败则把已搬的原路退回,退不动时点名是哪个文件(宁可报得难听,也不留半截状态谎报成功)。
 *
 * 一条**测不到**的分支(不许算成已验):预检全过后仍失败的只有真实 I/O 错误,而它落在第 2、3 个
 * move 上时的回退路径,本机造不出确定性触发(同进程持有句柄在共享模式下不拦 rename)。断言只钉
 * 「第一步就失败 ⇒ 盘上干净」,多步那一支进 docs/manual-verification.md 的 §12 真机项。
 *
 * @param {string} projectId
 * @param {string} rel 旧名(相对项目根、正斜杠)
 * @param {string} to 新名(相对项目根;可以换目录,但本批的 UI 只改同目录名)
 * @param {{sidecar?:boolean}} [opts] 默认 true:同名的 `.uid` / `.import` 一起搬;false 只搬主文件
 * @returns {import('../../../src/types/godot').RenameResult}
 */
function renameProjectPath(projectId, rel, to, opts) {
  const o = opts || {}
  const root = projectRoot(projectId)
  if (!root) return { ok: false, error: '项目不存在' }
  const fromRel = canonRel(rel)
  const toRel = canonRel(to)
  if (!fromRel || !toRel) return { ok: false, error: '非法路径' }
  const g1 = resolveInside(root, fromRel)
  if (!g1.abs) return { ok: false, error: g1.error || '非法路径' }
  const g2 = resolveInside(root, toRel)
  if (!g2.abs) return { ok: false, error: g2.error || '非法路径' }
  // 归一后落到同一个绝对路径(含 './a.gd' vs 'a.gd'):不必碰盘,也不许回一次假成功
  if (g1.abs === g2.abs) return { ok: false, error: '改名前后是同一个名字' }
  // project.godot 是项目的身份:改名等于把这份登记作废(宿主与 Godot 都按它认项目)
  if (fromRel === 'project.godot') return { ok: false, error: '项目主配置文件不改名' }
  let st
  try { st = fs.statSync(g1.abs) } catch (e) { return { ok: false, error: '文件不存在' } }
  if (st.isDirectory()) return { ok: false, error: '目录改名不支持' }
  if (!st.isFile()) return { ok: false, error: '文件不存在' }
  const toDir = path.dirname(g2.abs)
  if (!fs.existsSync(toDir)) return { ok: false, error: '目标目录不存在' }

  // ---- 待搬清单:主文件在第一位,边车按 SIDECAR_SUFFIXES 顺序随后 ----
  const pairs = [{ fromRel, fromAbs: g1.abs, toRel, toAbs: g2.abs }]
  if (o.sidecar !== false) {
    for (const suffix of SIDECAR_SUFFIXES) {
      const sRel = fromRel + suffix
      const dRel = toRel + suffix
      const gs = resolveInside(root, sRel)
      if (!gs.abs) return { ok: false, error: gs.error || '非法路径' }
      const gd = resolveInside(root, dRel)
      if (!gd.abs) return { ok: false, error: gd.error || '非法路径' }
      let sst = null
      try { sst = fs.statSync(gs.abs) } catch (e) { sst = null }
      if (!sst || !sst.isFile()) {
        // 源这一侧没有边车可搬(不存在 / 名字叫边车尾缀其实是目录)——但**新名的边车槽位已被占**时仍要拒:
        // 把主文件搬进去等于让它继承一份不属于它的所有权声明(那个 `.uid` 里写的 uid 是别人家的文件)。
        if (fs.existsSync(gd.abs)) return { ok: false, error: '目标已存在' }
        continue
      }
      pairs.push({ fromRel: sRel, fromAbs: gs.abs, toRel: dRel, toAbs: gd.abs })
    }
  }

  // ---- 预检:动盘之前把每一对都问一遍 ----
  for (const p of pairs) {
    if (!fs.existsSync(p.toAbs)) continue
    // 有一种「看着像占用其实不是」必须放行:大小写不敏感的文件系统把 `Foo.gd` 与 `foo.gd` 看成同一份文件,
    // 这类改名要做得成。**判据用 (dev, ino),不用 realpath** —— 本机实测 `fs.realpathSync` 在 Windows 上
    // **原样保留输入的大小写**(给 foo.gd 就回 foo.gd),拿它比对会恒判「不是同一个」而误拒每一次大小写改名。
    let same = false
    try {
      const s1 = fs.statSync(p.fromAbs)
      const s2 = fs.statSync(p.toAbs)
      same = s1.ino === s2.ino && s1.dev === s2.dev
    } catch (e) { return { ok: false, error: '路径无法解析' } }
    if (!same) return { ok: false, error: '目标已存在' }
  }

  const done = []
  for (const p of pairs) {
    try {
      fs.renameSync(p.fromAbs, p.toAbs)
    } catch (e) {
      const stuck = []
      for (let i = done.length - 1; i >= 0; i--) {
        const d = done[i]
        try { fs.renameSync(d.toAbs, d.fromAbs) } catch (e2) { stuck.push(d.fromRel) }
      }
      if (stuck.length) return { ok: false, error: `重命名失败,且这些文件没能退回:${stuck.join('、')}` }
      return { ok: false, error: p.fromRel === fromRel ? '重命名失败' : '边车改名失败,已回退' }
    }
    done.push(p)
  }
  return { ok: true, from: fromRel, to: toRel, moved: done.map((p) => ({ from: p.fromRel, to: p.toRel })) }
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

/**
 * 批量计算项目内文件的 SHA-256(#17 重复文件检测)。
 *
 * 为什么必须是原语而不是渲染层自己算:readProjectText 只给文本、1MB 上限、且对含 NUL 的
 * 二进制一律跳过 —— 而重复检测恰恰要在几百 MB 的二进制上工作。这里用 openSync/readSync
 * 分块流式喂哈希(块大小 HASH_CHUNK),任意大的文件也只占一块的内存;两个 API 都在
 * sandbox.d.ts 的既有声明面里,沙箱不因此扩大。
 *
 * 读语义走 resolveInside,与 readProjectText 同一道闸:项目内一条指向项目外的符号链接
 * 在字面闸(resolveRel)看来完全合法,而哈希它等于把别人家的文件读了进来 —— 第二道闸
 * (realpath 包含校验)是这里唯一能挡住它的东西。
 *
 * 错误串**逐字复用**读原语那批('项目不存在' / '非法路径' / '路径无法解析' /
 * '目标目录不存在' / '文件不存在' / '读取失败'),不新增文案:Rust 侧镜像同一批串,
 * parity 测试逐字段比对。单个失败不中断其余(failed 如实回报),ok 仅在零失败时为 true;
 * 空清单不是错误(→ ok:true, hashes:[])。rels 非数组按空清单处理,与 movePathsToTrash
 * 的判别同形 —— 字符串可迭代,`for (const raw of rels)` 会把 'a.txt' 拆成字符逐个哈希。
 *
 * **不去重**:与 trash 不同,这里没有「计数」要对账,幂等只读的哈希重复点名只是浪费一次读;
 * 调用方(检查器)按组点名,天然无重复。rel 回报**调用方归一后的形态**(反斜杠已归一),
 * 闸拒绝的那一项回**原样串**(与 trash 同一两态约定:没碰到盘的项,归一化后对不回用户点名的那条)。
 * @param {string} projectId
 * @param {string[]} rels
 * @returns {import('../../../src/types/godot').HashPathsResult}
 */
function hashPaths(projectId, rels) {
  const root = projectRoot(projectId)
  if (!root) return { ok: false, error: '项目不存在' }
  const list = Array.isArray(rels) ? rels : []
  /** @type {{rel: string, sha256: string}[]} */
  const hashes = []
  /** @type {{rel: string, error: string}[]} */
  const failed = []
  for (const raw of list) {
    const rel = typeof raw === 'string' ? raw.replace(/\\/g, '/') : ''
    const g = resolveInside(root, rel)
    const abs = g.abs
    if (!abs) { failed.push({ rel: String(raw), error: g.error || '非法路径' }); continue }
    let st
    try { st = fs.statSync(abs) } catch (e) { failed.push({ rel, error: '文件不存在' }); continue }
    if (!st.isFile()) { failed.push({ rel, error: '文件不存在' }); continue }
    let fd = null
    try {
      const h = crypto.createHash('sha256')
      const buf = Buffer.alloc(HASH_CHUNK)
      fd = fs.openSync(abs, 'r')
      let pos = 0
      for (;;) {
        const n = fs.readSync(fd, buf, 0, HASH_CHUNK, pos)
        if (n <= 0) break
        h.update(buf.subarray(0, n))
        pos += n
      }
      hashes.push({ rel, sha256: h.digest('hex') })
    } catch (e) {
      failed.push({ rel, error: '读取失败' })
    } finally {
      if (fd !== null) { try { fs.closeSync(fd) } catch (e) { /* 句柄泄漏只影响这一次进程内资源,不再往失败里添一条 */ } }
    }
  }
  return { ok: failed.length === 0, hashes, failed }
}

module.exports = { projectRoot, resolveRel, resolveInside, DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, scanProjectTree, readProjectText, writeProjectText, renameProjectPath, movePathsToTrash, hashPaths }
