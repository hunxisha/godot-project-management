// 导出模板(export templates)下载安装的回归测试。
//
// 覆盖:tag → 版本目录名映射、tpz 地址构造、模板目录解析(._sc_ 自包含/各平台用户目录,
// 环境注入不触碰真实 APPDATA)、任务化安装(下载→解压→校验→落位→登记)、覆盖重装、
// 按清单卸载、以及三类失败(未知引擎/包不完整/下载失败)。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/templates.test.js
//   node src-ztools/preload/lib/__tests__/templates.test.js --no-immediate
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))

const LIB = positional[0] || path.resolve(__dirname, '..')
const WORK = positional[1] || fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-templates-test-'))

if (!fs.existsSync(path.join(LIB, 'templates.js'))) {
  console.error(`找不到被测模块: ${path.join(LIB, 'templates.js')}`)
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

// ---------- http 打桩(必须在 require install/templates 之前) ----------
const state = { fixtureZip: '', downloads: 0, failMessage: '' }

function stub(relFile, exports) {
  const abs = require.resolve(path.join(LIB, relFile))
  require.cache[abs] = { id: abs, filename: abs, loaded: true, children: [], paths: [], exports }
}

stub('http.js', {
  downloadFile: (url, dest) => {
    if (state.failMessage) return { promise: Promise.reject(new Error(state.failMessage)) }
    if (!state.fixtureZip) return { promise: Promise.reject(new Error('stub http: 没有夹具 zip')) }
    state.downloads++
    fs.copyFileSync(state.fixtureZip, dest)
    return { promise: Promise.resolve() }
  },
  getJson: async () => {
    throw new Error('stub http: getJson unexpected')
  },
  getText: async () => {
    throw new Error('stub http: getText unexpected')
  }
})

const { createZip, ensureDir } = require(path.join(LIB, 'extract.js'))
const install = require(path.join(LIB, 'install.js'))
const templates = require(path.join(LIB, 'templates.js'))

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const sleep = (ms = 10) => new Promise((r) => setTimeout(r, ms))

/** 等待任务进入终态 */
async function waitTask(id) {
  for (let i = 0; i < 1000; i++) {
    const t = install.taskQueue.get(id)
    if (t && ['done', 'error', 'canceled'].includes(t.status)) return t
    await sleep(10)
  }
  throw new Error('任务超时未完成')
}

let zipSeq = 0
/** files: 相对路径 → 文本内容;打成真 zip 供 downloadFile 桩返回 */
async function buildZip(files) {
  const src = path.join(WORK, `zipsrc-${++zipSeq}`)
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(src, rel)
    ensureDir(path.dirname(p))
    fs.writeFileSync(p, content)
  }
  const zip = path.join(WORK, `fixture-${zipSeq}.zip`)
  await createZip(src, zip)
  fs.rmSync(src, { recursive: true, force: true })
  return zip
}

/** 注册一台假引擎(不需要真实可执行文件,只需要路径形状) */
function makeEngine(tag, variant = 'standard') {
  const versionId = `godot/version/${tag}-${variant}-win64`
  docs.set(versionId, {
    _id: versionId,
    id: versionId,
    tag,
    name: `Godot ${tag}`,
    variant,
    platform: 'win64',
    exePath: path.join(WORK, 'engines', `Godot_${tag}`, 'Godot.exe'),
    installDir: path.join(WORK, 'engines', `Godot_${tag}`),
    managed: true,
    installedAt: Date.now()
  })
  return versionId
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  // ---------- 1 ----------
  section('1. tag → 版本目录名映射与 tpz 地址')
  ok(templates.versionDirFromTag('4.3-stable') === '4.3.stable', '4.3-stable → 4.3.stable')
  ok(templates.versionDirFromTag('4.2.2-stable') === '4.2.2.stable', '4.2.2-stable → 4.2.2.stable')
  ok(templates.versionDirFromTag('4.4-rc1') === '4.4.rc1', '4.4-rc1 → 4.4.rc1')
  ok(
    templates.templateUrl('4.3-stable', 'standard') ===
      'https://github.com/godotengine/godot/releases/download/4.3-stable/Godot_v4.3-stable_export_templates.tpz',
    '标准变体地址正确'
  )
  ok(
    templates.templateUrl('4.1-stable', 'mono') ===
      'https://github.com/godotengine/godot/releases/download/4.1-stable/Godot_v4.1-stable_mono_export_templates.tpz',
    'mono 变体地址带 _mono'
  )

  // ---------- 2 ----------
  section('2. 模板目录解析:._sc_ 自包含与各平台用户目录(环境注入,不触真实目录)')
  {
    const exeDir = path.join(WORK, 'sc-engine')
    ensureDir(exeDir)
    fs.writeFileSync(path.join(exeDir, '._sc_'), '')
    const sc = templates.resolveTemplatesBase(path.join(exeDir, 'Godot.exe'))
    ok(sc.selfContained === true && sc.base === path.join(exeDir, 'editor_data', 'export_templates'), '._sc_ → exe 旁 editor_data/export_templates', sc.base)

    const win = templates.resolveTemplatesBase('C:/x/Godot.exe', { appData: 'D:/AppData/Roaming', platform: 'win32' })
    ok(win.base === path.join('D:/AppData/Roaming', 'Godot', 'export_templates'), 'win32 → %APPDATA%\\Godot\\export_templates', win.base)

    const mac = templates.resolveTemplatesBase('/x/Godot.app/Contents/MacOS/Godot', { home: '/Users/t', platform: 'darwin' })
    ok(mac.base === path.join('/Users/t', 'Library', 'Application Support', 'Godot', 'export_templates'),
      'macOS → ~/Library/Application Support/Godot/export_templates', mac.base)

    const lin = templates.resolveTemplatesBase('/x/godot', { home: '/home/t', platform: 'linux' })
    ok(lin.base === path.join('/home/t', '.local', 'share', 'godot', 'export_templates'), 'Linux → ~/.local/share/godot/export_templates', lin.base)
  }

  // ---------- 3 ----------
  section('3. 安装流程:下载 → 解压 → 校验 → 落位 → 登记')
  const versionId = makeEngine('4.3-stable')
  state.fixtureZip = await buildZip({
    'templates/windows_release_x86_64.exe': 'win-release',
    'templates/windows_release_x86_64_console.exe': 'win-console',
    'templates/android_source.zip': 'android',
    'templates/web_release.zip': 'web'
  })
  const tplBase = path.join(WORK, 'export_templates')
  const r3 = templates.downloadAndInstallTemplates({ versionId }, { versionsRoot: path.join(WORK, 'root'), templatesBase: tplBase })
  ok(r3.ok === true && !!r3.taskId, '安装入队成功', r3.error)
  const t3 = await waitTask(r3.taskId)
  ok(t3.status === 'done', `任务完成(${t3.status} ${t3.error || ''})`)
  ok(t3.kind === 'templates' && t3.tag === '4.3-stable', '任务带 kind=templates 与引擎 tag')
  const dest3 = path.join(tplBase, '4.3.stable')
  ok(fs.readFileSync(path.join(dest3, 'windows_release_x86_64.exe'), 'utf8') === 'win-release', '模板文件落到版本目录')
  const doc3 = docs.get(`godot/templates/${versionId}`)
  ok(!!doc3 && doc3.versionDir === '4.3.stable' && doc3.fileCount === 4, '记录版本目录与文件数')
  ok(!!doc3 && doc3.size > 0, '记录安装体积')
  ok(state.downloads === 1, '下载发生一次')
  ok(!fs.existsSync(path.join(WORK, 'root', 'downloads', 'Godot_v4.3-stable_export_templates.tpz.part')), '.part 临时文件已清理')

  const s3 = templates.exportTemplateStatus({ versionId, templatesBase: tplBase })
  ok(s3.installed === true && s3.versionDir === '4.3.stable' && s3.tracked === true, '状态查询:已安装')

  // ---------- 4 ----------
  section('4. 覆盖重装:先清后装,目录不残留旧文件')
  const before4 = state.downloads
  const r4 = templates.downloadAndInstallTemplates({ versionId }, { versionsRoot: path.join(WORK, 'root'), templatesBase: tplBase })
  const t4 = await waitTask(r4.taskId)
  ok(t4.status === 'done', '重装完成', t4.error)
  ok(state.downloads === before4 + 1, '重装重新下载')
  ok(fs.existsSync(path.join(dest3, 'windows_release_x86_64.exe')), '重装后模板文件仍在')

  // ---------- 5 ----------
  section('5. 卸载:目录与记录一并清除')
  const r5 = templates.uninstallExportTemplates({ versionId, templatesBase: tplBase })
  ok(r5.ok === true, '卸载成功', r5.error)
  ok(!fs.existsSync(dest3), '模板目录已删除')
  ok(!docs.get(`godot/templates/${versionId}`), '记录已删除')
  ok(templates.exportTemplateStatus({ versionId, templatesBase: tplBase }).installed === false, '状态回到未安装')

  // ---------- 6 ----------
  section('6. 失败路径:未知引擎 / 包不完整 / 下载失败')
  const r6 = templates.downloadAndInstallTemplates({ versionId: 'godot/version/none' }, { templatesBase: tplBase })
  ok(r6.ok === false && /未找到该引擎/.test(r6.error || ''), `未知引擎直接拒绝(${r6.error})`)
  ok(!install.taskQueue.get(r6.taskId || ''), '被拒绝的请求不产生任务')

  state.fixtureZip = await buildZip({ 'templates/readme.txt': 'no platform files' })
  const versionId2 = makeEngine('4.2.2-stable')
  const r6b = templates.downloadAndInstallTemplates({ versionId: versionId2 }, { templatesBase: tplBase })
  const t6b = await waitTask(r6b.taskId)
  ok(t6b.status === 'error' && /模板包不完整/.test(t6b.error || ''), `包内无平台文件时报错(${t6b.error})`)
  ok(!fs.existsSync(path.join(tplBase, '4.2.2.stable')), '校验失败不落任何文件')
  ok(!docs.get(`godot/templates/${versionId2}`), '失败不写记录')

  state.failMessage = '网络断了'
  const r6c = templates.downloadAndInstallTemplates({ versionId }, { templatesBase: tplBase })
  const t6c = await waitTask(r6c.taskId)
  ok(t6c.status === 'error' && t6c.error === '网络断了', '下载失败如实上报')
  state.failMessage = ''

  // ---------- 7 ----------
  section('7. 手动安装识别:目录存在即视为已安装')
  ensureDir(path.join(tplBase, '3.5.2.stable'))
  fs.writeFileSync(path.join(tplBase, '3.5.2.stable', 'windows_release_64.exe'), 'manual')
  const versionId3 = makeEngine('3.5.2-stable')
  const s7 = templates.exportTemplateStatus({ versionId: versionId3, templatesBase: tplBase })
  ok(s7.installed === true && s7.tracked === false, `无记录但目录存在 → 已安装(未跟踪)(${JSON.stringify(s7)})`)

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
