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
    return { promise: Promise.resolve(), cancel: () => {} }
  },
  // templates.js 用带续传的封装;桩里同款契约(promise + cancel)
  downloadResumable: (url, dest) => {
    if (state.failMessage) return { promise: Promise.reject(new Error(state.failMessage)) }
    if (!state.fixtureZip) return { promise: Promise.reject(new Error('stub http: 没有夹具 zip')) }
    state.downloads++
    fs.copyFileSync(state.fixtureZip, dest)
    return { promise: Promise.resolve(), cancel: () => {} }
  },
  getJson: async () => {
    throw new Error('stub http: getJson unexpected')
  },
  getText: async () => {
    throw new Error('stub http: getText unexpected')
  }
})

const { createZip, ensureDir } = require(path.join(LIB, 'extract.js'))
const fsutil = require(path.join(LIB, 'fsutil.js'))
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
  // 注入 win32:假模板包内是固定平台的 windows 文件,校验平台不能依赖真实运行环境(CI 是 linux)
  const r3 = templates.downloadAndInstallTemplates({ versionId }, { versionsRoot: path.join(WORK, 'root'), templatesBase: tplBase, platform: 'win32' })
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
  const r4 = templates.downloadAndInstallTemplates({ versionId }, { versionsRoot: path.join(WORK, 'root'), templatesBase: tplBase, platform: 'win32' })
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

  // ---------- 6b ----------
  section('6b. 本地导入(.tpz / 目录):不下载、versionDir 统一取法、覆盖走回收站')
  {
    // 白名单:与 Rust is_valid_version_dir_name 镜像
    ok(templates.isValidVersionDirName('4.3.stable') === true, '白名单放行版本串形态')
    ok(templates.isValidVersionDirName('../evil') === false && templates.isValidVersionDirName('a/b') === false &&
      templates.isValidVersionDirName('a\b') === false && templates.isValidVersionDirName('') === false,
      '★白名单拒 ../、分隔符、空串(目录名会被 join 到数据目录下,不能当穿越入口)')
    ok(templates.isValidVersionDirName('.hidden') === false && templates.isValidVersionDirName('带中文') === false,
      '点开头与非 ASCII 也拒')

    // .tpz 文件导入:零下载、就位、记录、源文件保留
    const vidLocal = makeEngine('4.5-dev6')
    state.fixtureZip = await buildZip({
      'templates/windows_release_x86_64.exe': 'win-release',
      'templates/web_nothreads.zip': 'web'
    })
    const before = state.downloads
    const rL = templates.downloadAndInstallTemplates(
      { versionId: vidLocal, srcPath: state.fixtureZip },
      { templatesBase: tplBase, platform: 'win32' }
    )
    ok(rL.ok === true, '.tpz 导入入队成功', rL.error)
    const tL = await waitTask(rL.taskId)
    ok(tL.status === 'done', `.tpz 导入完成(${tL.status} ${tL.error || ''})`)
    ok(state.downloads === before, '★本地导入不发起任何下载')
    const destL = path.join(tplBase, '4.5.dev6')
    ok(fs.existsSync(path.join(destL, 'windows_release_x86_64.exe')), '模板文件落到 tag 派生目录')
    ok(fs.existsSync(state.fixtureZip), '★用户选的源 .tpz 没被当成临时产物删掉')
    const docL = docs.get(`godot/templates/${vidLocal}`)
    ok(!!docL && docL.versionDir === '4.5.dev6', '记录 versionDir')

    // 显式 versionDir:装到自定义目录,记录跟着走
    const rV = templates.downloadAndInstallTemplates(
      { versionId: vidLocal, srcPath: state.fixtureZip, versionDir: '4.5.dev6.mycustom' },
      { templatesBase: tplBase, platform: 'win32' }
    )
    const tV = await waitTask(rV.taskId)
    ok(tV.status === 'done', '显式目录名生效', tV.error)
    ok(fs.existsSync(path.join(tplBase, '4.5.dev6.mycustom')), '装到自定义目录')
    ok(docs.get(`godot/templates/${vidLocal}`).versionDir === '4.5.dev6.mycustom', '记录写的是实际生效的目录名')
    ok(fs.existsSync(destL) && fs.readFileSync(path.join(destL, 'windows_release_x86_64.exe'), 'utf8') === 'win-release',
      'tag 派生的旧目录是第一次导入的那份,显式目录名的安装不碰它')
    ok(!fs.existsSync(path.join(tplBase, 'evil')), '穿越形态在同步闸就被拒,什么都没装')

    // 记录优先:不带显式参数再走一次(下载路径),必须装到记录里已有的自定义目录
    state.fixtureZip = await buildZip({ 'templates/windows_release_x86_64.exe': 'win-release-2' })
    const rP = templates.downloadAndInstallTemplates(
      { versionId: vidLocal },
      { templatesBase: tplBase, platform: 'win32' }
    )
    const tP = await waitTask(rP.taskId)
    ok(tP.status === 'done', `重装完成(${tP.error || ''})`)
    ok(fs.existsSync(path.join(tplBase, '4.5.dev6.mycustom', 'windows_release_x86_64.exe')) &&
      fs.readFileSync(path.join(tplBase, '4.5.dev6.mycustom', 'windows_release_x86_64.exe'), 'utf8') === 'win-release-2',
      '★记录里有 versionDir 时下载安装也装到那里(不漂回 tag 派生 —— 计划书点名的「实际装目录与 db 记录不一致」)')
    ok(fs.existsSync(path.join(destL, 'windows_release_x86_64.exe')) &&
      fs.readFileSync(path.join(destL, 'windows_release_x86_64.exe'), 'utf8') === 'win-release',
      '★tag 派生目录没被重装碰过(内容仍是第一次导入那份)')
    const docP = docs.get(`godot/templates/${vidLocal}`)
    ok(docP.versionDir === '4.5.dev6.mycustom', '记录仍是那个目录名')

    // 覆盖 = 回收站:探针替换 fsutil.trashPath(整体引用,属性替换生效),真删 + 记账
    const trashCalls = []
    const origTrash = fsutil.trashPath
    fsutil.trashPath = (p, isDir) => { trashCalls.push(String(p)); return origTrash(p, isDir) }
    try {
      const rT = templates.downloadAndInstallTemplates(
        { versionId: vidLocal, srcPath: state.fixtureZip, versionDir: '4.5.dev6.mycustom' },
        { templatesBase: tplBase, platform: 'win32' }
      )
      const tT = await waitTask(rT.taskId)
      ok(tT.status === 'done', '覆盖重装完成', tT.error)
      ok(trashCalls.includes(path.join(tplBase, '4.5.dev6.mycustom')),
        '★覆盖安装把旧目录交给了回收站通道(与显式卸载同一通道),不再是 rmSync 永久删除')
      ok(fs.existsSync(path.join(tplBase, '4.5.dev6.mycustom', 'windows_release_x86_64.exe')), '覆盖后新内容就位')
    } finally {
      fsutil.trashPath = origTrash
    }

    // 非法目录名:同步拒绝,不入队
    const rBad = templates.downloadAndInstallTemplates(
      { versionId: vidLocal, srcPath: state.fixtureZip, versionDir: '../evil' },
      { templatesBase: tplBase, platform: 'win32' }
    )
    ok(rBad.ok === false && /不合法/.test(rBad.error || ''), '非法目录名同步拒绝', rBad.error)
    ok(!install.taskQueue.get(rBad.taskId || ''), '被拒的请求不产生任务')

    // srcPath 不存在:同步拒绝
    const rNo = templates.downloadAndInstallTemplates(
      { versionId: vidLocal, srcPath: path.join(WORK, 'no-such.tpz') },
      { templatesBase: tplBase, platform: 'win32' }
    )
    ok(rNo.ok === false && rNo.error === '模板文件不存在', '来源文件不存在 → 同步拒绝', rNo.error)
    ok(!install.taskQueue.get(rNo.taskId || ''), '不产生任务')

    // 坏 zip:任务里报「压缩包无法解析」
    const badZip = path.join(WORK, 'bad.tpz')
    fs.writeFileSync(badZip, 'this is not a zip')
    const rBz = templates.downloadAndInstallTemplates(
      { versionId: vidLocal, srcPath: badZip },
      { templatesBase: tplBase, platform: 'win32' }
    )
    const tBz = await waitTask(rBz.taskId)
    ok(tBz.status === 'error' && /压缩包无法解析/.test(tBz.error || ''), `坏包报错(${tBz.error})`)
    ok(fs.existsSync(badZip), '坏包源文件保留(不当临时产物清理)')

    // 已解压目录形态:直接校验就位(源目录被 move 走 = 安装拿走它,不再复制一份)
    const dirSrc = path.join(WORK, 'staged-templates')
    fs.mkdirSync(path.join(dirSrc, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(dirSrc, 'templates', 'windows_release_x86_64.exe'), 'from-dir')
    const rD = templates.downloadAndInstallTemplates(
      { versionId: vidLocal, srcPath: dirSrc, versionDir: 'from.dir' },
      { templatesBase: tplBase, platform: 'win32' }
    )
    const tD = await waitTask(rD.taskId)
    ok(tD.status === 'done', `目录形态导入完成(${tD.error || ''})`)
    ok(fs.readFileSync(path.join(tplBase, 'from.dir', 'windows_release_x86_64.exe'), 'utf8') === 'from-dir', '目录内容就位')
    ok(!fs.existsSync(path.join(dirSrc, 'templates')),
      '★目录形态安装拿走的是模板本体(templates/ 子目录被移走),用户自己的外壳目录保留')

    // 自动存档(模板库 P0c):安装成功后 cpSync 独立副本进 tplpack 槽 + 写记录(dir=槽名)
    const dirSrc2 = path.join(WORK, 'staged-templates-2')
    fs.mkdirSync(path.join(dirSrc2, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(dirSrc2, 'templates', 'windows_release_x86_64.exe'), 'from-dir-2')
    const rA = templates.downloadAndInstallTemplates(
      { versionId: vidLocal, srcPath: dirSrc2, versionDir: 'from.arc', archive: { source: 'selfbuild', writtenFlags: ['disable_3d'], mode: 'default-on' } },
      { templatesBase: tplBase, platform: 'win32' }
    )
    const tA = await waitTask(rA.taskId)
    const packDocs = window.ztools.db.allDocs('godot/tplpack/') || []
    ok(tA.status === 'done' && !!tA.packId && packDocs.length === 1 && !tA.archiveError &&
      fs.readFileSync(path.join(path.dirname(tplBase), 'tplpack', tA.packId, 'windows_release_x86_64.exe'), 'utf8') === 'from-dir-2' &&
      fs.readFileSync(path.join(tplBase, 'from.arc', 'windows_release_x86_64.exe'), 'utf8') === 'from-dir-2',
      '★自动存档:独立副本进槽 + 记录 + 任务带 packId(删钩子 → 红:自编译变体被下次覆盖安装带走,找不回)',
      JSON.stringify({ packId: tA.packId, n: packDocs.length }))

    // 存档失败不碰安装:把 tplpack 根换成文件 → cpSync 必败 → 安装仍 done、任务带 archiveError
    const blockRoot = path.join(path.dirname(tplBase), 'tplpack')
    fs.rmSync(blockRoot, { recursive: true, force: true })
    fs.writeFileSync(blockRoot, 'blocker')
    const dirSrc3 = path.join(WORK, 'staged-templates-3')
    fs.mkdirSync(path.join(dirSrc3, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(dirSrc3, 'templates', 'windows_release_x86_64.exe'), 'from-dir-3')
    const rA2 = templates.downloadAndInstallTemplates(
      { versionId: vidLocal, srcPath: dirSrc3, versionDir: 'from.arc2', archive: { source: 'selfbuild' } },
      { templatesBase: tplBase, platform: 'win32' }
    )
    const tA2 = await waitTask(rA2.taskId)
    ok(tA2.status === 'done' && !!tA2.archiveError && !tA2.packId &&
      fs.readFileSync(path.join(tplBase, 'from.arc2', 'windows_release_x86_64.exe'), 'utf8') === 'from-dir-3',
      '★存档失败:安装仍成功、原因挂 archiveError 如实回(把存档失败改成安装失败 → 红:附加语义绑架主语义)',
      JSON.stringify({ archiveError: tA2.archiveError }))
    fs.rmSync(blockRoot, { force: true })
  }

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
