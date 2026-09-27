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

// ---------- child_process / http 打桩(内建模块必须用 Module._load 拦截) ----------
const state = {
  children: [],
  exitCode: 0,
  outputLines: ['Godot Engine v4.7.2.stable'],
  hang: false,
  failSpawn: false,
  /** 翻译下载桩:string=返回该 po;null=网络不可用 */
  poText: null,
  /** 类 XML 桩:string=返回该 XML;null=网络不可用 */
  xmlText: null
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
  if (fromDocs && request === './http') {
    return {
      getText: (url) => new Promise((resolve, reject) => {
        process.nextTick(() => {
          // 类 XML 与翻译 po 分开打桩
          if (/\/doc\/classes\//.test(url)) {
            if (typeof state.xmlText === 'string') resolve(state.xmlText)
            else reject(new Error('网络不可用'))
            return
          }
          if (typeof state.poText === 'string') resolve(state.poText)
          else reject(new Error('网络不可用'))
        })
      })
    }
  }
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

  // ---------- 中文翻译:po 解析与应用(纯函数) ----------
  section('中文翻译:po 解析')
  const PO_FIXTURE = [
    '# 翻译头注释',
    'msgid ""',
    'msgstr ""',
    '"Language: zh_Hans\\n"',
    '',
    'msgid "Base class for all scene objects."',
    'msgstr "所有场景对象的基类。"',
    '',
    '#, fuzzy',
    'msgid "fuzzy 的一条"',
    'msgstr "不应进表"',
    '',
    'msgctxt "某上下文"',
    'msgid "带上下文的一条"',
    'msgstr "不应进表"',
    '',
    'msgid "未翻译的一条"',
    'msgstr ""',
    '',
    'msgid ""',
    '"多行 "',
    '"msgid 第二段\\n"',
    '"以换行结尾"',
    'msgstr "多行译文"'
  ].join('\n')
  const poParsed = lib.parsePo(PO_FIXTURE)
  ok(poParsed.map.size === 2, '头部/fuzzy/msgctxt/未翻译全部跳过', String(poParsed.map.size))
  ok(poParsed.map.get('Base class for all scene objects.') === '所有场景对象的基类。', '单行 msgid 提取')
  ok(poParsed.map.get('多行 msgid 第二段\n以换行结尾') === '多行译文', '多行 msgid 拼接与 \n 转义')

  section('中文翻译:应用映射')
  const trSmall = new Map([
    ['Base class for all scene objects.', '所有场景对象的基类。'],
    ['Adds a child [param node].', '添加子节点 [param node]。']
  ])
  const hits = { count: 0, total: 0 }
  const zhCls = lib.applyTranslations(core, trSmall, hits)
  ok(zhCls.brief === '所有场景对象的基类。', 'brief 替换为中文')
  ok(zhCls.description === core.description, '未命中的描述保持英文')
  ok(zhCls.methods.find((m) => m.name === 'add_child').description === '添加子节点 [param node]。', '方法描述替换(BBCode 原样保留)')
  ok(zhCls.methods.find((m) => m.name === 'get_tree').description === 'Returns the tree.', '未命中方法保持英文')
  ok(hits.count === 2, '命中计数', String(hits.count))
  ok(hits.total >= hits.count && hits.total >= 6, '可翻译字符串总数被统计', String(hits.total))

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

  // ---------- 中文翻译:生成流程(翻译下载桩) ----------
  section('中文翻译:生成流程')
  const zhPo = [
    'msgid "Base class for all scene objects."',
    'msgstr "所有场景对象的基类。"',
    '',
    "msgid \"Nodes are Godot's building blocks. See [method _ready] and [SceneTree].\"",
    'msgstr "节点是 Godot 的基本构件。参见 [method _ready] 与 [SceneTree]。"'.replace('与', '与'),
    ''
  ]
  state.poText = zhPo.join('\n')
  const g6 = lib.generateDocs(V1)
  await waitTask(g6.taskId)
  const nodeZh = JSON.parse(fs.readFileSync(path.join(libDir, 'classes', 'Node.json'), 'utf8'))
  ok(nodeZh.brief === '所有场景对象的基类。', '生成时 brief 已译为中文', nodeZh.brief)
  ok(nodeZh.description.includes('基本构件') && nodeZh.description.includes('[method _ready]'), '描述中文且 BBCode 保留')
  const zhRec = docs.get('godot/docs/4.7.2-stable-standard-win64')
  ok(zhRec.lang === 'zh-CN' && zhRec.translatedCount > 0, 'db 记录 lang=zh-CN + 命中数', JSON.stringify({ lang: zhRec.lang, n: zhRec.translatedCount }))
  ok(zhRec.stringCount >= zhRec.translatedCount && zhRec.stringCount > 0, 'db 记录可翻译字符串总数(覆盖率分母)', JSON.stringify({ t: zhRec.stringCount, h: zhRec.translatedCount }))
  ok(lib.docsLibraryStatus(V1).lang === 'zh-CN', '状态接口带 lang')
  ok(fs.existsSync(path.join(WORK, 'gpm-docs', 'po-cache', 'zh_Hans-4.7.2-stable.po')), 'po 已磁盘缓存')

  // 网络不可用 + 无缓存 → 降级英文库,生成不失败
  fs.rmSync(path.join(WORK, 'gpm-docs', 'po-cache'), { recursive: true, force: true })
  state.poText = null
  const g7 = lib.generateDocs(V1)
  await waitTask(g7.taskId)
  const nodeEn = JSON.parse(fs.readFileSync(path.join(libDir, 'classes', 'Node.json'), 'utf8'))
  ok(nodeEn.brief === 'Base class for all scene objects.', '无翻译时保持英文')
  ok(lib.docsLibraryStatus(V1).lang === 'en', '降级库 lang=en', lib.docsLibraryStatus(V1).lang)

  // ---------- 强制刷新翻译(forceTranslation) ----------
  section('强制刷新翻译')
  // 1) 正常生成:建缓存,brief 为 v1 译文
  state.poText = zhPo.join('\n')
  const f1 = lib.generateDocs(V1)
  await waitTask(f1.taskId)
  ok(JSON.parse(fs.readFileSync(path.join(libDir, 'classes', 'Node.json'), 'utf8')).brief === '所有场景对象的基类。', '正常生成使用 v1 译文', JSON.parse(fs.readFileSync(path.join(libDir, 'classes', 'Node.json'), 'utf8')).brief)
  // 2) 换新译文但不强刷:po 磁盘缓存命中,仍是 v1
  state.poText = ['msgid "Base class for all scene objects."', 'msgstr "场景对象的基类(新版译文)。"'].join('\n')
  const f2 = lib.generateDocs(V1)
  await waitTask(f2.taskId)
  ok(JSON.parse(fs.readFileSync(path.join(libDir, 'classes', 'Node.json'), 'utf8')).brief === '所有场景对象的基类。', '不强刷时缓存命中仍是旧译文', JSON.parse(fs.readFileSync(path.join(libDir, 'classes', 'Node.json'), 'utf8')).brief)
  // 3) 强刷:清缓存重新下载,拿到新版译文
  const f3 = lib.generateDocs(V1, { forceTranslation: true })
  await waitTask(f3.taskId)
  ok(JSON.parse(fs.readFileSync(path.join(libDir, 'classes', 'Node.json'), 'utf8')).brief === '场景对象的基类(新版译文)。', '强刷后应用新译文', JSON.parse(fs.readFileSync(path.join(libDir, 'classes', 'Node.json'), 'utf8')).brief)
  state.poText = null

  // ---------- 教程链接(按需从官方 XML 补) ----------
  section('教程链接解析与应用')
  const XML_SAMPLE = [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    '<class name="Control" inherits="CanvasItem">',
    '\t<tutorials>',
    '\t\t<link title="GUI documentation index">$DOCS_URL/tutorials/ui/index.html</link>',
    '\t\t<link title="All GUI Demos">https://github.com/godotengine/godot-demo-projects/tree/master/gui</link>',
    '\t</tutorials>',
    '</class>'
  ].join('\n')
  const tuts = lib.parseTutorials(XML_SAMPLE, '4.7.2-stable')
  ok(tuts.length === 2, '教程条目数', String(tuts.length))
  ok(tuts[0].url === 'https://docs.godotengine.org/en/4.7/tutorials/ui/index.html', '$DOCS_URL 替换为版本化前缀', tuts[0].url)
  ok(tuts[1].url.startsWith('https://github.com/'), '外部链接原样保留')
  ok(lib.parseTutorials('<class/>', '4.7.2-stable').length === 0, '无 tutorials 节返回空')

  state.xmlText = XML_SAMPLE
  const ex1 = await lib.docsGetClassExtras(V1, 'Node')
  ok(ex1 && ex1.tutorials.length === 2, '按需拉取并解析', JSON.stringify(ex1 && ex1.tutorials.length))
  ok(fs.existsSync(path.join(WORK, 'gpm-docs', '4.7.2-stable-standard-win64', 'extras', 'Node.json')), 'extras 已缓存到库目录')
  state.xmlText = null
  const ex2 = await lib.docsGetClassExtras(V1, 'Node')
  ok(ex2 && ex2.tutorials.length === 2, '缓存命中(离线仍可用)')
  const ex3 = await lib.docsGetClassExtras(V1, 'NotAClass')
  ok(ex3 === null, '下载失败/未知类返回 null(静默降级)')
  ok(await lib.docsGetClassExtras(V1, '../evil') === null, '非法类名直接拒绝')

  // ---------- 导入 extension_api.json 建库(无引擎兜底) ----------
  section('导入 API 文件建库')
  const apiFile = path.join(WORK, 'api-import.json')
  fs.writeFileSync(apiFile, JSON.stringify({
    header: { version_full_name: '4.6.0.stable.official' },
    classes: [
      { name: 'Imported', inherits: 'Object', brief_description: 'From import.', description: '', methods: [], properties: [], signals: [], constants: [], enums: [] }
    ],
    builtin_classes: [],
    utility_functions: [],
    global_constants: [],
    global_enums: [],
    singletons: []
  }))
  const imp1 = lib.importDocsLibrary({ jsonPath: apiFile })
  ok(imp1.ok === true && !!imp1.taskId, '入队导入', JSON.stringify(imp1))
  const it1 = await waitTask(imp1.taskId)
  ok(it1.status === 'done', '导入任务完成', it1.error || '')
  ok(imp1.versionId === 'godot/version/import-4-6-0-stable', '版本 id 由 header 推导', imp1.versionId)
  const impRec = docs.get('godot/docs/import-4-6-0-stable')
  ok(impRec && impRec.classCount === 2 && impRec.tag === '4-6-0-stable', '导入库落库(1 类 + @GlobalScope 伪类)', JSON.stringify(impRec))
  ok(lib.docsLibraryStatus(imp1.versionId).status === 'ready', '导入库可查询状态')
  ok(lib.docsGetClass(imp1.versionId, 'Imported')?.brief === 'From import.', '导入库可读类正文')

  const badFile = path.join(WORK, 'not-api.json')
  fs.writeFileSync(badFile, JSON.stringify({ hello: 1 }))
  ok(lib.importDocsLibrary({ jsonPath: badFile }).ok === false, '非 API 文件被拒绝')
  ok(lib.importDocsLibrary({ jsonPath: path.join(WORK, 'nope.json') }).ok === false, '文件不存在被拒绝')

  // ---------- 跨版本差异对比 ----------
  section('跨版本差异对比')
  // 纯函数:diffGroup 的三态与签名判定
  const gd = lib.diffGroup(
    [{ name: 'a', type: 'int' }, { name: 'gone', type: 'int' }, { name: 'same', type: 'int' }],
    [{ name: 'a', type: 'float' }, { name: 'same', type: 'int' }, { name: 'fresh', type: 'int' }],
    (x) => x.name,
    (x) => x.type
  )
  ok(gd.added.join(',') === 'fresh', '新增项', gd.added.join(','))
  ok(gd.removed.join(',') === 'gone', '移除项', gd.removed.join(','))
  ok(gd.changed.length === 1 && gd.changed[0].name === 'a' && gd.changed[0].from === 'int' && gd.changed[0].to === 'float', '签名变化项', JSON.stringify(gd.changed))

  // 同名重载按参数个数区分身份
  const ov = lib.diffGroup(
    [{ name: 'f', params: [], returnType: 'void' }, { name: 'f', params: [{ type: 'int' }], returnType: 'void' }],
    [{ name: 'f', params: [{ type: 'int' }], returnType: 'void' }],
    (x) => `${x.name}/${x.params.length}`,
    (x) => `${x.name}(${x.params.map((p) => p.type).join(',')})`
  )
  ok(ov.removed.length === 1 && ov.added.length === 0, '重载方法按参数个数区分(移除 0 参重载)', JSON.stringify(ov))

  // 只比类型不比参数名:改参数名不算变化
  const renamed = lib.diffGroup(
    [{ name: 'f', params: [{ name: 'old', type: 'int' }], returnType: 'void' }],
    [{ name: 'f', params: [{ name: 'new', type: 'int' }], returnType: 'void' }],
    (x) => `${x.name}/${x.params.length}`,
    (x) => `${x.name}(${x.params.map((p) => p.type).join(',')})`
  )
  ok(renamed.changed.length === 0, '参数改名不算 API 变化', JSON.stringify(renamed.changed))

  // 库级差异:把当前库与导入库比(两者类集合不同)
  state.poText = null
  const imp2 = lib.importDocsLibrary({ jsonPath: apiFile })
  await waitTask(imp2.taskId)
  const dLib = lib.docsDiffLibraries(V1, imp2.versionId)
  ok(dLib.ok === true, '库级对比成功', dLib.error)
  ok(dLib.addedClasses.includes('Imported') === true && dLib.removedClasses.includes('Node') === true, '以 A 为基准:Imported 新增、Node 移除', JSON.stringify({ add: dLib.addedClasses.slice(0, 3), rm: dLib.removedClasses.slice(0, 3) }))
  ok(lib.docsDiffLibraries(V1, 'godot/version/nonexistent').ok === false, '缺库时拒绝对比')

  // 类级差异:构造同类的两版正文
  const baseCls = lib.mapClass({ name: 'X', inherits: 'Object', brief_description: '', description: '', methods: [{ name: 'f', return_type: 'void', arguments: [] }], properties: [], signals: [], constants: [], enums: [] })
  const nextCls = lib.mapClass({ name: 'X', inherits: 'RefCounted', brief_description: '', description: '', methods: [{ name: 'f', return_type: 'int', arguments: [] }, { name: 'g', return_type: 'void', arguments: [] }], properties: [], signals: [], constants: [], enums: [] })
  const cd = lib.diffClassDetail(baseCls, nextCls)
  ok(cd.inherits && cd.inherits.from === 'Object' && cd.inherits.to === 'RefCounted', '继承变化被识别', JSON.stringify(cd.inherits))
  ok(cd.methods.added.join(',') === 'g' && cd.methods.changed.length === 1 && cd.methods.changed[0].to.includes('-> int'), '方法新增与返回类型变化', JSON.stringify(cd.methods))
  ok(lib.diffClassDetail(baseCls, baseCls).inherits === null, '未变化时 inherits 为 null')

  // ---------- 项目脚本扫描 ----------
  section('GDScript 解析')
  const GD_SRC = [
    '@tool',
    '## 玩家的移动与状态。',
    '## 第二行说明。',
    'class_name Player, "res://icon.svg"',
    'extends CharacterBody2D',
    '',
    '## 生命值耗尽时发出。',
    'signal died(reason: String)',
    '',
    '## 最大速度(像素/秒)。',
    '@export var max_speed: float = 320.0',
    'var _internal: int',
    '',
    '## 状态枚举。',
    'enum State { IDLE, RUN, JUMP = 5 }',
    '',
    '## 重力常数。',
    'const GRAVITY := 980.0',
    '',
    '## 让玩家跳跃。',
    '## @param height 跳跃高度(像素)。',
    '## @return 是否成功起跳。',
    'func jump(height: float = 100.0) -> bool:',
    '    var local = 1',
    '    return true',
    '',
    'static func helper(a, b: int) -> void:',
    '    pass'
  ].join('\n')
  const gdCls = lib.parseGdScript(GD_SRC, { fileName: 'player.gd', scriptPath: 'F:/proj/player.gd' })
  ok(gdCls && gdCls.name === 'Player', 'class_name 解析', gdCls && gdCls.name)
  ok(gdCls.inherits === 'CharacterBody2D', 'extends 解析', gdCls.inherits)
  ok(gdCls.description.includes('玩家的移动与状态') && gdCls.description.includes('第二行说明'), '多行 ## 文档块')
  ok(gdCls.brief === '玩家的移动与状态。', 'brief 取首行')
  ok(gdCls.signals.length === 1 && gdCls.signals[0].name === 'died' && gdCls.signals[0].params[0].type === 'String', '信号含参数类型')
  ok(gdCls.members.length === 2 && gdCls.members[0].name === 'max_speed' && gdCls.members[0].type === 'float', '成员(含 @export)')
  ok(gdCls.members[0].defaultValue === '320.0', '成员默认值', gdCls.members[0].defaultValue)
  ok(gdCls.members[0].description.includes('@export'), '@export 注解写进描述(可检索)')
  ok(gdCls.enums.length === 1 && gdCls.enums[0].values.length === 3 && gdCls.enums[0].values[2].value === '5', '枚举与显式赋值', JSON.stringify(gdCls.enums[0].values))
  ok(gdCls.constants.length === 1 && gdCls.constants[0].name === 'GRAVITY', '常量')
  const jump = gdCls.methods.find((m) => m.name === 'jump')
  ok(jump && jump.returnType === 'bool' && jump.params[0].type === 'float' && jump.params[0].defaultValue === '100.0', '方法签名与默认值', JSON.stringify(jump && jump.params))
  ok(jump.description.includes('让玩家跳跃') && jump.description.includes('@param height'), '方法描述含文档标签')
  ok(!gdCls.methods.some((m) => m.name === 'local'), '函数体内的局部变量不收录')
  const helper = gdCls.methods.find((m) => m.name === 'helper')
  ok(helper && helper.qualifiers.includes('static') && helper.params[0].type === 'Variant', 'static 与无类型参数')
  ok(gdCls.sourceFile === 'F:/proj/player.gd', '记录来源脚本路径')

  ok(lib.parseGdScript('extends Node\nfunc f():\n    pass', { fileName: 'x.gd' }).name === 'x', '无 class_name 时退回文件名')
  ok(lib.parseGdScript('# 只有注释\nvar a = 1', {}) !== null, '无 class_name 但有成员仍可解析')
  ok(lib.parseGdScript('', {}) === null, '空文件返回 null')

  section('项目脚本扫描入库')
  const projDir = path.join(WORK, 'ProjScripts')
  fs.mkdirSync(path.join(projDir, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(projDir, 'scripts', 'player.gd'), GD_SRC)
  fs.writeFileSync(path.join(projDir, 'scripts', 'plain.gd'), 'extends Node\nfunc f():\n    pass\n')
  docs.set('godot/project/p1', { _id: 'godot/project/p1', id: 'p1', name: 'Scanned', path: projDir })
  const sc = lib.scanProjectDocs({ projectId: 'p1' })
  ok(sc.ok === true && !!sc.taskId, '扫描入队', JSON.stringify(sc))
  const st1 = await waitTask(sc.taskId)
  ok(st1.status === 'done', '扫描完成', st1.error || '')
  ok(sc.versionId === 'godot/version/project-p1', '库 id 由项目推导', sc.versionId)
  const scRec = docs.get('godot/docs/project-p1')
  ok(scRec && scRec.kind === 'project' && scRec.classCount === 1 && scRec.sourceProject === 'p1', '项目库落库(kind=project)', JSON.stringify(scRec))
  ok(lib.docsGetClass(sc.versionId, 'Player')?.methods.length === 2, '项目类可浏览')
  ok(lib.docsListClasses(sc.versionId).classes[0].name === 'Player', '项目库索引可用(复用搜索/树)')
  ok(lib.docsSearch(sc.versionId, 'jump').length > 0, '项目库可搜索')
  ok(lib.docsLibraryStatus(sc.versionId).kind === 'project', '状态接口带 kind')
  ok(lib.scanProjectDocs({ projectId: 'nope' }).ok === false, '未知项目被拒绝')

  // ---------- 全文搜索(描述正文) ----------
  section('全文检索')
  const ft = lib.docsSearchFullText(V1, 'building blocks')
  ok(ft.length >= 1 && ft[0].className === 'Node', '正文命中描述文本', JSON.stringify(ft[0] && { c: ft[0].className, s: ft[0].score }))
  ok(ft[0].snippet.includes('building blocks'), '片段包含命中处', ft[0].snippet)
  ok(ft[0].kind === 'body', '命中类型为 body')
  ok(lib.docsSearchFullText(V1, 'a').length === 0, '过短查询(1 字符)不检索')
  ok(lib.docsSearchFullText(V1, 'zzz-not-exist').length === 0, '无命中返回空')
  // 命中次数排序:多次出现的词应排前
  const multi = lib.docsSearchFullText(V1, 'the')
  ok(multi.length >= 2 && multi[0].score >= multi[1].score, '按命中次数排序', JSON.stringify(multi.slice(0, 2).map((h) => `${h.className}:${h.score}`)))
  ok(lib.docsSearchFullText('godot/version/nonexistent', 'node').length === 0, '无效库返回空')

  // ---------- 缓存统计与清理 ----------
  section('缓存统计与清理')
  const info = lib.docsCacheInfo()
  ok(
    info.libraries.some((l) => l.versionId === V1 && l.sizeBytes > 0) && info.libraries.length >= 1,
    'docsCacheInfo 统计', JSON.stringify(info)
  )
  // 导入库一并清掉,避免影响后续断言
  lib.docsCleanCache([V1, imp1.versionId])
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
