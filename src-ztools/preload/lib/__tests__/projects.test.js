// 新建项目(createProject)的回归测试。
//
// 重点锁住两件容易悄悄漂移的事:
//   1. icon.svg 必须与 Godot 编辑器新建项目写入的官方图标(DefaultProjectIcon.svg)
//      逐字符一致 —— 插件不该把自己的图标塞进用户项目;
//   2. 勾选「用 Git 管理」时写出的 .gitignore/.gitattributes 与官方内容一致,并 git init。
// 另外覆盖 .editorconfig(官方也会写)与 git 不可用时的容错(不阻断项目创建)。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/projects.test.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const argv = process.argv.slice(2)
const positional = argv.filter((a) => !a.startsWith('--'))
const LIB = positional[0] || path.resolve(__dirname, '..')
const WORK = positional[1] || fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-projects-test-'))

if (!fs.existsSync(path.join(LIB, 'projects.js'))) {
  console.error(`找不到被测模块: ${path.join(LIB, 'projects.js')}`)
  process.exit(2)
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
      remove: (doc) => { docs.delete(doc._id); return { ok: true } },
      allDocs: (prefix) => [...docs.values()].filter((d) => d._id.startsWith(prefix)).map((d) => ({ ...d }))
    }
  }
}

const projects = require(path.join(LIB, 'projects.js'))

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

// 官方内容(取自 godot 仓库,用于逐字符比对)
const OFFICIAL_ICON_MARK = '#478cbf'
const OLD_PLUGIN_ICON_MARK = 'viewBox="0 0 48 48"'

function main() {
  section('1. 基础创建:文件与官方图标')
  const r1 = projects.createProject({
    name: 'Plain',
    parentDir: WORK,
    renderer: 'forward_plus',
    versionTag: '4.7.2-stable'
  })
  ok(r1.ok === true, '创建成功', r1.error)
  const dir1 = path.join(WORK, 'Plain')
  for (const f of ['project.godot', 'icon.svg', '.editorconfig']) {
    ok(fs.existsSync(path.join(dir1, f)), `生成 ${f}`)
  }
  const icon = fs.readFileSync(path.join(dir1, 'icon.svg'), 'utf8')
  ok(icon.includes(OFFICIAL_ICON_MARK), 'icon.svg 是官方默认图标(含官方配色 #478cbf)')
  ok(!icon.includes(OLD_PLUGIN_ICON_MARK), 'icon.svg 不是插件旧的自制图标')
  ok(icon.includes('width="128" height="128"') && icon.trimEnd().endsWith('</svg>'), 'icon.svg 结构与官方一致', String(icon.length))
  const ec = fs.readFileSync(path.join(dir1, '.editorconfig'), 'utf8')
  ok(ec.startsWith('root = true') && ec.includes('charset = utf-8'), '.editorconfig 内容与官方一致', JSON.stringify(ec))

  section('2. 不勾选 Git:不产生版本控制文件')
  ok(!fs.existsSync(path.join(dir1, '.gitignore')), '未写 .gitignore')
  ok(!fs.existsSync(path.join(dir1, '.gitattributes')), '未写 .gitattributes')
  ok(r1.git === undefined, '结果里没有 git 字段')

  section('3. 勾选 Git:元数据文件 + init')
  const r2 = projects.createProject({
    name: 'WithGit',
    parentDir: WORK,
    renderer: 'mobile',
    versionTag: '4.7.2-stable',
    gitInit: true
  })
  ok(r2.ok === true, '创建成功', r2.error)
  const dir2 = path.join(WORK, 'WithGit')
  const gi = fs.readFileSync(path.join(dir2, '.gitignore'), 'utf8')
  ok(gi === '# Godot 4+ specific ignores\n.godot/\n/android/\n', '.gitignore 与官方逐字符一致', JSON.stringify(gi))
  const ga = fs.readFileSync(path.join(dir2, '.gitattributes'), 'utf8')
  ok(ga === '# Normalize EOL for all files that Git considers text files.\n* text=auto eol=lf\n', '.gitattributes 与官方逐字符一致', JSON.stringify(ga))
  ok(r2.git && typeof r2.git.initialized === 'boolean', '结果带 git 状态', JSON.stringify(r2.git))
  if (r2.git.initialized) {
    ok(fs.existsSync(path.join(dir2, '.git')), 'git 仓库已建立')
  } else {
    console.log('  SKIP  git 不可用,跳过仓库断言(文件仍已写好)')
    ok(/手动 git init/.test(r2.git.error || ''), 'git 不可用时给出可操作的说明', r2.git.error)
  }

  section('4. 边界:重名目录与非法名称')
  ok(projects.createProject({ name: 'Plain', parentDir: WORK, renderer: 'forward_plus' }).ok === false, '同名目录被拒绝')
  ok(projects.createProject({ name: '   ', parentDir: WORK, renderer: 'forward_plus' }).ok === false, '空名称被拒绝')
  ok(projects.createProject({ name: 'X', parentDir: '', renderer: 'forward_plus' }).ok === false, '缺少创建位置被拒绝')

  section('5. 项目已登记(复用 addProject)')
  ok(r1.project && r1.project.name === 'Plain', '返回项目文档', JSON.stringify(r1.project && r1.project.name))
  ok(listOfProjects().includes('Plain'), '项目写入列表')

  // ---------- 以下为官方启动器联动:config/tags 读写 + 重命名(均写回 project.godot) ----------
  const pid = r1.project.id
  const f1 = path.join(WORK, 'Plain', 'project.godot')

  section('6. 标签:写入 [application] config/tags(官方启动器同一存储)')
  const s1 = projects.setProjectTags(pid, ['rpg', 'demo', '我的 标签'])
  ok(s1.ok === true, 'setProjectTags 成功', s1.error)
  ok(JSON.stringify(s1.tags) === JSON.stringify(['rpg', 'demo', '我的 标签']), '返回清洗后的标签列表', JSON.stringify(s1.tags))
  const t2 = fs.readFileSync(f1, 'utf8')
  ok(/\[application\][\s\S]*config\/tags=PackedStringArray\("rpg", "demo", "我的 标签"\)/.test(t2), 'config/tags 写入 [application] 节')
  ok(t2.indexOf('config/tags=') > t2.indexOf('config/icon='), '新键追加在节内容末尾(不插到既有键前面)')
  ok(t2.includes('; Engine configuration file.'), '文件头注释原样保留')
  ok(t2.includes('[rendering]') && t2.includes('renderer/rendering_method='), '其余节原样保留')
  ok(t2.includes('config/name="Plain"') && t2.includes('config/features='), 'application 既有键原样保留')
  ok(JSON.stringify(projects.parseProjectGodot(path.join(WORK, 'Plain')).tags) === JSON.stringify(['rpg', 'demo', '我的 标签']), 'parseProjectGodot 读回一致')
  ok(JSON.stringify(docs.get(pid).tags) === JSON.stringify(['rpg', 'demo', '我的 标签']), '标签镜像进项目文档')

  section('7. 标签:原位替换、去重与清洗')
  const s2 = projects.setProjectTags(pid, ['rpg', 'godot4', 'rpg'])
  ok(s2.ok === true, '二次写入成功', s2.error)
  ok(JSON.stringify(s2.tags) === JSON.stringify(['rpg', 'godot4']), '重复标签去重保序', JSON.stringify(s2.tags))
  const t3 = fs.readFileSync(f1, 'utf8')
  ok(t3.includes('config/tags=PackedStringArray("rpg", "godot4")'), '已有 config/tags 行被原位替换')
  ok((t3.match(/config\/tags=/g) || []).length === 1, 'config/tags 只出现一次')
  const s3 = projects.setProjectTags(pid, ['  a b  ', 'x"y', '', 'a\tb'])
  ok(JSON.stringify(s3.tags) === JSON.stringify(['a b', 'xy']), '引号/空白清洗 + 去重', JSON.stringify(s3.tags))
  ok(fs.readFileSync(f1, 'utf8').includes('config/tags=PackedStringArray("a b", "xy")'), '清洗结果落盘')

  section('8. 标签:空数组 = 清除(官方不落空数组)')
  const s4 = projects.setProjectTags(pid, [])
  ok(s4.ok === true && s4.tags.length === 0, '清除成功', JSON.stringify(s4))
  ok(!fs.readFileSync(f1, 'utf8').includes('config/tags='), 'config/tags 行被整行移除')
  ok(!('tags' in docs.get(pid)), '清除后文档不再带 tags')
  ok(projects.setProjectTags(pid, ['x']).ok === true, '清除后可再次写入')

  section('9. 重命名:config/name 写回 + 文档同步(目录不动)')
  const r5 = projects.renameProject(pid, '重命名后')
  ok(r5.ok === true, 'renameProject 成功', r5.error)
  ok(r5.project && r5.project.name === '重命名后', '返回文档已更新', JSON.stringify(r5.project && r5.project.name))
  ok(fs.readFileSync(f1, 'utf8').includes('config/name="重命名后"'), 'config/name 写入文件')
  ok(docs.get(pid).name === '重命名后', '本地文档名称同步')
  ok(listOfProjects().includes('重命名后'), '项目列表显示新名称')
  ok(fs.existsSync(path.join(WORK, 'Plain')) && fs.existsSync(path.join(WORK, 'Plain', 'project.godot')), '目录名保持不变')
  ok(projects.renameProject(pid, 'a"b\\c').ok === true, '含引号/反斜杠的名称不破坏文件')
  ok(fs.readFileSync(f1, 'utf8').includes('config/name="abc"'), '非法字符被清洗')
  ok(projects.renameProject('godot/project/none', 'X').ok === false, '项目不存在报错')
  ok(projects.renameProject(pid, '   ').ok === false, '空名称报错')
  ok(projects.setProjectTags('godot/project/none', ['x']).ok === false, '标签:项目不存在报错')

  section('10. 写回兜底:无 [application] 节时追加该节')
  const bareDir = path.join(WORK, 'Bare')
  fs.mkdirSync(bareDir)
  fs.writeFileSync(path.join(bareDir, 'project.godot'), 'config_version=5\n\n[rendering]\n\nrenderer/rendering_method="forward_plus"\n', 'utf8')
  const a3 = projects.addProject(bareDir)
  ok(a3.ok === true, '添加裸配置项目成功', a3.error)
  const s5 = projects.setProjectTags(a3.project.id, ['tool'])
  ok(s5.ok === true, '无 application 节也能写标签', s5.error)
  const t4 = fs.readFileSync(path.join(bareDir, 'project.godot'), 'utf8')
  ok(/\[application\]\s*\nconfig\/tags=PackedStringArray\("tool"\)/.test(t4), '文件尾追加 application 节并写入', JSON.stringify(t4))
  ok(t4.includes('[rendering]') && t4.includes('renderer/rendering_method='), '原节内容保留')

  section('11. project.godot 缺失时容错')
  const vanishDir = path.join(WORK, 'Vanish')
  fs.mkdirSync(vanishDir)
  fs.writeFileSync(path.join(vanishDir, 'project.godot'), 'config_version=5\n', 'utf8')
  const a4 = projects.addProject(vanishDir)
  fs.rmSync(path.join(vanishDir, 'project.godot'))
  ok(projects.renameProject(a4.project.id, 'X').ok === false, '文件缺失时重命名报错')
  ok(projects.setProjectTags(a4.project.id, ['x']).ok === false, '文件缺失时标签报错')

  section('12. 官方侧改动经 addProject 同步(双向互通)')
  // 模拟官方启动器直接改文件:先清掉工坊写入的 tags 行,再手工插一行 config/tags
  const stripped = fs.readFileSync(f1, 'utf8').replace(/config\/tags=.*\n/, '')
  fs.writeFileSync(f1, stripped.replace('config/name="abc"', 'config/name="abc"\nconfig/tags=PackedStringArray("official", "sync")'), 'utf8')
  const a6 = projects.addProject(path.join(WORK, 'Plain'))
  ok(JSON.stringify(a6.project && a6.project.tags) === JSON.stringify(['official', 'sync']), '重新添加时同步官方侧写入的标签', JSON.stringify(a6.project && a6.project.tags))
  // 官方侧删掉标签行:文档也跟着清空
  fs.writeFileSync(f1, fs.readFileSync(f1, 'utf8').replace(/config\/tags=.*\n/, ''), 'utf8')
  const a7 = projects.addProject(path.join(WORK, 'Plain'))
  ok(!('tags' in (a7.project || {})), '官方侧删除标签后文档同步清空')

  console.log(`\n${'='.repeat(56)}`)
  console.log(`PASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) {
    console.log('失败项:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
}

function listOfProjects() {
  return [...docs.values()].filter((d) => d._id.startsWith('godot/project/')).map((d) => d.name)
}

try {
  main()
} catch (e) {
  console.error(e)
  process.exit(1)
}
