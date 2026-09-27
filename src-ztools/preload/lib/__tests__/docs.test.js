// 引擎文档库(--dump-extension-api-with-docs → 索引 → 浏览)的回归测试。
//
// 覆盖:extension_api.json 字段映射(core/builtin/@GlobalScope 伪类)、索引构建与搜索
// 打分(类名 > 成员、精确 > 前缀 > 包含、单类成员上限)、生成全流程(引擎进程用桩代替,
// 在 cwd 产出 fixture JSON;任务 queued→dumping→parsing→done)、重复生成拒绝、取消、
// 引擎失败、路径穿越校验、收藏/历史、缓存统计与清理。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/docs.test.js
//   node src-ztools/preload/lib/__tests__/docs.test.js --no-immediate
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))

const LIB = positional[0] || path.resolve(__dirname, '..')
const WORK = positional[1] || fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-docs-test-'))

if (!fs.existsSync(path.join(LIB, 'docs.js'))) {
  console.error(`找不到被测模块: ${path.join(LIB, 'docs.js')}`)
  process.exit(2)
}

if (flags.has('--no-immediate')) {
  delete globalThis.setImmediate
  console.log('[harness] setImmediate 已移除(模拟宿主沙箱)')
}
console.log(`[harness] lib=${LIB}`)
console.log(`[harness] work=${WORK}`)

// ---------- 内存版 ztools.db 桩 ----------
const docs = new Map()
let rev = 0
global.window = {
  ztools: {
    db: {
      get: (id) => (docs.has(id) ? { ...docs.get(id) } : null),
      put: (doc) => {
        if (!doc || !doc._id) return { error: 'no id' }
        rev++
        docs.set(doc._id, { ...doc, _rev: `r${rev}` })
        return { ok: true }
      },
      remove: (doc) => {
        docs.delete(doc._id)
        return { ok: true }
      },
      allDocs: (prefix) => [...docs.values()].filter((d) => d._id.startsWith(prefix)).map((d) => ({ ...d }))
    }
  }
}

// 预置设置:文档库根目录指向测试工作区
docs.set('godot/settings', { _id: 'godot/settings', versionsRoot: WORK })

// ---------- extension_api.json fixture(最小可断言,结构对齐实测产物) ----------
const FIXTURE = {
  classes: [
    {
      name: 'Node',
      inherits: 'Object',
      brief_description: 'Base class for all scene objects.',
      description: 'Nodes are Godot\u0027s building blocks. See [method _ready] and [SceneTree].',
      constants: [{ name: 'NOTIFICATION_READY', value: 13, description: 'Notification received once.' }],
      enums: [{
        name: 'ProcessMode',
        is_bitfield: false,
        values: [{ name: 'PROCESS_MODE_INHERIT', value: 0, description: 'Inherits process mode.' }]
      }],
      methods: [
        {
          name: 'add_child',
          return_type: 'void',
          is_const: false,
          arguments: [
            { name: 'node', type: 'Node' },
            { name: 'force_readable_name', type: 'bool', default_value: 'false' }
          ],
          description: 'Adds a child [param node].'
        },
        { name: 'get_tree', return_type: 'SceneTree', is_const: true, description: 'Returns the tree.' }
      ],
      properties: [{
        name: 'name',
        type: 'StringName',
        setter: 'set_name',
        getter: 'get_name',
        default_value: '""',
        description: 'The name of the node.'
      }],
      signals: [{ name: 'ready', arguments: [], description: 'Emitted when ready.' }]
    },
    { name: 'Object', inherits: '', brief_description: 'Base of everything.', description: '' },
    {
      name: 'Input',
      inherits: 'Object',
      brief_description: 'Singleton input.',
      description: 'The input singleton.'
    }
  ],
  builtin_classes: [
    {
      name: 'Vector2',
      brief_description: 'A 2D vector.',
      description: 'A two-element vector.',
      members: [{ name: 'x', type: 'float', description: 'X component.' }],
      methods: [{ name: 'length', return_type: 'float', arguments: [], description: 'Returns the length.' }],
      operators: [{
        name: 'add',
        return_type: 'Vector2',
        arguments: [{ name: 'right', type: 'Vector2' }],
        description: 'Adds two vectors.'
      }],
      constants: [],
      enums: []
    }
  ],
  utility_functions: [{
    name: 'clampf',
    return_type: 'float',
    arguments: [
      { name: 'value', type: 'float' },
      { name: 'min', type: 'float' },
      { name: 'max', type: 'float' }
    ],
    is_vararg: false,
    description: 'Clamps a float.'
  }],
  global_constants: [
    { name: 'PI', value: 3.14159265358979 },
    { name: 'TAU', value: 6.283185307179586 },
    { name: 'SIDE_LEFT', value: 0 }
  ],
  global_enums: [{
    name: 'Side',
    is_bitfield: false,
    values: [{ name: 'SIDE_LEFT', value: 0, description: 'Left side.' }]
  }],
  singletons: [{ name: 'Input' }]
}

// ---------- child_process 打桩(内建模块必须用 Module._load 拦截) ----------
const state = {
  children: [],
  exitCode: 0,
  outputLines: ['Godot Engine v4.7.2.stable'],
  hang: false,
  failSpawn: false
}

function fakeSpawn(exePath, args, opts) {
  if (state.failSpawn) {
    const bad = new EventEmitter()
    process.nextTick(() => bad.emit('error', new Error('ENOENT')))
    return bad
  }
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
    process.nextTick(() => child.emit('close', null, 'SIGTERM'))
  }
  child.args = args
  state.children.push(child)
  process.nextTick(() => {
    if (state.hang) return
    // 真实引擎把 extension_api.json 写在 cwd
    if (state.exitCode === 0 && opts && opts.cwd) {
      fs.writeFileSync(path.join(opts.cwd, 'extension_api.json'), JSON.stringify(FIXTURE))
    }
    for (const line of state.outputLines) child.stdout.emit('data', Buffer.from(line + '\n'))
    child.emit('close', state.exitCode)
  })
  return child
}

const Module = require('node:module')
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  const fromDocs = parent && /docs\.js$/.test(parent.filename || '')
  if (fromDocs && request === 'node:child_process') return { spawn: fakeSpawn }
  return origLoad.apply(this, arguments)
}

const lib = require(path.join(LIB, 'docs.js'))

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const sleep = (ms = 10) => new Promise((r) => setTimeout(r, ms))

let latestSnap = []
lib.watchDocsTasks((snap) => { latestSnap = snap })
function getTask(id) {
  return latestSnap.find((t) => t.id === id)
}
async function waitTask(id) {
  for (let i = 0; i < 1000; i++) {
    const t = getTask(id)
    if (t && ['done', 'error', 'canceled'].includes(t.status)) return t
    await sleep(10)
  }
  throw new Error('任务超时未完成')
}

// 版本标识用与 install.js 一致的真实形状:id = 完整 db 文档 id(godot/version/...)
const V1 = 'godot/version/4.7.2-stable-standard-win64'
docs.set(V1, {
  _id: V1,
  id: V1,
  tag: '4.7.2-stable',
  name: '4.7.2 Stable',
  // spawn 已被打桩,但 generateDocs 会先校验 exePath 存在 —— 指向本测试文件
  exePath: __filename
})

async function main() {
  // ---------- 映射(纯函数) ----------
  section('extension_api.json 字段映射')
  const core = lib.mapClass(FIXTURE.classes[0])
  ok(core.name === 'Node' && core.inherits === 'Object', 'core 类:name/inherits 保留')
  ok(core.brief.includes('scene objects') && core.description.includes('[method _ready]'), 'brief/description 原样保留 BBCode')
  const add = core.methods.find((m) => m.name === 'add_child')
  ok(add && add.returnType === 'void', '方法:returnType 映射')
  ok(add.params.length === 2 && add.params[1].defaultValue === 'false', '方法:参数默认值映射', JSON.stringify(add.params))
  const gt = core.methods.find((m) => m.name === 'get_tree')
  ok(gt.qualifiers.includes('const') && !gt.qualifiers.includes('static'), '方法:const 限定符')
  ok(core.properties === undefined && core.members.length === 1 && core.members[0].type === 'StringName', '成员:properties → members')
  ok(core.signals.length === 1 && core.signals[0].name === 'ready', '信号映射')
  ok(core.constants.length === 1 && core.constants[0].value === '13', '常量:value 转字符串')
  ok(core.enums[0].values[0].description === 'Inherits process mode.', '枚举值带描述')
  ok(core.operators.length === 0, 'core 类无运算符')

  const singleton = lib.mapClass(FIXTURE.classes[2], { isSingleton: true })
  ok(singleton.isSingleton === true, '单例标记')

  const v2 = lib.mapClass(FIXTURE.builtin_classes[0], { builtin: true })
  ok(v2.builtin === true && v2.members[0].name === 'x', 'builtin 类:members 映射')
  ok(v2.operators.length === 1 && v2.operators[0].returnType === 'Vector2', 'builtin 类:operators 映射')

  const gs = lib.mapGlobalScope(FIXTURE)
  ok(gs.name === '@GlobalScope' && gs.methods.length === 1 && gs.methods[0].name === 'clampf', '@GlobalScope:内置函数')
  ok(gs.enums.length === 1 && gs.enums[0].name === 'Side', '@GlobalScope:全局枚举')
  ok(gs.constants.length === 2 && !gs.constants.some((c) => c.name === 'SIDE_LEFT'), '@GlobalScope:枚举值不重复进散装常量', JSON.stringify(gs.constants))

  // ---------- 索引与搜索打分 ----------
  section('索引与搜索打分')
  const index = [core, singleton, v2, gs].map(lib.buildIndexEntry)
  const nodeEntry = index[0]
  ok(nodeEntry.m.includes('add_child') && nodeEntry.p.includes('name') && nodeEntry.c.includes('NOTIFICATION_READY'), '索引条目收录成员名')

  const hitsNode = lib.searchIndex(index, 'Node')
  ok(hitsNode.length > 0 && hitsNode[0].kind === 'class' && hitsNode[0].className === 'Node', '类名命中排第一', JSON.stringify(hitsNode[0]))

  const hitsAdd = lib.searchIndex(index, 'add_child')
  ok(hitsAdd[0].kind === 'method' && hitsAdd[0].className === 'Node', '成员命中带所属类')

  const hitX = lib.searchIndex(index, 'x')
  ok(hitX.length >= 1 && hitX[0].kind === 'member' && hitX[0].className === 'Vector2', '单词成员命中')

  ok(lib.searchIndex(index, '').length === 0, '空查询返回空')
  const limited = lib.searchIndex(index, 'e', 3)
  ok(limited.length === 3, 'limit 生效')
  // 打分顺序:精确类名 > 类名前缀 > 类名包含 > 成员
  const scored = lib.searchIndex(index, 'in')
  const clsHit = scored.find((h) => h.kind === 'class')
  ok(clsHit && clsHit.className === 'Input', '类名前缀命中', JSON.stringify(scored.slice(0, 3)))

  // ---------- 生成全流程 ----------
  section('生成全流程')
  ok(!fs.existsSync(path.join(WORK, 'gpm-docs')), '生成前库根目录不存在')
  const r1 = lib.generateDocs(V1)
  ok(r1.ok === true && !!r1.taskId, '入队返回任务 id')
  const t1 = await waitTask(r1.taskId)
  ok(t1.status === 'done', '任务到达 done', JSON.stringify({ status: t1.status, error: t1.error }))
  ok(t1.total === 5 && t1.done === 5, '类计数:3 core + 1 builtin + 1 伪类', `total=${t1.total}`)

  const libDir = path.join(WORK, 'gpm-docs', '4.7.2-stable-standard-win64')
  ok(!fs.existsSync(path.join(WORK, 'gpm-docs', 'godot')), '完整 db id 不进文件路径(无嵌套 godot 目录)')
  ok(fs.existsSync(path.join(libDir, 'index.json')), 'index.json 已写盘')
  ok(fs.existsSync(path.join(libDir, 'classes', 'Node.json')), '类正文 Node.json 已写盘')
  ok(fs.existsSync(path.join(libDir, 'classes', 'Object.json')), '空描述类也写盘')
  ok(!fs.readdirSync(libDir).some((n) => n.startsWith('.work-')), '工作临时目录已清理')

  const rec = docs.get('godot/docs/4.7.2-stable-standard-win64')
  ok(rec && rec.classCount === t1.total && rec.tag === '4.7.2-stable', 'db 元数据已落库(裸键归一化)')

  const st = lib.docsLibraryStatus(V1)
  ok(st && st.status === 'ready' && st.classCount === t1.total, 'docsLibraryStatus=ready')

  // ---------- 浏览 API ----------
  section('浏览 API')
  const list = lib.docsListClasses(V1)
  ok(list.ok && list.classes.length === t1.total, '类列表来自索引')
  const names = list.classes.map((c) => c.name)
  ok(names.includes('@GlobalScope') && names.includes('Vector2') && names.includes('Node'), '索引含 core/builtin/伪类', JSON.stringify(names))

  const detail = lib.docsGetClass(V1, 'Node')
  ok(detail && detail.methods.length === 2 && detail.members[0].name === 'name', '类正文读取')
  ok(lib.docsGetClass(V1, '../settings') === null, '路径穿越被拒绝')
  ok(lib.docsGetClass(V1, 'Nope') === null, '未知类返回 null')

  const s1 = lib.docsSearch(V1, 'clamp')
  ok(s1.length >= 1 && s1[0].className === '@GlobalScope' && s1[0].name === 'clampf', '搜索:全局函数可命中', JSON.stringify(s1[0]))
  const s2 = lib.docsSearch(V1, 'NOPE_NOT_EXIST')
  ok(s2.length === 0, '搜索:无命中返回空')

  // ---------- 收藏与历史 ----------
  section('收藏与历史(全局)')
  lib.docsToggleFavorite('Node', true)
  lib.docsToggleFavorite('Vector2', true)
  lib.docsToggleFavorite('Node', false)
  ok(JSON.stringify(lib.docsListFavorites()) === '["Vector2"]', '收藏增删')
  for (let i = 0; i < 35; i++) lib.docsPushHistory(`Class${i}`)
  lib.docsPushHistory('Node')
  lib.docsPushHistory('Node')
  const hist = lib.docsListHistory()
  ok(hist.length === 30, '历史上限 30', String(hist.length))
  ok(hist[0].name === 'Node' && hist.filter((h) => h.name === 'Node').length === 1, '历史去重且最新在前')

  // ---------- 重复生成拒绝 / 取消 ----------
  section('任务约束:重复拒绝与取消')
  state.hang = true
  const g2 = lib.generateDocs(V1)
  ok(g2.ok === true, '再次生成入队')
  await sleep(30)
  const g3 = lib.generateDocs(V1)
  ok(g3.ok === false && /正在生成/.test(g3.error), '在途时重复生成被拒绝', g3.error)
  lib.cancelDocsTask(g2.taskId)
  const t2 = await waitTask(g2.taskId)
  ok(t2.status === 'canceled', '取消后任务 canceled')
  // cancelDocsTask 同步置状态,kill → close → 清理在稍后的 tick 完成,等一拍再断言
  await sleep(50)
  ok(fs.existsSync(path.join(libDir, 'classes', 'Node.json')), '取消不影响旧库(原子接管设计)')
  ok(!fs.readdirSync(path.join(WORK, 'gpm-docs')).some((n) => n.startsWith('.work-')), '取消后暂存目录已清理')
  state.hang = false

  // ---------- 引擎失败 ----------
  section('引擎失败路径')
  state.exitCode = 1
  const g4 = lib.generateDocs(V1)
  const t4 = await waitTask(g4.taskId)
  ok(t4.status === 'error' && /退出码 1/.test(t4.error), '非零退出码报 error', t4.error)
  ok(fs.existsSync(path.join(libDir, 'index.json')), '失败保留旧库')
  ok(docs.get('godot/docs/4.7.2-stable-standard-win64'), '失败保留旧 db 记录')
  ok(lib.docsListClasses(V1).ok === true, '旧库仍可浏览')
  ok(!fs.readdirSync(path.join(WORK, 'gpm-docs')).some((n) => n.startsWith('.work-')), '失败后暂存目录已清理')
  state.exitCode = 0

  // ---------- 重新生成(索引缓存按 mtime 失效) ----------
  section('重新生成')
  const g5 = lib.generateDocs(V1)
  await waitTask(g5.taskId)
  ok(lib.docsLibraryStatus(V1).status === 'ready', '重新生成成功')
  ok(lib.docsListClasses(V1).classes.length === t1.total, '索引可再读')

  // ---------- 缓存统计与清理 ----------
  section('缓存统计与清理')
  const info = lib.docsCacheInfo()
  ok(info.libraries.length === 1 && info.libraries[0].versionId === V1 && info.sizeBytes > 0, 'docsCacheInfo 统计', JSON.stringify(info))
  lib.docsCleanCache([V1])
  ok(!fs.existsSync(libDir), '清理后目录删除')
  ok(!docs.get('godot/docs/4.7.2-stable-standard-win64'), '清理后 db 记录删除')
  ok(JSON.stringify(lib.docsListFavorites()) === '["Vector2"]' && lib.docsListHistory().length === 30, '收藏/历史不受清理影响')
  ok(lib.docsListClasses(V1).ok === false, '清理后列表返回错误')

  // ---------- 汇总 ----------
  console.log(`\n${pass} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log('FAILURES:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
