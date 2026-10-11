// 工具箱 · 3 个**项目外路径**的文件系统原语(§5.10 / A-18 / R-4)。
//
// 为什么不能复用 inspectfs.js 的那两道闸:它们的语义是「相对**项目根**」,错误串第一句就是
// '项目不存在',而插件目录在 `~/.gpm-tools/`,压根不在任何项目里。搬过来只有两种坏结局 ——
// 把插件目录硬当项目根(错误串从此说谎),或者绕过闸(§6 R-4:骨架生成器就能往任意路径写文件)。
// 所以这是一条语义不同的新闸,四条越界形态(字面 `..` / 绝对路径 / 盘符 / 符号链接)自己完整覆盖一遍。
//
// 与 inspectfs 同形的纪律,一条都没松:
//   · 原语**不抛异常**,一律 {ok:false,error}(工具页要把原因显示出来);
//   · 错误串逐字复用那批:'非法路径' / '路径无法解析' / '文件不存在' / '写入失败' / '目标目录不存在' /
//     '项目不存在'→这里换成 '工具目录不可用'(唯一一处新串,因为旧串会在用户脸上说谎);
//   · rel 一律正斜杠、对外只有 rel 一个键,绝对路径由这里拼;
//   · 批量接口单条失败**不中断其余**,失败项如实回报;
//   · 读侧的 maxBytes / NUL 二进制判定与旧原语同口径(同一份「文本」的定义,不给第二套真相)。
//
// 这一层**不懂 manifest 的语义**:listToolPlugins 只把 manifest.json 的原文与目录清单交出去,
// 解析与校验全在渲染层的 src/toolkit/manifest.ts(纯函数、能进 Node harness)。
// 于是「插件声明了什么」这件事永远只有一份判据,preload 里没有第二份 schema。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { getDoc } = require('./store')

/** 与 inspectfs.DEFAULT_MAX_BYTES 同值:同一份「文本」的定义,别在这里改成 5MB */
const DEFAULT_MAX_BYTES = 1024 * 1024
/** manifest.json 的上限:它本该是几百字节,超了就是作者把数据塞进了清单(或这是个假插件) */
const MANIFEST_MAX_BYTES = 256 * 1024
/** 单个插件目录最多列多少个文件:再多就不是「一个插件」而是把 node_modules 整个塞进来了 */
const MAX_ENTRIES_PER_PLUGIN = 500
/** 列目录时跳过的名字:第三方插件常带依赖目录,列出来会把清单涨到几千行 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.godot', '__pycache__', '.venv', 'dist', 'target'])
/** 插件目录名 = manifest 的 id(§5.1),字符集必须与 manifest.ts 的 ID_RE 同形 */
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** manifest 的文件名(约定死:骨架生成器也写这个名字) */
const MANIFEST = 'manifest.json'

/** 把可能带分隔符的路径尾巴去掉(双分隔符会让拼出来的路径形态不一) */
/** @param {string} p */
function trimSep(p) {
  const s = String(p)
  if (s.length > 1 && (s.endsWith('/') || s.endsWith('\\'))) return s.slice(0, -1)
  return s
}

/**
 * 「是不是绝对路径」自己判,**不用 `path.isAbsolute`**。
 * 理由与 `inspectfs.js:135` 躲开 `path.relative` 同一句:那个 API 没登在 `sandbox.d.ts` 里,
 * 为一段字符串拼接去扩大沙箱声明面不值得;而且这里三种形态都要认(正斜杠根、反斜杠根、UNC、盘符)。
 * @param {string} p
 * @returns {boolean}
 */
/** @param {string} p */
function isAbsoluteish(p) {
  const s = String(p)
  if (!s) return false
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true // C:\ 与 C:/
  if (s.startsWith('\\\\')) return true // UNC \\server\share
  if (s.startsWith('\\') || s.startsWith('/')) return true
  return false
}

/** rel 的目录前缀(正斜杠、带尾斜杠;裸文件名给空串)。同样是为了不碰 `path.relative` */
/** @param {string} rel */
function relDirOf(rel) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i + 1)
}

/**
 * 工具目录:设置里的 `toolsRoot` 优先,缺省 `~/.gpm-tools`。
 * 形状照 `docpaths.js:34`(`settings.versionsRoot || ~/.gpm-docs`)——本仓库已有先例,别再发明一套。
 *
 * 比 docpaths 多一道闸:**配置必须是绝对路径**。相对路径会随进程 cwd 漂,
 * 而宿主给插件视图的 cwd 不是我们能控制的;今天解析到 A 目录、明天解析到 B 目录,
 * 用户看到的插件列表就会无端端变空(或者更糟:变出一个他没装过的)。
 * @param {{settings?: Record<string, unknown>, home?: string, dir?: string}} [env] 注入用,断言里造替身环境
 * @returns {{ok: boolean, dir: string, source: 'default' | 'settings', error: string}}
 */
function toolsRoot(env) {
  const e = env || {}
  const settings = e.settings !== undefined ? e.settings : getDoc('godot/settings')
  const home = e.home || os.homedir()
  /** @type {{ok: boolean, dir: string, source: 'default' | 'settings', error: string}} */
  const fallback = { ok: true, dir: trimSep(path.join(home, '.gpm-tools')), source: 'default', error: '' }

  const raw = settings && typeof settings === 'object' ? settings.toolsRoot : undefined
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== 'string') {
    return { ok: false, dir: '', source: 'settings', error: '工具目录设置不是字符串:要填绝对路径' }
  }
  const v = raw.trim()
  if (!v) return fallback
  if (!isAbsoluteish(v)) {
    return { ok: false, dir: '', source: 'settings', error: `工具目录设置必须是绝对路径,现在是「${v}」` }
  }
  return { ok: true, dir: trimSep(v), source: 'settings', error: '' }
}

/**
 * 字面闸:`rel` → 绝对路径。`..` / 绝对 / 盘符 / 空 ⇒ null。
 * 与 `resolveRel`(inspectfs.js:40-53)**同形**,只是根换成工具目录 ——
 * 同形是有意的:两道闸规则不一致时,"manifest 放过、原语拒掉" 这种错位会在 UI 上
 * 变成一句没有字段名的 '非法路径'。
 * @param {string|null} root
 * @param {unknown} rel
 * @returns {string|null}
 */
function resolveToolRel(root, rel) {
  // `root` 也要判类型:这是公开门面,渲染层传进来的可能是 undefined / 数字 / 对象。
  // `path.join({}, 'a')` 会抛 TypeError,而本模块的红线是「原语不抛异常」。
  // (inspectfs.resolveRel 没这条是因为它的 root 恒来自 projectRoot(),只会是 string|null。)
  if (!root || typeof root !== 'string' || typeof rel !== 'string' || !rel) return null
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
 * 真实落点闸:realpath 之后必须仍在工具目录内。
 * 挡的是「目录里一条通向外面(或通向 ~/.ssh)的链接」——字面闸对它完全无感,
 * 而 readFileSync / writeFileSync 都会跟随真实落点。
 * 目标不存在时(要新建的文件)退到最近的已存在祖先做包含校验。
 * realpath 失败按保守处理:拒绝。
 * @param {string|null} root
 * @param {unknown} rel
 * @returns {{abs?: string, error?: string}}
 */
function resolveInsideTools(root, rel) {
  if (!root) return { error: '工具目录不可用' }
  const abs = resolveToolRel(root, rel)
  if (!abs) return { error: '非法路径' }
  let realRoot
  try { realRoot = fs.realpathSync(root) } catch (e) { return { error: '路径无法解析' } }
  let real
  if (fs.existsSync(abs)) {
    try { real = fs.realpathSync(abs) } catch (e) { return { error: '路径无法解析' } }
  } else {
    const rest = []
    let cursor = abs
    /** @type {string|null} */
    let ancestor = null
    for (;;) {
      rest.unshift(path.basename(cursor))
      const parent = path.dirname(cursor)
      if (!parent || parent === cursor) break
      cursor = parent
      if (fs.existsSync(cursor)) {
        try { ancestor = fs.realpathSync(cursor) } catch (e) { return { error: '路径无法解析' } }
        break
      }
    }
    if (!ancestor) return { error: '目标目录不存在' }
    real = path.join(ancestor, ...rest)
  }
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  if (real !== realRoot && !real.startsWith(prefix)) return { error: '非法路径' }
  return { abs }
}

/**
 * 公开的门面(断言与渲染层都用它):**字面闸 + 真实落点闸**的合成,`rel` 相对工具目录。
 * 语义与 `resolveRel`/`resolveInside` 那对一致,只是根换成工具目录。
 * 返回 `null` 而不是 `{error}` 是为了对上 `resolveRel` 的用法形态(调用方只需要「行不行」)。
 * @param {string} root 工具目录(绝对)
 * @param {unknown} rel 相对工具目录的路径(可以带插件目录前缀)
 * @returns {string|null}
 */
function resolveToolPath(root, rel) {
  if (!resolveToolRel(root, rel)) return null
  const g = resolveInsideTools(root, rel)
  return g.abs || null
}

/**
 * 读/写共用的内部闸:目录名 + 相对路径一起过,返回 {abs} 或 {error}。
 * `resolveInsideTools` 对**还不存在**的目标会退到最近的已存在祖先做包含校验,
 * 所以骨架生成器(要新建文件)与读已存在的文件走同一个闸,不用分两套判据。
 * @param {string} dir 工具目录(绝对)
 * @param {string} pluginDir 插件目录名(一层裸名)
 * @param {unknown} rel 插件内相对路径
 */
function gatePlugin(dir, pluginDir, rel) {
  if (!dir || typeof dir !== 'string') return { error: '工具目录不可用' }
  if (!pluginDirOk(pluginDir)) return { error: '非法路径' }
  const r = typeof rel === 'string' ? rel : ''
  if (!r) return { error: '非法路径' }
  return resolveInsideTools(dir, `${pluginDir}/${r}`)
}

/**
 * 插件目录名的闸:必须是工具目录下**一层裸名**,字符集与 manifest 的 id 同形。
 * 松掉它,`readToolPlugin(dir, 'a/b', ...)` 就能顺着列表爬到别的插件甚至别的树里去。
 * @param {unknown} name
 * @returns {boolean}
 */
function pluginDirOk(name) {
  return typeof name === 'string' && PLUGIN_NAME_RE.test(name)
}

/** 目录下的文件清单(正斜杠相对路径、保序、跳过依赖目录) */
/**
 * @param {string} dirAbs @param {string} relBase @param {string[]} out @param {number} depth
 */
function walkPluginFiles(dirAbs, relBase, out, depth) {
  if (out.length >= MAX_ENTRIES_PER_PLUGIN) return
  let items
  try { items = fs.readdirSync(dirAbs, { withFileTypes: true }) } catch (e) { return }
  const names = items.map((d) => d.name).sort()
  for (const name of names) {
    if (out.length >= MAX_ENTRIES_PER_PLUGIN) return
    const rel = relBase ? `${relBase}/${name}` : name
    const absChild = path.join(dirAbs, name)
    let isDir = false
    let isLink = false
    const d = items.find((x) => x.name === name)
    // find 的类型是 `Dirent | undefined`:名字列表来自同一份 items,理论上必命中,
    // 但判据不能靠「理论上」——命中不到就跳过这一项,不拿 undefined 去调方法
    if (!d) continue
    try {
      isLink = typeof d.isSymbolicLink === 'function' ? d.isSymbolicLink() : false
      isDir = d.isDirectory()
    } catch (e) { continue }
    if (isLink) continue // 链接一律不列、不跟随:它把「列清单」变成读别人家的文件的入口
    if (isDir) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
      if (depth >= 6) continue // 深到 6 层还没写完插件,那是没在写插件
      walkPluginFiles(absChild, rel, out, depth + 1)
      continue
    }
    out.push(rel)
  }
}

/**
 * 扫描工具目录,返回每个插件子目录的原文与清单。
 *
 * @param {string} [dir] 省略时用 toolsRoot();渲染层一般不传(让它跟随设置)
 * @param {{dir?: string, settings?: Record<string, unknown>, home?: string}} [opts] 注入替身环境用
 * @returns {{ok: boolean, dir: string, created: boolean, error: string, entries: {name: string, abs: string, manifestText: string, files: string[], bytes: number, error?: string}[]}}
 */
function listToolPlugins(dir, opts) {
  const o = opts || {}
  /** @type {{ok:boolean,dir:string,created:boolean,error:string,entries:any[]}} */
  const base = { ok: false, dir: '', created: false, error: '', entries: [] }
  // **只有完全不传参**才回落到设置里的 toolsRoot。传了但传坏(null/数字/空串)一律直接拒 ——
  // 早先的写法会把脏入参当成「没传」,于是悄悄去扫 `~/.gpm-tools`:
  // 调用方给了个坏目录,却看到别人家的插件列表,这是最难查的那类错(断言里更是直接碰到真实用户目录)。
  const explicit = dir !== undefined ? dir : o.dir
  /** @type {{ok:boolean,dir:string,source:string,error:string}} */
  /** @type {{ok: boolean, dir: string, source: 'default' | 'settings' | 'arg', error: string}} */
  let tr
  if (explicit === undefined) tr = toolsRoot(o)
  else if (typeof explicit !== 'string' || !explicit) tr = { ok: false, dir: '', source: 'arg', error: '工具目录不可用' }
  else tr = { ok: true, dir: explicit, source: 'arg', error: '' }
  if (!tr.ok) return { ...base, error: tr.error }
  const root = tr.dir
  if (typeof root !== 'string' || !root) return { ...base, error: '工具目录不可用' }

  let created = false
  if (!fs.existsSync(root)) {
    try {
      fs.mkdirSync(root, { recursive: true })
      created = true
    } catch (e) {
      // §D #2 明确要的就是这一句:创建失败要给**原因**,不许静默返回空列表
      return { ...base, dir: root, error: `工具目录无法创建:${(e && e.code) || '未知原因'}` }
    }
  }
  let isDir = false
  try { isDir = fs.statSync(root).isDirectory() } catch (e) { return { ...base, dir: root, error: '工具目录不可用' } }
  if (!isDir) return { ...base, dir: root, error: '工具目录不是一个目录' }

  let items
  try {
    items = fs.readdirSync(root, { withFileTypes: true })
  } catch (e) {
    return { ...base, dir: root, error: `工具目录读不出来:${(e && e.code) || '未知原因'}` }
  }

  const names = items.map((d) => d.name).sort()
  /** @type {any[]} */
  const entries = []
  for (const name of names) {
    const d = items.find((x) => x.name === name)
    if (!d) continue
    const isLink = typeof d.isSymbolicLink === 'function' ? d.isSymbolicLink() : false
    // 只认「真目录」:普通文件、链接、隐藏项都不算插件
    if (!d.isDirectory() || isLink || name.startsWith('.')) continue
    const absChild = path.join(root, name)
    /** @type {{name:string,abs:string,manifestText:string,files:string[],bytes:number,error?:string}} */
    const entry = { name, abs: absChild, manifestText: '', files: [], bytes: 0 }
    if (!pluginDirOk(name)) {
      entry.error = '目录名不合法:只能用小写字母、数字、点、下划线和短横线,首字符必须是字母或数字'
      entries.push(entry)
      continue
    }
    const mf = path.join(absChild, MANIFEST)
    let st = null
    try { st = fs.statSync(mf) } catch (e) { entry.error = `缺 ${MANIFEST}` }
    if (st) {
      if (!st.isFile()) entry.error = `${MANIFEST} 不是普通文件`
      else if (st.size > MANIFEST_MAX_BYTES) entry.error = `${MANIFEST} 过大(${st.size} 字节 > ${MANIFEST_MAX_BYTES}),没有解析`
      else {
        try {
          const text = fs.readFileSync(mf, 'utf8')
          entry.bytes = Buffer.byteLength(text, 'utf8')
          JSON.parse(text) // 只判「是不是 JSON」,内容交给 manifest.ts
          entry.manifestText = text
        } catch (e) {
          entry.error = `${MANIFEST} 不是合法 JSON:${(e && e.message) || ''}`
          entry.manifestText = ''
        }
      }
    }
    walkPluginFiles(absChild, '', entry.files, 1)
    entries.push(entry)
  }
  return { ok: true, dir: root, created, error: '', entries }
}

/**
 * 读插件目录内的一个文件(entry 正文 / 图标路径回执)。
 * @param {string} dir 工具目录
 * @param {string} pluginDir 插件目录名(一层裸名)
 * @param {string} rel 插件内相对路径
 * @param {{maxBytes?: number}} [o]
 */
function readToolPlugin(dir, pluginDir, rel, o) {
  const opt = o || {}
  const g = gatePlugin(dir, pluginDir, rel)
  if (g.error || !g.abs) return { ok: false, error: g.error || '非法路径' }
  let st
  try { st = fs.statSync(g.abs) } catch (e) { return { ok: false, error: '文件不存在' } }
  if (!st.isFile()) return { ok: false, error: '文件不存在' }
  const max = opt.maxBytes && opt.maxBytes > 0 ? opt.maxBytes : DEFAULT_MAX_BYTES
  if (st.size > max) return { ok: true, bytes: st.size, truncated: true }
  let buf
  try { buf = fs.readFileSync(g.abs) } catch (e) { return { ok: false, error: '读取失败' } }
  if (buf.subarray(0, 512).includes(0)) return { ok: true, bytes: st.size, skippedBinary: true }
  // bytes 取刚读进来的长度:与 readProjectText 同一句理由(stat 与 read 之间文件可能被人改过)
  const text = buf.toString('utf8')
  return { ok: true, text, bytes: buf.length, truncated: false, skippedBinary: false }
}

/**
 * 写插件目录内的文件(骨架生成器唯一能用上的写通道)。
 *
 * 三条与「往用户项目里写」不同的规矩:
 *   1. **默认不覆已存在**的文件:撞名要报错,而不是静默把别人写好的插件改一半。
 *      要覆必须显式 `overwrite:true`(升级自己生成的骨架才是合法场景);
 *   2. 插件目录**必须**是工具目录下的一层裸名(`PLUGIN_NAME_RE`,与 manifest 的 id 同字符集),
 *      父目录由这里创建(骨架生成器要建目录),但只在「目录不存在」或「目录为空」时建 ——
 *      既有内容又没开 overwrite 就整批拒;
 *   3. 单条失败不中断其余,失败项如实回报 `{rel, error}`。
 *
 * @param {string} dir 工具目录
 * @param {string} pluginDir 插件目录名
 * @param {{rel?: unknown, text?: unknown}[]} files
 * @param {{overwrite?: boolean}} [o]
 */
function writeToolPlugin(dir, pluginDir, files, o) {
  const opt = o || {}
  /** @type {{ok:boolean,dir:string,written:string[],failed:{rel:string,error:string}[],error:string}} */
  const res = { ok: false, dir: '', written: [], failed: [], error: '' }
  const root = typeof dir === 'string' ? dir : ''
  if (!root) { res.error = '工具目录不可用'; return res }
  if (!pluginDirOk(pluginDir)) {
    res.error = '非法路径'
    return res
  }
  if (!Array.isArray(files) || !files.length) {
    res.error = '没有要写的文件'
    return res
  }
  // 工具目录自己也可能还没被建出来(用户第一次用、或断言里直接给了个新目录):
  // 早先这里先过 realpath 闸,而**不存在的根**过不了闸,于是整批被误判成 '路径无法解析'。
  // 创建根是 listToolPlugins 的既有职责之一,写侧同样该容忍「还没有」而不是拒。
  if (!fs.existsSync(root)) {
    try { fs.mkdirSync(root, { recursive: true }) } catch (e) { res.error = `工具目录无法创建:${(e && e.code) || '未知原因'}`; return res }
  }
  const pluginAbs = path.join(root, pluginDir)
  // 目录级符号链接:realpath 之后不在工具目录内就整批拒,
  // 否则「在工具目录里建个叫 foo 的链接指向 ~」就等于把骨架生成器送到了任意路径。
  if (fs.existsSync(pluginAbs)) {
    const gate = resolveInsideTools(root, pluginDir)
    if (gate.error) { res.error = gate.error; return res }
    let st = null
    try { st = fs.statSync(pluginAbs) } catch (e) { res.error = '路径无法解析'; return res }
    // 只在「同名但根本不是目录」时整批拒:那已经没有插件可谈,逐条也写不进去
    if (!st.isDirectory()) { res.error = '同名对象不是目录,不能当插件目录写'; return res }
  } else {
    const gate = resolveInsideTools(root, pluginDir)
    if (gate.error) { res.error = gate.error; return res }
    try { fs.mkdirSync(pluginAbs, { recursive: true }) } catch (e) { res.error = `创建插件目录失败:${(e && e.code) || '未知原因'}`; return res }
  }
  // 「已存在就不覆」改**逐条判**(与测试 §6 同一口径):批次级拒绝会连
  // 「往已有插件里加一个新文件」这种合法场景一起挡掉,而那种场景一个字节都不该被覆。
  res.dir = pluginAbs

  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f !== 'object') {
      // 坏元素回报时把原样值转成串;`f && f.rel` 那种写法在类型上会被收窄成 never,
      // 所以这里显式取一次 rel(而不是依赖真值判断)
      const junk = f && typeof f === 'object' ? /** @type {{rel?: unknown}} */ (f).rel : undefined
      res.failed.push({ rel: typeof junk === 'string' ? junk : '(脏元素)', error: '非法路径' })
      continue
    }
    const rel = typeof f.rel === 'string' ? f.rel : ''
    const text = f.text
    if (typeof text !== 'string') {
      // 与 orchestrate 同一条教训:undefined 写进文件就是把内容清成空
      res.failed.push({ rel: rel || '(缺 rel)', error: '内容不是文本' })
      continue
    }
    const g = gatePlugin(root, pluginDir, rel)
    if (g.error || !g.abs) { res.failed.push({ rel: rel || '(缺 rel)', error: g.error || '非法路径' }); continue }
    const targetExists = fs.existsSync(g.abs)
    if (targetExists && opt.overwrite !== true) {
      res.failed.push({ rel, error: '文件已存在,未覆写(要覆盖得显式同意)' })
      continue
    }
    const parent = path.dirname(g.abs)
    if (parent !== pluginAbs && !fs.existsSync(parent)) {
      try { fs.mkdirSync(parent, { recursive: true }) } catch (e) { res.failed.push({ rel, error: '目标目录不存在' }); continue }
    }
    // 与 writeProjectText 同一套原子写法:同目录临时文件 + rename,`wx` 独占创建。
    // 名字可预测 → 项目里预置同名文件时普通写会跟随它落到别人名下,wx 让「名字被占」当场失败。
    const base = path.basename(g.abs)
    const tmp = path.join(parent, `.gpm-tmp-${Date.now()}-${base}`)
    try {
      const tmpRel = `${pluginDir}/${relDirOf(rel)}${path.basename(tmp)}`
      const t2 = resolveInsideTools(root, tmpRel)
      if (t2.error) { res.failed.push({ rel, error: t2.error }); continue }
      fs.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' })
      fs.renameSync(tmp, g.abs)
      res.written.push(rel)
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (e2) { /* 半截临时文件能清就清,清不掉不改变结论 */ }
      res.failed.push({ rel, error: '写入失败' })
    }
  }
  res.ok = res.failed.length === 0 && res.written.length > 0
  if (!res.ok && !res.error) res.error = res.failed.length ? '有文件没写成' : '一个文件都没写成'
  return res
}

module.exports = {
  toolsRoot,
  resolveToolPath,
  listToolPlugins,
  readToolPlugin,
  writeToolPlugin,
  DEFAULT_MAX_BYTES,
  MANIFEST_MAX_BYTES,
  MAX_ENTRIES_PER_PLUGIN,
  PLUGIN_NAME_RE,
  MANIFEST
}
