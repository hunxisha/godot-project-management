// 一键导出(headless export)的回归测试。
//
// 覆盖:export_presets.cfg 解析(顶层字段采集/子 section 忽略)、runExport 的前置校验
// (未知项目/未绑引擎/缺导出模板/预设不存在)、任务化导出全流程(stdout 尾行/成功/失败/
// 取消)。引擎进程用 node:child_process 的桩代替 —— 不需要真实 Godot。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/exporter.test.js
//   node src-ztools/preload/lib/__tests__/exporter.test.js --no-immediate
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))

const LIB = positional[0] || path.resolve(__dirname, '..')
const WORK = positional[1] || fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-exporter-test-'))

if (!fs.existsSync(path.join(LIB, 'exporter.js'))) {
  console.error(`找不到被测模块: ${path.join(LIB, 'exporter.js')}`)
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

// ---------- child_process 打桩(必须在 require exporter.js 之前) ----------
// fakeChild 模拟 Godot 导出进程:产出 stdout 行、以给定退出码关闭。
// 内建模块不走 require.cache,必须用 Module._load 拦截(同 http.test.js 的做法)。
const Module = require('node:module')
const state = { children: [], exitCode: 0, outputLines: ['Godot Engine v4.3.stable - Exporting...'], hang: false, failSpawn: false }

function fakeSpawn(exePath, args) {
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
    for (const line of state.outputLines) child.stdout.emit('data', Buffer.from(line + '\n'))
    child.emit('close', state.exitCode)
  })
  return child
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  const fromExporter = parent && /exporter\.js$/.test(parent.filename || '')
  if (fromExporter && request === 'node:child_process') return { spawn: fakeSpawn }
  return origLoad.apply(this, arguments)
}

const exporter = require(path.join(LIB, 'exporter.js'))

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const sleep = (ms = 10) => new Promise((r) => setTimeout(r, ms))

async function waitTask(id) {
  for (let i = 0; i < 1000; i++) {
    const t = getTask(id)
    if (t && ['done', 'error', 'canceled'].includes(t.status)) return t
    await sleep(10)
  }
  throw new Error('任务超时未完成')
}

// taskQueue 通过 exporter 内部队列观察 —— 从 watch 快照里取任务
let latestSnap = []
exporter.watchExportTasks((snap) => { latestSnap = snap })
function getTask(id) {
  return latestSnap.find((t) => t.id === id)
}

const PRESETS_CFG = [
  '[preset.0]',
  '',
  'name="Windows Desktop"',
  'platform="Windows Desktop"',
  'runnable=true',
  'export_path="builds/windows.exe"',
  '',
  '[preset.0.options]',
  '',
  'custom_template/debug=""',
  '',
  '[preset.1]',
  'name="Web"',
  'platform="Web"',
  'export_path="builds/web/index.zip"'
].join('\n')

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  // ---------- 1 ----------
  section('1. parseExportPresets:顶层字段采集,子 section 忽略')
  const presets = exporter.parseExportPresets(PRESETS_CFG)
  ok(presets.length === 2, `解析出 2 个预设(实际 ${presets.length})`)
  ok(presets[0].name === 'Windows Desktop' && presets[0].platform === 'Windows Desktop', '预设 0 字段正确')
  ok(presets[0].exportPath === 'builds/windows.exe', 'export_path 正确', presets[0].exportPath)
  ok(presets[1].name === 'Web' && presets[1].exportPath === 'builds/web/index.zip', '预设 1 字段正确')

  // ---------- 2 ----------
  section('2. runExport 前置校验')
  {
    const projectPath = path.join(WORK, 'Proj')
    fs.mkdirSync(path.join(projectPath, '.godot'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, 'project.godot'), 'config_version=5\n')
    fs.writeFileSync(path.join(projectPath, 'export_presets.cfg'), PRESETS_CFG)
    // 引擎目录含 ._sc_ → 模板装在 exe 旁;预置模板文件供状态查询
    const exeDir = path.join(WORK, 'engine')
    fs.mkdirSync(path.join(exeDir, 'editor_data', 'export_templates', '4.3.stable'), { recursive: true })
    fs.writeFileSync(path.join(exeDir, '._sc_'), '')
    fs.writeFileSync(path.join(exeDir, 'editor_data', 'export_templates', '4.3.stable', 'windows_release_x86_64.exe'), 'tpl')
    fs.writeFileSync(path.join(exeDir, 'Godot.exe'), 'engine')
    const versionId = 'godot/version/4.3-stable-standard-win64'
    docs.set(versionId, {
      _id: versionId,
      id: versionId,
      tag: '4.3-stable',
      name: 'Godot 4.3',
      variant: 'standard',
      platform: 'win64',
      exePath: path.join(exeDir, 'Godot.exe'),
      installedAt: Date.now()
    })
    docs.set(`godot/project/${versionId}`, {
      _id: `godot/project/${versionId}`,
      id: `godot/project/${versionId}`,
      name: 'Proj',
      path: projectPath,
      configVersion: 5,
      favorite: false,
      openCount: 0,
      addedAt: Date.now(),
      versionId
    })
    const pid = `godot/project/${versionId}`

    ok(exporter.runExport({ projectId: 'godot/project/nope', presetName: 'Windows Desktop' }).ok === false, '未知项目拒绝')

    const noTpl = docs.get(versionId)
    // 临时摘掉模板目录:用独立引擎文档指向无模板目录
    const bareDir = path.join(WORK, 'engine-bare')
    fs.mkdirSync(bareDir, { recursive: true })
    fs.writeFileSync(path.join(bareDir, 'Godot.exe'), 'engine')
    docs.set(versionId, { ...noTpl, exePath: path.join(bareDir, 'Godot.exe') })
    const rNoTpl = exporter.runExport({ projectId: pid, presetName: 'Windows Desktop' })
    ok(rNoTpl.ok === false && rNoTpl.missingTemplates === true && /导出模板/.test(rNoTpl.error || ''),
      `缺模板时提前拦截(${rNoTpl.error})`)
    docs.set(versionId, noTpl)

    const rNoPreset = exporter.runExport({ projectId: pid, presetName: 'NoSuchPreset' })
    ok(rNoPreset.ok === false && /未找到导出预设/.test(rNoPreset.error || ''), `预设不存在拒绝(${rNoPreset.error})`)

    // ---------- 3 ----------
    section('3. 导出全流程:任务完成 / 输出尾行 / CLI 参数正确')
    const r3 = exporter.runExport({ projectId: pid, presetName: 'Windows Desktop' })
    ok(r3.ok === true && !!r3.taskId, '导出入队成功', r3.error)
    const t3 = await waitTask(r3.taskId)
    ok(t3.status === 'done', `任务完成(${t3.status} ${t3.error || ''})`)
    ok(t3.kind === 'export' && t3.projectName === 'Proj' && t3.presetName === 'Windows Desktop', '任务携带项目与预设信息')
    ok(t3.log.includes('Exporting'), 'stdout 尾行保留在任务上', t3.log)
    const child = state.children[state.children.length - 1]
    ok(child.args[0] === '--headless', 'headless 参数在最前', JSON.stringify(child.args))
    ok(child.args.includes('--export-release') && child.args.includes('Windows Desktop'), 'release 模式与预设名正确')
    ok(fs.existsSync(path.join(projectPath, 'builds')), '输出目录已创建')
    const hist = exporter.listExportHistory(pid)
    ok(hist.length === 1 && hist[0].presetName === 'Windows Desktop', '导出成功落一条历史记录', JSON.stringify(hist.map((h) => h.presetName)))
    ok(!!hist[0].outputPath && hist[0].finishedAt > 0, '历史记录含输出路径与完成时间')

    // .pck 输出走 export-pack
    state.outputLines = ['packing...']
    const r3b = exporter.runExport({ projectId: pid, presetName: 'Web' })
    const t3b = await waitTask(r3b.taskId)
    ok(t3b.status === 'done' && t3b.mode === 'export-pack', 'zip 输出判为 export-pack', t3b.mode)
    const child3b = state.children[state.children.length - 1]
    ok(child3b.args.includes('--export-pack'), 'pack 模式参数正确')

    // ---------- 4 ----------
    section('4. 失败与取消')
    state.exitCode = 1
    state.outputLines = ['ERROR: Template missing']
    const r4 = exporter.runExport({ projectId: pid, presetName: 'Windows Desktop' })
    const t4 = await waitTask(r4.taskId)
    ok(t4.status === 'error' && /退出码 1/.test(t4.error || ''), `非零退出码报错(${t4.error})`)
    ok(t4.log.includes('ERROR: Template missing'), '失败时保留输出尾行')
    state.exitCode = 0

    state.hang = true
    const r4b = exporter.runExport({ projectId: pid, presetName: 'Windows Desktop' })
    await sleep(30)
    const activeTask = getTask(r4b.taskId)
    ok(activeTask && activeTask.status === 'exporting', '挂起任务处于导出中')
    exporter.cancelExportTask(r4b.taskId)
    const t4b = await waitTask(r4b.taskId)
    ok(t4b.status === 'canceled', '取消后任务进入已取消')
    state.hang = false

    state.failSpawn = true
    const r4c = exporter.runExport({ projectId: pid, presetName: 'Windows Desktop' })
    const t4c = await waitTask(r4c.taskId)
    ok(t4c.status === 'error' && /启动引擎失败/.test(t4c.error || ''), `spawn 失败如实报错(${t4c.error})`)
    state.failSpawn = false

    // 失败/取消的导出不写历史(此前两次成功共 2 条);removeExportHistoryEntry 只删记录
    ok(exporter.listExportHistory(pid).length === 2, '失败与取消导出都不写历史(仍只有两次成功)', String(exporter.listExportHistory(pid).length))
    exporter.removeExportHistoryEntry(exporter.listExportHistory(pid)[0].id)
    ok(exporter.listExportHistory(pid).length === 1, '历史记录可删除')

    // dismiss 移除任务
    const before = latestSnap.length
    exporter.dismissExportTask(t4c.id)
    await sleep(10)
    ok(latestSnap.length === before - 1, 'dismiss 后任务从快照移除')
  }

  console.log(`\n${'='.repeat(56)}`)
  console.log(`PASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) {
    console.log('失败项:')
    for (const f of failures) console.log('  - ' + f)
    process.exitCode = 1
  } else {
    console.log('全部通过')
  }
}

main().catch((e) => {
  console.error('[harness] 未捕获异常:', e)
  process.exit(1)
})
