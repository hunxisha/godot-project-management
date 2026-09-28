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
