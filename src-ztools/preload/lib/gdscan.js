// 项目脚本扫描:把带 class_name 的 GDScript 解析成与引擎库同构的类文档并入队建库,
// 复用整套浏览 UI(列表/搜索/Ctrl+K/目录/继承树)。纯文本解析,不依赖引擎。
// 从 docs.js 拆出(2026-09-29);落盘走 docbuild.writeLibrary(同一原子接管)。
const fs = require('node:fs')
const path = require('node:path')
const { getDoc } = require('./store')
const { ensureDir } = require('./extract')
const { CanceledError, createCancelToken, checkCancel, forEachSliced, rmQuiet } = require('./fsutil')
const { tasks, setTask } = require('./doctasks')
const { versionKey, docsRoot, VERSION_PREFIX } = require('./docpaths')
const { writeLibrary } = require('./docbuild')

/** @typedef {import('../../../src/types/godot').DocClassDetail} DocClassDetail */

// ---------- 项目脚本扫描(生成项目文档库) ----------
//
// 把项目里带 class_name 的 GDScript 解析成与引擎库同构的类文档,从而复用整套浏览 UI
// (列表/搜索/Ctrl+K/目录/继承树/复制/外开)。纯文本解析,不依赖引擎 —— 项目未绑定
// 引擎也能用。识别 Godot 4 的 ## 文档注释与 @param/@return 标签。

/**
 * 解析类型标注:`x: int = 5` → {name, type, defaultValue}。
 * @param {string} raw
 * @returns {{name: string, type: string, defaultValue?: string}}
 */
function parseGdParam(raw) {
  const s = raw.trim()
  if (!s) return { name: '', type: 'Variant' }
  const m = /^(\w+)\s*(?::\s*([\w\[\]\.]+))?\s*(?:=\s*(.+))?$/.exec(s)
  if (!m) return { name: s, type: 'Variant' }
  return { name: m[1], type: m[2] || 'Variant', defaultValue: m[3] }
}

/**
 * 解析 GDScript 源码为类文档(纯函数)。没有 class_name 时 className 为空,
 * 调用方决定是否收录(无 class_name 的脚本不能被引用,一般不收)。
 * @param {string} text 源码
 * @param {{fileName?: string, scriptPath?: string}} [opts]
 * @returns {DocClassDetail | null} 解析不出任何结构时返回 null
 */
function parseGdScript(text, opts = {}) {
  const lines = String(text || '').split(/\r?\n/)
  /** @type {string[]} 最近一段 ## 文档注释(遇空行/声明后清空) */
  let doc = []
  /** @type {string[]} 待归属的注解(@export/@onready 等) */
  let annotations = []
  let className = ''
  let inherits = null
  /** @type {DocClassDetail['methods']} */
  const methods = []
  /** @type {DocClassDetail['members']} */
  const members = []
  /** @type {DocClassDetail['signals']} */
  const signals = []
  /** @type {DocClassDetail['constants']} */
  const constants = []
  /** @type {DocClassDetail['enums']} */
  const enums = []
  let classDoc = ''
  let found = false

  /** 把文档块转成描述文本,@param/@return 标签单独成行附在后面 */
  const docToText = () => {
    const body = []
    const tags = []
    for (const line of doc) {
      const mt = /^@(param|return|tutorial|deprecated|experimental|since|see)\b\s*(.*)$/.exec(line)
      if (mt) tags.push(`@${mt[1]} ${mt[2]}`.trim())
      else body.push(line)
    }
    return [body.join('\n').trim(), tags.join('\n')].filter(Boolean).join('\n\n')
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '    ')
    let trimmed = line.trim()

    if (trimmed.startsWith('##')) { doc.push(trimmed.slice(2).trim()); continue }
    // 空行或普通注释:断开文档块与后续声明的归属(与 Godot 编辑器一致)
    if (!trimmed) { doc = []; annotations = []; continue }
    if (trimmed.startsWith('#')) continue
    // 注解行:既可能是纯注解(@export 单独一行,归属下一个声明),
    // 也可能注解后直接跟声明(@export var x)。后者要继续解析剩下的部分。
    if (trimmed.startsWith('@')) {
      const ann = /^@([\w_]+)(?:\([^)]*\))?\s*([\s\S]*)$/.exec(trimmed)
      if (ann) {
        annotations.push(ann[1])
        const rest = ann[2].trim()
        if (!rest) continue
        trimmed = rest
      }
    }
    // 类级成员必须顶格;函数体内的局部声明不收录
    const indent = line.length - line.trimStart().length
    if (indent > 0) { doc = []; annotations = []; continue }

    const desc = docToText()
    const takeDoc = () => { const d = desc; doc = []; annotations = []; return d }

    let m
    if ((m = /^class_name\s+(\w+)(?:\s*,\s*"[^"]*")?/.exec(trimmed))) {
      className = m[1]
      classDoc = takeDoc()
      found = true
      // `class_name X extends Y` 的同行 extends
      const ext = /\bextends\s+([\w\.]+)/.exec(trimmed)
      if (ext) inherits = ext[1]
      continue
    }
    if ((m = /^extends\s+([\w\.]+)/.exec(trimmed))) {
      inherits = m[1]
      if (!classDoc) classDoc = takeDoc()
      else { doc = []; annotations = [] }
      continue
    }
    if ((m = /^signal\s+(\w+)\s*(?:\(([^)]*)\))?/.exec(trimmed))) {
      const params = (m[2] || '').split(',').map((p) => p.trim()).filter(Boolean).map(parseGdParam)
      signals.push({ name: m[1], params, description: takeDoc() })
      found = true
      continue
    }
    if ((m = /^enum\s+(\w+)?\s*\{(.*)\}\s*$/.exec(trimmed))) {
      const name = m[1] || 'Values'
      const values = m[2].split(',').map((v) => v.trim()).filter(Boolean).map((v, i) => {
        const eq = /^(\w+)\s*=\s*(.+)$/.exec(v)
        return eq ? { name: eq[1], value: eq[2].trim(), description: '' } : { name: v, value: String(i), description: '' }
      })
      enums.push({ name, bitfield: false, values })
      if (takeDoc()) { /* 枚举整体描述暂不单列(与引擎库保持同构) */ }
      found = true
      continue
    }
    if ((m = /^const\s+(\w+)\s*(?::\s*([\w\[\]\.]+))?\s*(?::=|=)\s*(.+)$/.exec(trimmed))) {
      constants.push({ name: m[1], value: m[3].trim(), description: takeDoc() })
      found = true
      continue
    }
    if ((m = /^(?:static\s+)?func\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([\w\[\]\.]+))?\s*:/.exec(trimmed))) {
      const params = (m[2] || '').split(',').map((p) => p.trim()).filter(Boolean).map(parseGdParam)
      methods.push({
        name: m[1],
        returnType: m[3] || 'Variant',
        params,
        qualifiers: /^static\s/.test(trimmed) ? ['static'] : [],
        description: takeDoc()
      })
      found = true
      continue
    }
    // var x: int = 5 / var x := 5 / @export var x: float / var x(无初始值)
    if ((m = /^var\s+(\w+)\s*(?::\s*([\w\[\]\.]+))?\s*(?:(?::=|=)\s*(.+))?$/.exec(trimmed))) {
      members.push({
        name: m[1],
        type: m[2] || 'Variant',
        // @export/@onready 等注解体现在描述里(有几个就写几个),便于检索
        description: [annotations.length ? `注解:${annotations.map((a) => '@' + a).join(' ')}` : '', takeDoc()].filter(Boolean).join('\n\n'),
        defaultValue: m[3] ? m[3].trim() : undefined
      })
      found = true
      continue
    }
    // 其他语句(if/for/print 等):断开文档归属
    doc = []
    annotations = []
  }

  if (!found) return null
  return {
    name: className || (opts.fileName || 'Unnamed').replace(/\.gd$/i, ''),
    inherits,
    brief: classDoc.split('\n')[0] || '',
    description: classDoc,
    builtin: false,
    isSingleton: false,
    methods,
    members,
    signals,
    constants,
    enums,
    operators: [],
    // 项目类:标注来源脚本(详情页显示,便于回编辑器)
    sourceFile: opts.scriptPath
  }
}

/**
 * 递归收集目录下的 .gd 文件(跳过 .godot 缓存与隐藏目录)。
 * @param {string} dir
 * @param {number} [depth]
 * @returns {string[]}
 */
function collectGdFiles(dir, depth = 0) {
  /** @type {string[]} */
  const out = []
  if (depth > 12) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  for (const e of entries) {
    const name = e.name
    if (name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (e.isDirectory()) out.push(...collectGdFiles(full, depth + 1))
    else if (/\.gd$/i.test(name)) out.push(full)
  }
  return out
}

/**
 * 扫描项目脚本生成项目文档库(入队)。只收录带 class_name 的脚本。
 * @param {{projectId: string}} opts
 * @returns {{ok: boolean, error?: string, taskId?: string, versionId?: string}}
 */
function scanProjectDocs(opts) {
  // 与 versionId 同一约定:接受完整 db 文档 id(godot/project/<id>)或裸 key
  const raw = String((opts && opts.projectId) || '')
  const projectDocId = raw.startsWith('godot/project/') ? raw : `godot/project/${raw}`
  const project = getDoc(projectDocId)
  if (!project || !project.path) return { ok: false, error: '项目不存在' }
  if (!fs.existsSync(project.path)) return { ok: false, error: '项目目录不存在' }
  const docId = `${VERSION_PREFIX}project-${projectDocId.slice('godot/project/'.length)}`
  const key = versionKey(docId).key
  const busy = tasks.list().find((/** @type {any} */ t) => versionKey(t.versionId).key === key && !tasks.isTerminal(t.status))
  if (busy) return { ok: false, error: '该项目脚本正在扫描中' }
  const task = tasks.create({
    kind: 'docs',
    versionId: docId,
    tag: project.name || '项目',
    versionName: (project.name || '项目') + ' 脚本',
    projectScan: true,
    status: 'queued',
    done: 0,
    total: 0,
    log: ''
  })
  const id = task.id
  tasks.emit()
  tasks.enqueue(() => runScanProject(id, project))
  return { ok: true, taskId: id, versionId: docId }
}

/**
 * 扫描流程(scanning → done):读 .gd → 解析 → 入库。
 * @param {string} taskId
 * @param {any} project
 */
async function runScanProject(taskId, project) {
  const task = tasks.get(taskId)
  if (!task) return
  const versionId = task.versionId
  const libDir = docsRoot(versionId)
  const workDir = path.join(docsRoot(), `.work-${taskId}`)
  const token = createCancelToken()
  try {
    setTask(taskId, { status: 'parsing' })
    const files = collectGdFiles(project.path)
    /** @type {DocClassDetail[]} */
    const mapped = []
    let skipped = 0
    await forEachSliced(files, async (file) => {
      checkCancel(token)
      let text = ''
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch (e) {
        return
      }
      // 没有 class_name 的脚本不构成可引用的类,跳过(计数上报)
      if (!/^\s*class_name\s+\w+/m.test(text)) {
        skipped++
        return
      }
      const cls = parseGdScript(text, { fileName: path.basename(file), scriptPath: file })
      if (cls && cls.name) {
        // 同名类(多脚本重复 class_name):保留先出现的,后者计入跳过
        if (mapped.some((c) => c.name === cls.name)) skipped++
        else mapped.push(cls)
      } else skipped++
    })
    checkCancel(token)
    if (!mapped.length) {
      throw new Error(`未找到带 class_name 的脚本(共扫描 ${files.length} 个 .gd 文件)`)
    }
    ensureDir(workDir)
    const total = await writeLibrary(mapped, {
      versionId,
      tag: project.name || '项目',
      name: (project.name || '项目') + ' 脚本',
      libDir,
      stageDir: path.join(workDir, 'staging'),
      tr: null,
      token,
      taskId,
      kind: 'project',
      sourceProject: project.id
    })
    setTask(taskId, { status: 'done', done: total, skipped, fileCount: files.length })
  } catch (e) {
    if (e instanceof CanceledError || token.canceled) setTask(taskId, { status: 'canceled' })
    else setTask(taskId, { status: 'error', error: (e && e.message) || '扫描失败' })
  } finally {
    rmQuiet(workDir)
    tasks.clearToken(taskId)
  }
}

module.exports = { parseGdParam, parseGdScript, collectGdFiles, scanProjectDocs }
