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

// resolveRel 的断言只比 rel(相对 root、正斜杠),不比绝对路径 —— 绝对路径的分隔符随平台变,
// 而这条闸的全部安全语义(拒越界 / 容错 . 与重复斜杠)都落在 rel 上。
// 期望值统一用 path.join(TREE, …) 生成再剥前缀,同一条断言在 Windows 与 *nix 上都成立。
const BASE = TREE.split(path.sep).join('/')
/** 绝对路径 → 归一化 rel;不在 TREE 之内(或非字符串)一律 null */
function relOf(abs) {
  if (typeof abs !== 'string') return null
  const n = abs.split(path.sep).join('/')
  return n.startsWith(BASE + '/') ? n.slice(BASE.length + 1) : null
}
/** 期望 rel:用平台正确的 path.join 拼出来,再剥掉 TREE 前缀 */
function wantRel(...segs) {
  return relOf(path.join(TREE, ...segs))
}
/**
 * resolveRel 属只读原语,红线是「不抛异常」—— 非法输入必须返回 null。
 * 这里把异常也变成一个可断言的值:守卫被删掉时报一条指名 FAIL,
 * 而不是让整个脚本崩在堆栈上(那样其余断言就白跑了)。
 */
function tryResolve(root, rel) {
  try { return F.resolveRel(root, rel) } catch (e) { return 'threw: ' + e.message }
}

/**
 * resolveInside 与 resolveRel 同属只读闸,红线一样是「不抛异常」。
 * 这里同样把异常摊成一个可指名 FAIL 的值,而不是让脚本崩在堆栈上。
 */
function tryResolveInside(root, rel) {
  try { return F.resolveInside(root, rel) } catch (e) { return { error: 'threw: ' + e.message } }
}

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

  // ---------- 1b. resolveRel 路径闸 ----------
  // scanProjectTree 不调用 resolveRel,所以第 1 节没覆盖到它。这条闸是模块头的红线之一
  // (`..`、绝对路径、盘符都直接拒),后面 Task 3-5 的读 / 写 / 删全靠它兜底 —— 必须直接断言,
  // 否则删掉盘符正则或 `!root` 守卫,CI 还是绿的。
  section('1b. resolveRel 路径闸(直接断言)')
  ok(relOf(F.resolveRel(TREE, 'scene/main.tscn')) === wantRel('scene', 'main.tscn'),
    '多级正常路径原样解析', F.resolveRel(TREE, 'scene/main.tscn'))
  ok(relOf(F.resolveRel(TREE, './a/b.txt')) === wantRel('a', 'b.txt'),
    '开头的 ./ 被吃掉', F.resolveRel(TREE, './a/b.txt'))
  ok(relOf(F.resolveRel(TREE, 'a//b')) === wantRel('a', 'b'),
    '重复斜杠折叠为 a/b', F.resolveRel(TREE, 'a//b'))
  ok(relOf(F.resolveRel(TREE, 'scene\\main.tscn')) === wantRel('scene', 'main.tscn'),
    'Windows 反斜杠形态同样接受', F.resolveRel(TREE, 'scene\\main.tscn'))
  ok(['scene/main.tscn', './a/b.txt', 'a//b', 'scene\\main.tscn']
    .every((p) => typeof F.resolveRel(TREE, p) === 'string' &&
      F.resolveRel(TREE, p).split(path.sep).join('/').startsWith(BASE + '/')),
    '正例返回值一律落在项目根内(不越界)')

  // 逐条单列:哪一条漂了就精确指向哪个守卫(前缀 / .. / 绝对 / 盘符)。
  const ESCAPE = ['../evil', 'a/../../evil', '/etc/passwd', 'C:/Windows/x.exe',
    'c:\\Windows\\x.exe', '', '.', '//']
  for (const bad of ESCAPE) {
    ok(tryResolve(TREE, bad) === null, `拒绝越界/绝对路径 ${JSON.stringify(bad)}`, tryResolve(TREE, bad))
  }

  ok(tryResolve(null, 'a.txt') === null, 'root 为 null → null(不退回相对 cwd)', tryResolve(null, 'a.txt'))
  ok(tryResolve(TREE, 42) === null, '非字符串 rel(number)→ null', tryResolve(TREE, 42))
  ok(tryResolve(TREE, undefined) === null, '非字符串 rel(undefined)→ null', tryResolve(TREE, undefined))

  // ---------- 2. readProjectText ----------
  section('2. readProjectText')
  fs.writeFileSync(path.join(TREE, 'cn.txt'), '中文内容\n', 'utf8')
  const t1 = F.readProjectText('godot/project/p1', 'project.godot')
  ok(t1.ok === true && String(t1.text).includes('[application]'), '读到文本内容', JSON.stringify(t1))
  ok(t1.truncated === false && t1.bytes === fs.statSync(path.join(TREE, 'project.godot')).size,
    'bytes 等于磁盘真实大小(不硬编码字节数)', t1.bytes)
  ok(F.readProjectText('godot/project/p1', 'big.bin').skippedBinary === true, '含 NUL 的字节流 → skippedBinary')
  ok(F.readProjectText('godot/project/p1', 'big.bin').text === undefined, 'skippedBinary 时不返回 text')
  ok(F.readProjectText('godot/project/p1', 'project.godot', { maxBytes: 8 }).truncated === true, '超 maxBytes → truncated')
  ok(F.readProjectText('godot/project/p1', 'project.godot', { maxBytes: 8 }).text === undefined, 'truncated 时不返回 text')
  ok(F.readProjectText('godot/project/p1', 'cn.txt').text === '中文内容\n', 'UTF-8 中文按原文返回')
  ok(F.readProjectText('godot/project/p1', '../outside.txt').error === '非法路径', '上层越界 → 非法路径')
  ok(F.readProjectText('godot/project/p1', 'a/../../b').error === '非法路径', '内嵌 .. 也拒')
  ok(F.readProjectText('godot/project/p1', 'C:\\Windows\\a.txt').error === '非法路径', '绝对路径/盘符 → 非法路径')
  ok(F.readProjectText('godot/project/p1', '/etc/passwd').error === '非法路径', 'POSIX 绝对路径 → 非法路径')
  ok(F.readProjectText('godot/project/p1', '').error === '非法路径', '空 rel → 非法路径')
  ok(F.readProjectText('godot/project/p1', 'nope.tscn').error === '文件不存在', '缺失文件 → 文件不存在')
  ok(F.readProjectText('godot/project/p1', 'scene').error === '文件不存在', '目录不可当文件读')
  ok(F.readProjectText('godot/project/none', 'a.txt').error === '项目不存在', '未知项目 → 项目不存在')

  // ---------- 3. resolveInside:符号链接真实路径包含闸 ----------
  // resolveRel 是纯文本闸:它只看 rel 的字面形态,不看解析后的真实落点。
  // fs.statSync / fs.readFileSync 会跟随符号链接,于是「项目内一条指向
  // C:\Users\me\.ssh\id_rsa 的链接」今天就读得出去 —— 而资产站 zip 解压正是
  // 项目内出现符号链接的主路径。Tasks 4/5(write / trash)复用同一道闸,
  // 所以这里挡住的是「泄漏」,将来挡住的是「删改项目外文件」。
  section('3. resolveInside 符号链接包含闸')
  const OUT = path.join(WORK, 'outside-target')
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'secret.txt'), 'SECRET-OUTSIDE-TREE\n', 'utf8')
  // Windows 上建符号链接需要开发者模式或管理员权限(EPERM)。失败一律降级成**可见**的 SKIP,
  // 绝不静默跳过(静默会让这台机器上的「全绿」等于「没测」)。
  // 目录形态额外退到 NTFS junction:它同样是需要权限为零的 reparse point,
  // fs.statSync / readFileSync 会跟随它,realpathSync 会把它解析到项目外 —— 正好是这条闸要挡的东西。
  function trySymlink(target, linkPath, kind) {
    const kinds = kind === 'dir' ? ['dir', 'junction'] : ['file']
    let last = ''
    for (const k of kinds) {
      try {
        fs.symlinkSync(target, linkPath, k)
        return true
      } catch (e) {
        last = `${k}:${e.code}`
      }
    }
    console.log(`  SKIP  无法创建${kind}符号链接(${JSON.stringify(path.basename(linkPath))}) → ${last}`)
    return false
  }
  const canFileLink = trySymlink(path.join(OUT, 'secret.txt'), path.join(TREE, 'link-out.txt'), 'file')
  const canDirLink = trySymlink(OUT, path.join(TREE, 'linkdir'), 'dir')

  if (canFileLink) {
    const s1 = F.readProjectText('godot/project/p1', 'link-out.txt')
    ok(s1.ok === false && s1.error === '非法路径',
      '项目内文件符号链接指向项目外 → 非法路径(不得读到内容)',
      JSON.stringify({ ...s1, text: s1.text ? '泄漏' : undefined }))
  } else {
    ok(true, '本平台无法创建符号链接,跳过 #1')
  }

  if (canDirLink) {
    const s2 = F.readProjectText('godot/project/p1', 'linkdir/secret.txt')
    ok(s2.ok === false && s2.error === '非法路径',
      '项目内目录符号链接指向项目外,读 linkdir/secret.txt → 非法路径',
      JSON.stringify({ ...s2, text: s2.text ? '泄漏' : undefined }))
  } else {
    ok(true, '本平台无法创建符号链接,跳过 #2')
  }

  // 回归:新闸不得误伤常见路径(普通项目内文件照常读到)
  const s3 = F.readProjectText('godot/project/p1', 'project.godot')
  ok(s3.ok === true && s3.text === '[application]\nname="Demo"\n',
    '项目内普通文件仍能读到原文(新闸不误伤常见路径)', JSON.stringify(s3))

  // 写新文件用的路径此刻还不存在:必须退到最近的已存在祖先做包含校验后照常返回 abs
  const s4 = tryResolveInside(TREE, 'scene/new/holder.tscn')
  ok(typeof s4.abs === 'string' && relOf(s4.abs) === wantRel('scene', 'new', 'holder.tscn'),
    '目标尚不存在时 resolveInside 返回 abs(新建文件不被闸挡掉)', JSON.stringify(s4))
  ok(!s4.error, '目标尚不存在时不报错', s4.error)

  const s5a = tryResolveInside(TREE, '')
  ok(s5a.error === '非法路径', "resolveInside('') → 非法路径", JSON.stringify(s5a))
  const s5b = tryResolveInside(TREE, '../x')
  ok(s5b.error === '非法路径', "resolveInside('../x') → 非法路径", JSON.stringify(s5b))
  const s5c = tryResolveInside(null, 'a.txt')
  ok(s5c.error === '项目不存在', 'resolveInside(null root) → 项目不存在', JSON.stringify(s5c))

  // ---------- 4. bytes 与返回内容同源 ----------
  // 之前 bytes 取 statSync 的 st.size,而 text 取其后的 readFileSync 结果:
  // Godot 编辑器正在写盘时两者会描述不同版本的文件(bytes 对不上返回的 text)。
  section('4. bytes 与返回内容一致')
  const s6 = F.readProjectText('godot/project/p1', 'cn.txt')
  ok(s6.bytes === Buffer.byteLength(String(s6.text), 'utf8'),
    'bytes 等于返回文本的真实 UTF-8 字节数(中文 fixture)', JSON.stringify(s6))

  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
}
main()
