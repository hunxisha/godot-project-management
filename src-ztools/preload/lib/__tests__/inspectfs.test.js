// inspectfs.js 回归测试:项目体检的 4 个文件系统原语。
//
// 为什么单独立一个模块:这是工具页唯一碰宿主文件系统的层,三条安全红线都在这里
// (rel 越界必须拒、超限必须标 truncated、写必须原子) —— 任何一条漂了,
// 体检结论就会误导用户去删错文件。
//
// 已知陷阱(改代码前先读):
//   · fsutil.walkFiles 的 includeCache 语义是「!== false 即包含」,默认**含** .godot。
//     本模块对外的默认必须相反(不含),所以要显式传 `includeCache: o.includeCache === true`。
//   · fsutil.tempPath(dir, id, false) 会给文件加 `.zip` 后缀 —— 写文本文件不能用它。
//   · fsutil.trashPath 在 macOS/Linux 是永久删除(见 :215-219),所以这里的断言只查
//     「文件消失」不查「可还原」;平台差异由渲染层的文案处理。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/inspectfs.test.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const LIB = path.resolve(__dirname, '..')

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }

// 桩掉 window.ztools.db:inspectfs 只读项目文档拿 path
const DB = new Map()
global.window = { ztools: { db: { get: (id) => (DB.get(id) ? { ...DB.get(id) } : null) } } }
const F = require(path.join(LIB, 'inspectfs.js'))

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-inspectfs-'))

/** 按 { 'a/b.txt': '内容' | null(=建目录) } 造一棵树,返回根 */
function makeTree(name, spec) {
  const root = path.join(WORK, name)
  for (const [rel, content] of Object.entries(spec)) {
    const abs = path.join(root, ...rel.split('/'))
    if (content === null) fs.mkdirSync(abs, { recursive: true })
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    }
  }
  return root
}

const TREE = makeTree('proj', {
  'project.godot': '[application]\nname="Demo"\n',
  'scene/main.tscn': '[gd_scene load_steps=2 format=3]\n',
  'scene/.godot/cache.bin': 'xxxx',
  '.godot': null,
  '.godot/imported/icon.png-abc.stex': 'zz',
  'icon.svg': '<svg/>', // 6 字节 —— 下面的 size 断言以此为准
  'big.bin': Buffer.from([0x41, 0x00, 0x42, 0x00]),
  'build/exported.exe': 'MZ',
  'noext': 'x'
})
DB.set('godot/project/p1', { _id: 'godot/project/p1', id: 'p1', path: TREE, name: 'Demo' })

async function main() {
  // ---------- 1. scanProjectTree ----------
  section('1. scanProjectTree')
  const r = F.scanProjectTree('godot/project/p1')
  ok(r.ok === true, 'ok:true', r.error)
  const rels = (r.files || []).map((f) => f.rel).sort()
  ok(!rels.some((x) => x.startsWith('.godot/')), '默认跳过 .godot 缓存目录', rels.join(', '))
  ok(!rels.some((x) => x.includes('.godot/')), '任意层级的 .godot 都默认跳过')
  ok(rels.includes('icon.svg') && rels.includes('scene/main.tscn'), '普通文件与子目录文件都在')
  ok(rels.includes('big.bin'), '二进制文件也进清单(只是不可读文本)')
  ok(rels.includes('noext'), '无扩展名文件也在清单内')
  const e0 = (r.files || []).find((f) => f.rel === 'icon.svg')
  ok(e0.ext === 'svg' && e0.size === 6, 'ext 小写无点、size 正确', JSON.stringify(e0))
  ok(typeof e0.mtimeMs === 'number' && e0.mtimeMs > 0, 'mtimeMs 是正数')
  ok((r.files || []).every((f) => !f.rel.includes('\\')), 'rel 一律正斜杠(Windows 也不能有反斜杠)')
  ok(r.truncated === false, '小树 truncated=false')

  const withCache = F.scanProjectTree('godot/project/p1', { includeCache: true })
  const crels = (withCache.files || []).map((f) => f.rel)
  ok(crels.some((x) => x.startsWith('.godot/')) && crels.some((x) => x.startsWith('scene/.godot/')),
    'includeCache:true 时两级 .godot 都进清单', crels.join(','))

  const only = F.scanProjectTree('godot/project/p1', { exts: ['.svg', 'png'] })
  ok((only.files || []).length === 1 && only.files[0].rel === 'icon.svg',
    'exts 过滤:点号与大小写都容忍', (only.files || []).map((f) => f.rel).join(','))

  const skip = F.scanProjectTree('godot/project/p1', { skipDirs: ['build'] })
  ok(!(skip.files || []).some((f) => f.rel.startsWith('build/')), 'skipDirs 按目录名在任意层级生效')

  const cap = F.scanProjectTree('godot/project/p1', { maxEntries: 3 })
  ok(cap.ok === true && cap.truncated === true && cap.files.length === 3,
    '命中 maxEntries 时 ok 仍 true 且标 truncated', JSON.stringify({ ok: cap.ok, t: cap.truncated, n: cap.files.length }))

  ok(F.scanProjectTree('godot/project/none').ok === false, '未知 projectId → ok:false')
  ok(F.scanProjectTree('godot/project/none').error === '项目不存在', '错误串为「项目不存在」')
  DB.set('godot/project/gone', { _id: 'godot/project/gone', id: 'gone', path: path.join(WORK, 'nope'), name: 'x' })
  ok(F.scanProjectTree('godot/project/gone').error === '项目目录已不存在', '目录被删 → 明确报错')

  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
}
main()
