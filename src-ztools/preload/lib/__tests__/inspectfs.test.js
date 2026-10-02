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
/** 因平台限制(创建符号链接需权限)没能真正执行的断言数 */
let skips = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
/**
 * 记一条「本机跑不了」的断言:输出**可见** SKIP,但**不计入 PASS**。
 * 之前这里用 ok(true, …) 占位,全绿其实等于「没测」—— 头条 PASS 数因此虚高。
 * (名字不叫 skip:main() 里已有 `const skip = scanProjectTree(…)` 会把它盖掉。)
 * @param {string} label
 * @param {string} [reason]
 */
function skipAssert(label, reason) {
  skips++
  console.log(`  SKIP  ${label}${reason ? ' → ' + reason : ''}`)
}
function section(t) { console.log(`\n=== ${t} ===`) }

// 桩掉 window.ztools.db:inspectfs 只读项目文档拿 path
const DB = new Map()
global.window = { ztools: { db: { get: (id) => (DB.get(id) ? { ...DB.get(id) } : null) } } }
const F = require(path.join(LIB, 'inspectfs.js'))
// 备份名里的时间戳由 fsutil.stampSec() 产生。测试要**预测**「下一个备份名」(同秒碰撞、
// 半截备份清理两类断言都靠它),所以直接复用同一个函数,而不是自己拼一份时间格式。
const U = require(path.join(LIB, 'fsutil.js'))

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
  // 绝不静默跳过(静默会让这台机器上的「全绿」等于「没测」),也不记成 PASS(见 skipAssert())。
  // 目录形态额外退到 NTFS junction:它同样是需要权限为零的 reparse point,
  // fs.statSync / readFileSync 会跟随它,realpathSync 会把它解析到项目外 —— 正好是这条闸要挡的东西。
  /**
   * @param {string} target
   * @param {string} linkPath
   * @param {'file'|'dir'} kind
   * @returns {{ok:boolean, reason:string}}
   */
  function trySymlink(target, linkPath, kind) {
    const kinds = kind === 'dir' ? ['dir', 'junction'] : ['file']
    let last = ''
    for (const k of kinds) {
      try {
        fs.symlinkSync(target, linkPath, k)
        return { ok: true, reason: '' }
      } catch (e) {
        last = `${k}:${e.code}`
      }
    }
    return { ok: false, reason: `无法创建${kind}符号链接(${JSON.stringify(path.basename(linkPath))}) → ${last}` }
  }
  const canFileLink = trySymlink(path.join(OUT, 'secret.txt'), path.join(TREE, 'link-out.txt'), 'file')
  const canDirLink = trySymlink(OUT, path.join(TREE, 'linkdir'), 'dir')

  if (canFileLink.ok) {
    const s1 = F.readProjectText('godot/project/p1', 'link-out.txt')
    ok(s1.ok === false && s1.error === '非法路径',
      '项目内文件符号链接指向项目外 → 非法路径(不得读到内容)',
      JSON.stringify({ ...s1, text: s1.text ? '泄漏' : undefined }))
  } else {
    skipAssert('读取穿过项目内文件符号链接的断言本机未执行', canFileLink.reason)
  }

  if (canDirLink.ok) {
    const s2 = F.readProjectText('godot/project/p1', 'linkdir/secret.txt')
    ok(s2.ok === false && s2.error === '非法路径',
      '项目内目录符号链接指向项目外,读 linkdir/secret.txt → 非法路径',
      JSON.stringify({ ...s2, text: s2.text ? '泄漏' : undefined }))
  } else {
    skipAssert('读取穿过项目内目录符号链接的断言本机未执行', canDirLink.reason)
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

  // ---------- 5. writeProjectText ----------
  // 三条红线:① 原子落盘(同目录临时文件 + rename,失败必须清掉 .gpm-tmp- 残骸);
  // ② 默认先备份(改坏了还能还原,备份名带秒级时间戳);③ 不自动建目录
  // (拼错的路径若被 mkdir -p,项目里就静默长出 nosub/x.txt 这种垃圾树)。
  // 编号说明:计划里这节写的是「3.」,但 Task 3 已占用 3/4 两节,这里顺延为 5。
  section('5. writeProjectText')
  fs.writeFileSync(path.join(TREE, 'cfg.txt'), 'OLD\n', 'utf8')
  const w1 = F.writeProjectText('godot/project/p1', 'cfg.txt', 'NEW\n')
  ok(w1.ok === true, '写入成功', JSON.stringify(w1))
  ok(fs.readFileSync(path.join(TREE, 'cfg.txt'), 'utf8') === 'NEW\n', '内容已替换')
  // 备份名以 marker **收尾**:`cfg.txt.gpm-bak-<时间戳>`,而不是把原扩展名留在最后。
  // `<base>.gpm-bak-<ts>.txt` 那种形态仍以 .txt 结尾 —— Godot 会当真导入它,
  // scanProjectTree 会把它数成一份真实资源,导出预设 `filter include *` 甚至能把它打进发布包。
  ok(/^cfg\.txt\.gpm-bak-\d{8}_\d{4}_\d{2}$/.test(String(w1.backupRel)),
    'backupRel 形如 cfg.txt.gpm-bak-YYYYMMDD_HHmm_ss(marker 收尾,不保留原扩展名)', w1.backupRel)
  ok(fs.readFileSync(path.join(TREE, w1.backupRel), 'utf8') === 'OLD\n', '备份文件里是原内容')
  ok(F.writeProjectText('godot/project/p1', 'sub/deep/new.txt', 'A').error === '目标目录不存在',
    '不自动建目录(避免 typo 路径变成新文件)')
  ok(F.writeProjectText('godot/project/p1', 'cfg.txt', 'X', { backup: false }).ok === true, 'backup:false 时仍可写')
  ok(fs.readdirSync(TREE).filter((n) => /^cfg\.txt\.gpm-bak-/.test(n)).length === 1,
    'backup:false 这次不再产生新备份', String(fs.readdirSync(TREE).filter((n) => n.startsWith('cfg.txt.gpm-bak'))))
  ok(F.writeProjectText('godot/project/p1', '../evil.txt', 'X').error === '非法路径', '越界写 → 非法路径')
  ok(F.writeProjectText('godot/project/p1', 'scene', 'X').error === '不能覆盖目录', '目标是目录 → 拒绝')
  ok(F.writeProjectText('godot/project/none', 'a.txt', 'X').error === '项目不存在', '未知项目 → 项目不存在')
  const c1 = F.writeProjectText('godot/project/p1', 'scene/new.txt', 'A')
  ok(c1.ok === true && c1.backupRel === undefined, '原文件不存在时不产生备份', JSON.stringify(c1))
  ok(fs.readFileSync(path.join(TREE, 'scene/new.txt'), 'utf8') === 'A', '新文件内容正确')
  ok(F.writeProjectText('godot/project/p1', 'nosub/x.txt', 'A').error === '目标目录不存在', '缺目录一律拒绝,不递归创建')
  ok(!fs.existsSync(path.join(TREE, 'nosub')), '被拒绝的写入不留任何痕迹')
  ok(fs.readdirSync(TREE).filter((n) => n.startsWith('.gpm-tmp-')).length === 0, '不留 .gpm-tmp-* 残骸')

  // text 非字符串:锁住 '内容不是文本' 这条串(Rust 侧 Task 7 逐字镜像),并确认拒绝后原文未被碰。
  const wBad = F.writeProjectText('godot/project/p1', 'cfg.txt', 42)
  ok(wBad.error === '内容不是文本', '非字符串内容 → 内容不是文本', JSON.stringify(wBad))
  ok(fs.readFileSync(path.join(TREE, 'cfg.txt'), 'utf8') === 'X', '被拒绝的写入不改磁盘内容')
  // backupRel 必须保留 rel 的目录前缀(项目相对路径,调用方要能直接 readProjectText 回来核对)。
  const c2 = F.writeProjectText('godot/project/p1', 'scene/new.txt', 'B')
  ok(/^scene\/new\.txt\.gpm-bak-\d{8}_\d{4}_\d{2}$/.test(String(c2.backupRel)),
    '多级 rel 的 backupRel 带 scene/ 前缀且 marker 收尾(仍是项目相对路径)', JSON.stringify(c2))
  ok(fs.readFileSync(path.join(TREE, c2.backupRel), 'utf8') === 'A', '多级备份里是上一次的原文')
  ok(fs.readFileSync(path.join(TREE, 'scene/new.txt'), 'utf8') === 'B', '覆盖写第二次的落点正确')
  ok(fs.readdirSync(path.join(TREE, 'scene')).filter((n) => n.startsWith('.gpm-tmp-')).length === 0,
    '子目录写入同样不留 .gpm-tmp-* 残骸')

  // ---------- R-1:备份不保留原扩展名(.gd 专项)----------
  // 这是计划级修正:旧命名让 player.gd 的备份仍以 .gd 结尾,于是
  // ① Godot 把备份当真当一个脚本导入(多出幻影资源、还占 .gd 这个名字),
  // ② scanProjectTree 的 ext 分组把它数进 gd 资源数,体检结论虚高,
  // ③ 导出预设 `filter include *` 可能把它一起打进发布包。marker 收尾后三者都消失。
  fs.writeFileSync(path.join(TREE, 'player.gd'), 'extends Node\n', 'utf8')
  const wGd = F.writeProjectText('godot/project/p1', 'player.gd', 'extends Node2D\n')
  ok(wGd.ok === true && /^player\.gd\.gpm-bak-\d{8}_\d{4}_\d{2}$/.test(String(wGd.backupRel)),
    '.gd 的备份名为 player.gd.gpm-bak-<时间戳>', JSON.stringify(wGd))
  ok(path.extname(String(wGd.backupRel)) !== '.gd',
    '备份的 extname 不再是 .gd(引擎与导出预设都看不见它)', path.extname(String(wGd.backupRel)))
  const scanGd = F.scanProjectTree('godot/project/p1', { exts: ['gd'] })
  ok((scanGd.files || []).some((f) => f.rel === 'player.gd') &&
    (scanGd.files || []).every((f) => f.rel !== wGd.backupRel),
    'scanProjectTree(exts:gd) 只数到原脚本,备份不计入 gd 资源',
    JSON.stringify((scanGd.files || []).map((f) => f.rel)))
  ok(fs.readFileSync(path.join(TREE, wGd.backupRel), 'utf8') === 'extends Node\n',
    'marker 收尾后备份内容仍是原文件原文')

  // ---------- R-7:backupRel 的前缀取自**解析结果**,不照抄调用方的 rel ----------
  // rel 允许 './a/b.txt'、'a//b.txt'(resolveRel 已归一)。照原文切前缀会返回 './a/…',
  // 既破坏本模块「对外只有 rel 一个键、rel 一律规范正斜杠」的契约,也让渲染层
  // tree.find(f => f.rel === backupRel) 永远找不到刚建好的那份备份。
  fs.writeFileSync(path.join(TREE, 'dot.txt'), 'D1\n', 'utf8')
  const wDot = F.writeProjectText('godot/project/p1', './dot.txt', 'D2\n')
  ok(wDot.ok === true && /^dot\.txt\.gpm-bak-\d{8}_\d{4}_\d{2}$/.test(String(wDot.backupRel)),
    "rel 写成 './dot.txt' → backupRel 不带 ./ 前缀", wDot.backupRel)
  const scanDot = F.scanProjectTree('godot/project/p1')
  ok((scanDot.files || []).some((f) => f.rel === wDot.backupRel),
    'backupRel 与 scanProjectTree 的 rel 同形(渲染层按 rel 找得到这份备份)', JSON.stringify(wDot))
  fs.writeFileSync(path.join(TREE, 'scene/deep2.txt'), 'E1\n', 'utf8')
  const wSlash = F.writeProjectText('godot/project/p1', './scene//deep2.txt', 'E2\n')
  ok(wSlash.ok === true && /^scene\/deep2\.txt\.gpm-bak-\d{8}_\d{4}_\d{2}$/.test(String(wSlash.backupRel)),
    "rel 写成 './scene//deep2.txt' → 前缀归一为 scene/", wSlash.backupRel)

  // ---------- R-2:同一秒内的第二次备份不覆盖第一份 ----------
  // stampSec 只到秒,同秒改两次必然撞同一个名字。直接 copy 到同名就是把第一份备份
  // (用户上一次的退路)悄悄销毁 —— 比不备份更危险:用户还以为能还原到上一版。
  fs.writeFileSync(path.join(TREE, 'dup.txt'), 'V1\n', 'utf8')
  const d1 = F.writeProjectText('godot/project/p1', 'dup.txt', 'V2\n')
  const d2 = F.writeProjectText('godot/project/p1', 'dup.txt', 'V3\n')
  ok(/^dup\.txt\.gpm-bak-\d{8}_\d{4}_\d{2}$/.test(String(d1.backupRel)),
    '没有碰撞时备份名保持规范形状(uniquePath 不改正常名)', d1.backupRel)
  ok(String(d2.backupRel) !== String(d1.backupRel),
    '同秒两次写入 → 第二次另起名字,不覆写第一次的备份', JSON.stringify({ a: d1.backupRel, b: d2.backupRel }))
  // uniquePath 是按**最后一个点**切扩展名的,换名后缀落在 `dup.txt` 与 marker 之间
  // (`dup.txt_2.gpm-bak-<ts>`),不是接在名字末尾 —— 用 startsWith('dup.txt.gpm-bak-') 会漏掉它,
  // 于是「只剩一份」的假象会盖住真正的覆写。marker 收尾也让这份备份的 extname 仍是 .gpm-bak-…,
  // 换名后依旧不被 Godot / exts 过滤看见。
  const dupBaks = fs.readdirSync(TREE).filter((n) => /^dup\.txt(_\d+)?\.gpm-bak-\d{8}_\d{4}_\d{2}$/.test(n))
  ok(dupBaks.length === 2, '目录里两份备份都在(不是覆写成一)', dupBaks.join(','))
  ok(fs.readFileSync(path.join(TREE, d1.backupRel), 'utf8') === 'V1\n' &&
    fs.readFileSync(path.join(TREE, d2.backupRel), 'utf8') === 'V2\n',
    '两份备份各自存着当时那一版原文(V1 / V2)', JSON.stringify({ a: d1.backupRel, b: d2.backupRel }))
  ok(fs.readFileSync(path.join(TREE, 'dup.txt'), 'utf8') === 'V3\n', '两次写入都正确落到了目标')

  // 原子性的**过程**断言:上面所有断言只看结果文件,一个 `fs.writeFileSync(abs)` 的直写实现
  // 也能全绿 —— 但直写会在写到一半时崩掉(断电/空间不足)把原文件留在半截状态,
  // 而「同目录临时文件 + rename」在 POSIX/Windows 上都是原子替换。
  // 所以这里钩住 fs 看它**怎么写**:先写 .gpm-tmp-* ,再 rename 到目标。
  const calls = []
  const realWrite = fs.writeFileSync
  const realRename = fs.renameSync
  fs.writeFileSync = (...a) => { calls.push(['write', a[0], a[2]]); return realWrite(...a) }
  fs.renameSync = (...a) => { calls.push(['rename', a[0], a[1]]); return realRename(...a) }
  let probe
  try {
    probe = F.writeProjectText('godot/project/p1', 'cfg.txt', 'ATOMIC\n')
  } finally {
    fs.writeFileSync = realWrite
    fs.renameSync = realRename
  }
  const wTmp = calls.find((c) => c[0] === 'write')
  const wRen = calls.find((c) => c[0] === 'rename')
  const cfgAbs = path.join(TREE, 'cfg.txt')
  ok(probe.ok === true && !!wTmp && path.basename(String(wTmp[1])).startsWith('.gpm-tmp-'),
    '内容先落进 .gpm-tmp-* 临时文件(不是直写目标)', wTmp && wTmp[1])
  ok(!!wTmp && path.dirname(String(wTmp[1])) === path.dirname(cfgAbs),
    '临时文件与目标**同目录**(rename 才不跨盘、才谈得上原子)', wTmp && wTmp[1])
  ok(!!wRen && wRen[1] === wTmp[1] && wRen[2] === cfgAbs,
    '由 rename 把临时文件替换到目标', JSON.stringify(wRen))
  ok(calls.every((c) => !(c[0] === 'write' && c[1] === cfgAbs)),
    '全程没有一次 writeFileSync 直接打到目标路径')

  // ---------- R-8:钉住「绝不用 fsutil.tempPath」这条红线 ----------
  // fsutil.tempPath(dir, id, false) 给文件加的是 `.zip` 后缀。上面四条过程断言只看
  // 「basename 以 .gpm-tmp- 开头 / 同目录 / rename 的两侧」——换成 tempPath 生成的
  // `cfg.txt.zip` 之类名字,那四条照样全绿,而 rename 之后目标内容会被 .zip 名字带歪。
  // 所以额外钉死:临时名以**目标真实扩展名**结尾,且绝不以 .zip 结尾。
  ok(!!wTmp && String(wTmp[1]).endsWith(path.extname(cfgAbs)),
    '临时文件用目标真实扩展名结尾', wTmp && wTmp[1])
  ok(!!wTmp && !String(wTmp[1]).endsWith('.zip'),
    '临时名不是 fsutil.tempPath 的 .zip 形态(红线:这里不能用它)', wTmp && wTmp[1])
  // ---------- R-9(结构侧):临时写入必须独占创建 ----------
  const tmpOpts = wTmp && wTmp[2]
  ok(!!tmpOpts && String(tmpOpts.flag) === 'wx',
    "临时文件用 flag:'wx' 写(名字可预测,同名已存在时必须失败而不是跟随/复用)", JSON.stringify(tmpOpts))

  // 失败路径:让 rename 抛一次。原语红线是「不抛异常」,且失败必须 ① 报 '写入失败'
  // ② 原文件保持旧内容 ③ rmQuiet 清掉临时文件(否则用户项目里满是 .gpm-tmp-*)。
  const beforeFail = fs.readFileSync(cfgAbs, 'utf8')
  fs.renameSync = () => { throw Object.assign(new Error('simulated EXDEV'), { code: 'EXDEV' }) }
  let wFail
  try {
    wFail = F.writeProjectText('godot/project/p1', 'cfg.txt', 'SHOULD-NOT-LAND')
  } finally {
    fs.renameSync = realRename
  }
  ok(wFail.ok === false && wFail.error === '写入失败', 'rename 失败 → 写入失败(只返回 error,不抛)', JSON.stringify(wFail))
  ok(fs.readFileSync(cfgAbs, 'utf8') === beforeFail, '失败的写入没碰原文件(原子替换的意义)')
  ok(fs.readdirSync(TREE).filter((n) => n.startsWith('.gpm-tmp-')).length === 0,
    '失败的写入由 rmQuiet 清掉临时文件', String(fs.readdirSync(TREE).filter((n) => n.startsWith('.gpm-tmp-'))))

  // ---------- R-9:临时名可预测 → 必须独占创建(flag wx)----------
  // 临时名是 `.gpm-tmp-<Date.now()>-<base><ext>`,项目里任何人都能预置同名文件
  // (最坏情形:一条指向 ~/.ssh/id_rsa 的同名符号链接)。包含闸只审过最终 abs,**没审 tmp**;
  // 普通写入会跟随它,于是这次改的其实是别人的文件。wx 让「同名已存在」直接失败 ——
  // 宁可这条 rel 写不成,也不写到别人名下。
  const wxBefore = fs.readFileSync(cfgAbs, 'utf8')
  let wxPlanted = false
  fs.writeFileSync = (p, ...rest) => {
    const b = path.basename(String(p))
    // 第一次打到 .gpm-tmp-* 的写入:抢在它前面把那个名字占掉,再让真实写入去撞它。
    if (!wxPlanted && b.startsWith('.gpm-tmp-')) { wxPlanted = true; realWrite(String(p), 'PRE-PLANTED-BY-OTHER\n') }
    return realWrite(p, ...rest)
  }
  let wWx
  try {
    wWx = F.writeProjectText('godot/project/p1', 'cfg.txt', 'WX-MUST-NOT-LAND')
  } finally {
    fs.writeFileSync = realWrite
  }
  ok(wxPlanted === true, '探针确实抢占了本次的临时文件名(断言不是空跑)', String(wxPlanted))
  ok(wWx.ok === false && wWx.error === '写入失败', '临时名被预占 → 写入失败(不静默复用同名路径)', JSON.stringify(wWx))
  ok(fs.readFileSync(cfgAbs, 'utf8') === wxBefore, '被 wx 挡掉的写没碰原文件')
  const wxTmp = fs.readdirSync(TREE).filter((n) => n.startsWith('.gpm-tmp-'))
  ok(wxTmp.length === 0, 'wx 失败后同样由 rmQuiet 收掉残骸', wxTmp.join(','))

  // ---------- R-4:备份失败的两条清理语义(确定性复现,不看秒)----------
  // 备份是这次修改唯一的退路:① 失败必须停在覆写之前;② 失败清理只能删**自己刚写的那个**。
  // 旧写法把 copyFileSync mock 成「立刻抛」——它从没产出过半截文件,清理分支根本没事做;
  // 而「上一份同名备份是否被误删」只在前后几节恰好同秒时才撞上,是时间相关性巧合、不是回归保护。
  // 这里:先把**当前秒算得出的那个备份名**占成哨兵(内容=可核对的哨兵字节),
  //       再让 copy 真的写出半截 HALF 才失败 —— 两条语义各自都有确定的失败形态。
  // 用独立文件 bf.txt:它的备份历史完全由本节制造,不与上面各节的计数互相干扰。
  fs.writeFileSync(path.join(TREE, 'bf.txt'), 'BF-ORIG\n', 'utf8')
  const bfAbs = path.join(TREE, 'bf.txt')
  const bakNames = () => fs.readdirSync(TREE).filter((n) => /^bf\.txt(_\d+)?\.gpm-bak-\d{8}_\d{4}_\d{2}$/.test(n)).sort()
  const predicted = `bf.txt.gpm-bak-${U.stampSec()}`
  const sentinelAbs = path.join(TREE, predicted)
  const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8') } catch (e) { return '<文件不存在>' } }
  const realCopy = fs.copyFileSync
  // 真 copyFileSync 失败前往往已经写了一半,所以 mock 也先落半截:清理分支必须有活干。
  const halfThenThrow = (src, dest, ...rest) => {
    realWrite(String(dest), 'HALF')
    throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' })
  }

  // ① 备份名已被「上一份真备份」占着:新的半截备份必须写到别处,哨兵一个字节都不能动。
  fs.writeFileSync(sentinelAbs, 'SENTINEL-PREV-BACKUP\n', 'utf8')
  fs.copyFileSync = halfThenThrow
  let wBakFailA
  try {
    wBakFailA = F.writeProjectText('godot/project/p1', 'bf.txt', 'MUST-NOT-LAND')
  } finally {
    fs.copyFileSync = realCopy
  }
  const sentinelAfterA = readSafe(sentinelAbs)
  ok(wBakFailA.ok === false && wBakFailA.error === '备份失败', '备份失败 → 备份失败(不继续覆写)', JSON.stringify(wBakFailA))
  ok(fs.existsSync(sentinelAbs) && sentinelAfterA === 'SENTINEL-PREV-BACKUP\n',
    '上一份同名备份既没被覆写也没被清理误删(哨兵字节完好)', sentinelAfterA)
  ok(readSafe(bfAbs) === 'BF-ORIG\n', '备份失败时原文件原封不动')
  ok(bakNames().length === 1 && bakNames()[0] === predicted,
    '半截备份(HALF)被清掉,目录里只剩哨兵那一份', bakNames().join(','))
  ok(fs.readdirSync(TREE).filter((n) => n.startsWith('.gpm-tmp-')).length === 0,
    '备份失败同样不留 .gpm-tmp-* 残骸')

  // ② 备份名空着:半截备份必须当场清干净(半份备份比没有备份更危险 —— 用户会拿它还原)。
  fs.rmSync(sentinelAbs)
  fs.copyFileSync = halfThenThrow
  let wBakFailB
  try {
    wBakFailB = F.writeProjectText('godot/project/p1', 'bf.txt', 'MUST-NOT-LAND')
  } finally {
    fs.copyFileSync = realCopy
  }
  const namesAfterB = bakNames()
  ok(wBakFailB.ok === false && wBakFailB.error === '备份失败', '备份名空着时同样报备份失败', JSON.stringify(wBakFailB))
  ok(namesAfterB.length === 0, '自己刚写的半截备份没留在盘上', namesAfterB.join(','))
  ok(readSafe(bfAbs) === 'BF-ORIG\n', '② 里原文件同样没被碰')

  // ---------- R-3:stat 问不到 / 目标不是普通文件 → 拒写,绝不「当作不存在」裸写 ----------
  // 原实现 `catch (e) { /* 原文件不存在 */ }` 把 EACCES / ELOOP / EIO 也当成「没有原文件」:
  // 不备份 → 直接 rename 覆写 → 用户唯一的退路当场没了(比不写更糟)。
  // 只有 ENOENT(真的不存在)才走「新建文件、无需备份」分支。
  const cfgBeforeR3 = fs.readFileSync(cfgAbs, 'utf8')
  const cfgBakCount = () => fs.readdirSync(TREE).filter((n) => /^cfg\.txt(_\d+)?\.gpm-bak-\d{8}_\d{4}_\d{2}$/.test(n)).length
  const r3BakBefore = cfgBakCount()
  const realStat = fs.statSync
  fs.statSync = (p, ...rest) => {
    if (String(p) === cfgAbs) throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' })
    return realStat(p, ...rest)
  }
  let wStatFail
  try {
    wStatFail = F.writeProjectText('godot/project/p1', 'cfg.txt', 'BLIND-WRITE')
  } finally {
    fs.statSync = realStat
  }
  ok(wStatFail.ok === false && wStatFail.error === '写入失败',
    'statSync 非 ENOENT 失败 → 写入失败(不得当作「原文件不存在」裸写)', JSON.stringify(wStatFail))
  ok(fs.readFileSync(cfgAbs, 'utf8') === cfgBeforeR3, 'stat 失败时原文件完好')
  ok(cfgBakCount() === r3BakBefore, 'stat 失败时没产生备份,也没留下临时残骸')

  // 目标是非普通文件(FIFO / socket / 设备):statSync 成功、既不是目录也不是普通文件。
  // 把它当「可备份的普通文件」→ copyFileSync 读一个没人写的 FIFO 会把 preload 线程挂死
  // (整个插件界面冻结);当「不存在」→ rename 覆到一个特殊文件上。两边都只能拒。
  const fakeStat = { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false, size: 0, mtimeMs: 0 }
  fs.statSync = (p, ...rest) => (String(p) === cfgAbs ? fakeStat : realStat(p, ...rest))
  let wNotFile
  try {
    wNotFile = F.writeProjectText('godot/project/p1', 'cfg.txt', 'FIFO-WRITE')
  } finally {
    fs.statSync = realStat
  }
  ok(wNotFile.ok === false && wNotFile.error === '写入失败',
    '非普通文件(FIFO/socket)→ 写入失败(既不 copy 备份也不覆写)', JSON.stringify(wNotFile))
  ok(fs.readFileSync(cfgAbs, 'utf8') === cfgBeforeR3 && cfgBakCount() === r3BakBefore,
    '非普通文件那条既没改原文件也没产生备份')

  // 写必须走 resolveInside(真实路径闸),而不是只有字面闸的 resolveRel:
  // 项目内一条指向项目外的链接,resolveRel 看着完全合法,fs 却会把写落到链接目标上 ——
  // 读取泄漏的是内容,写入改的是**别人的文件**,所以这里额外断言磁盘没被碰。
  if (canDirLink.ok) {
    const w3 = F.writeProjectText('godot/project/p1', 'linkdir/pwn.txt', 'PWNED')
    ok(w3.ok === false && w3.error === '非法路径',
      '写穿过项目内目录符号链接指向项目外 → 非法路径', JSON.stringify(w3))
    ok(!fs.existsSync(path.join(OUT, 'pwn.txt')), '被挡住的写在项目外没留下文件')
  } else {
    skipAssert('写入穿过项目内目录符号链接的断言本机未执行', canDirLink.reason)
  }
  if (canFileLink.ok) {
    const w4 = F.writeProjectText('godot/project/p1', 'link-out.txt', 'PWNED')
    ok(w4.ok === false && w4.error === '非法路径',
      '覆盖项目内指向项目外的文件符号链接 → 非法路径', JSON.stringify(w4))
    ok(fs.readFileSync(path.join(OUT, 'secret.txt'), 'utf8') === 'SECRET-OUTSIDE-TREE\n',
      '被挡住的写没有改动项目外的原文件')
  } else {
    skipAssert('写入穿过项目内文件符号链接的断言本机未执行', canFileLink.reason)
  }

  // ---------- 5b. resolveInside:项目正好落在文件系统根时不误伤 ----------
  // realpathSync 对文件系统根('C:\\'、'/')会**保留**结尾分隔符,于是 realRoot + sep 拼出
  // 'C:\\\\' / '//',任何子路径都不以它开头 —— 盘根项目的每次合法写/删都会被误判「非法路径」。
  // TREE 在临时目录下,拿不到这个形态,所以这里直接对文件系统根调 resolveInside 断言。
  section('5b. resolveInside 文件系统根前缀')
  const FSROOT = path.parse(TREE).root // Windows 'C:\\';POSIX '/'
  const rootReal = (() => { try { return fs.realpathSync(FSROOT) } catch (e) { return '' } })()
  // 挑一个**确定存在、realpath 也问得到、且自身不是符号链接**的根内目录。
  // 只筛 lstat 不够:NTFS junction 的 lstat 报 isSymbolicLink() === false(它是 reparse point
  // 而非 symlink,readdir 顺序又不保证),而 'System Volume Information' 这类受保护目录的
  // realpathSync 直接抛 EPERM → resolveInside 返回 '路径无法解析' → 本节在别的机器/别的卷上
  // 假失败(与要测的前缀拼接毫无关系)。所以这里**用 realpathSync(candidate) 亲自走一遍**,
  // 问不到真实路径的候选一律不选;一个都选不出来时走 skipAssert(可见,不记 PASS)。
  const someDir = (() => {
    try {
      return fs.readdirSync(FSROOT).find((n) => {
        const cand = path.join(FSROOT, n)
        try {
          const st = fs.lstatSync(cand)
          if (!st.isDirectory() || st.isSymbolicLink()) return false
          fs.realpathSync(cand) // ← 真正的筛选条件:这一条 realpath 问得到才用
          return true
        } catch (e) { return false }
      }) || ''
    } catch (e) { return '' }
  })()
  if (rootReal && someDir) {
    const r1 = tryResolveInside(FSROOT, someDir)
    ok(!r1.error && typeof r1.abs === 'string',
      `项目根为 ${JSON.stringify(FSROOT)} 时,根内已存在的目录不被误判(${someDir})`, JSON.stringify(r1))
    const r2 = tryResolveInside(FSROOT, `${someDir}/gpm-not-here.txt`)
    ok(!r2.error && typeof r2.abs === 'string',
      '项目根为文件系统根时,根内**尚未存在**的路径也放行(新建文件不被挡)', JSON.stringify(r2))
    // 这里**不**再断言 `tryResolveInside(FSROOT, '../escape-from-root')` 挡得住:
    // 文件系统根没有父目录,'../' 形态在 resolveRel 的字面闸就被拒了,根本走不到包含比较 ——
    // 那条断言在旧代码、新代码、甚至把包含比较整段删掉的情况下都同样绿,
    // 因此它**不是**「修复没把闸拆宽」的证据,已按 review 撤下(撤下它不减少任何覆盖)。
    // 真正钉住包含比较的是第 3 节与第 5 节的符号链接组(读侧 + 写侧,各查磁盘没被碰)。
  } else {
    skipAssert('文件系统根断言本机未执行(无法 realpath 根目录,或找不到 realpath 问得到的根内目录)',
      `${rootReal || 'realpath 根目录失败'} ${someDir || '没有 realpath 问得到的候选目录'}`)
  }

  // ---------- 6. movePathsToTrash ----------
  // 三条红线:
  //  ① 删除只走 resolveInside(真实路径闸),不走只有字面判断的 resolveRel。
  //     项目内一条指向项目外的符号链接在 resolveRel 看来完全合法(rel 里没有 `..`),
  //     而 fs / PowerShell 会跟随它 —— 读的时候只是泄漏内容,删的时候删的是**别人家的文件**。
  //  ② 单项失败不中断其余:工具页要按「N 项成功、M 项失败」出结论,失败项必须原样带回。
  //  ③ 空清单不是错误(moved:0)。
  // 平台语义:fsutil.trashPath 在 Windows 进回收站、macOS/Linux 是永久删除,
  // 所以这里只断言「消失」,不断言「可还原」。
  // 编号说明:计划里这节写的是「4.」,但 Tasks 3-4 已占用 3/4/5/5b 四节,这里顺延为 6。
  section('6. movePathsToTrash')
  const trashRoot = makeTree('trashproj', { 'a.txt': 'A', 'b.txt': 'B', 'sub/c.txt': 'C' })
  DB.set('godot/project/t1', { _id: 'godot/project/t1', id: 't1', path: trashRoot, name: 'T' })
  /** 删除属动物件:异常一律摊成一条指名 FAIL,不能让脚本崩在堆栈上(与 tryResolve 同形) */
  function tryTrash(projectId, rels) {
    try { return F.movePathsToTrash(projectId, rels) } catch (e) { return { error: 'threw: ' + e.message } }
  }
  const tr = F.movePathsToTrash('godot/project/t1', ['a.txt', 'sub', 'nope.txt', '../evil'])
  ok(!fs.existsSync(path.join(trashRoot, 'a.txt')), '单文件已消失')
  ok(!fs.existsSync(path.join(trashRoot, 'sub')), '目录整体消失(含子文件)')
  ok(fs.existsSync(path.join(trashRoot, 'b.txt')), '未点名的文件不受影响')
  ok(tr.failed.some((f) => f.rel === 'nope.txt'), '缺失项进 failed 且不中断其余', JSON.stringify(tr.failed))
  ok(tr.failed.some((f) => f.rel === '../evil' && f.error === '非法路径'), '越界项进 failed 并标非法路径')
  ok(tr.ok === false && tr.moved === 2, '有失败则 ok:false,moved 只计成功数', JSON.stringify({ ok: tr.ok, moved: tr.moved }))
  ok(F.movePathsToTrash('godot/project/t1', []).ok === true, '空清单 → ok:true')
  ok(F.movePathsToTrash('godot/project/t1', []).moved === 0, '空清单 moved:0')
  ok(F.movePathsToTrash('godot/project/none', ['a']).error === '项目不存在', '未知项目 → 项目不存在')

  // ---------- 6b. 删除必须过真实路径闸(resolveInside),不得退回字面闸 ----------
  // 上面那组里 '../evil' 靠**文本**就能挡住,换成项目内的链接就挡不住了:
  // rel 里没有 `..`、没有盘符,resolveRel 放行,落点却在项目外。
  // 所以这组断言是「实现有没有真的用 resolveInside」的唯一证据 ——
  // 把实现改回 resolveRel,两条都会红(一条是 failed 里没了这一项,一条是项目外文件被删走)。
  section('6b. 删除穿过项目内符号链接指向项目外 → 拒绝')
  const OUT2 = path.join(WORK, 'trash-outside')
  fs.mkdirSync(OUT2, { recursive: true })
  fs.writeFileSync(path.join(OUT2, 'victim.txt'), 'MUST-SURVIVE\n', 'utf8')
  const canTrashLink = trySymlink(OUT2, path.join(trashRoot, 'link-out-dir'), 'dir')
  if (canTrashLink.ok) {
    const victim = path.join(OUT2, 'victim.txt')
    const t6 = F.movePathsToTrash('godot/project/t1', ['link-out-dir'])
    ok(t6.ok === false && t6.moved === 0 &&
      t6.failed.some((f) => f.rel === 'link-out-dir' && f.error === '非法路径'),
      '项目内目录符号链接指向项目外 → 该项进 failed 标非法路径', JSON.stringify(t6))
    ok(fs.existsSync(victim) && fs.readFileSync(victim, 'utf8') === 'MUST-SURVIVE\n',
      '被挡住的删除没有波及项目外的文件(删除是动物件:漏一次闸就是删别人家数据)')
    ok(fs.existsSync(path.join(trashRoot, 'link-out-dir')), '链接本身也还在(拒绝即不动盘)')
  } else {
    skipAssert('删除穿过项目内目录符号链接的断言本机未执行', canTrashLink.reason)
  }

  // ---------- 6c. 回收站真失败:不中断其余、moved 不数它、且不硬删兜底 ----------
  // 6 的失败项都出在**闸**上(没碰到盘),这条把它出在 trash 那一步:
  //  · 只断言闸的失败,挡不住「trash 阶段一遇错就 break」——那种实现下
  //    后面几项根本不会被删,而 6 组里成功项排在失败项之前,照样全绿;
  //  · 也挡不住 `moved: items.length` —— 6 组里 items.length 恰好等于成功数 2。
  // 注入方式:按平台各自的分叉点打钩(Windows 走 PowerShell 的 execSync,
  // POSIX 走 fs.unlinkSync),命中 doomed 那一项才抛,其余照常放行。
  // 匹配用**文件名**而不是绝对路径:fsutil 把路径塞进 JSON.stringify 后再塞进整条命令的
  // JSON.stringify,反斜杠被翻倍两轮('C:\\\\x'),拿 abs 或 JSON.stringify(abs) 去 includes
  // 都匹配不上 —— 探针会静默不命中,于是这组断言全在空跑。
  section('6c. 回收站单项失败(注入)')
  const trashRoot2 = makeTree('trashproj2', { 'doomed.txt': 'D', 'ok2.txt': 'O' })
  DB.set('godot/project/t2', { _id: 'godot/project/t2', id: 't2', path: trashRoot2, name: 'T2' })
  const cp = require('node:child_process')
  const doomedAbs = path.join(trashRoot2, 'doomed.txt')
  const ok2Abs = path.join(trashRoot2, 'ok2.txt')
  const realExecSync = cp.execSync
  const realUnlinkSync = fs.unlinkSync
  const hitsDoomed = (arg) => String(arg).includes('doomed.txt')
  let injected = 0
  cp.execSync = (...a) => { if (hitsDoomed(a[0])) { injected++; throw new Error('simulated recycle-bin failure') } return realExecSync(...a) }
  fs.unlinkSync = (p, ...rest) => { if (hitsDoomed(p)) { injected++; throw new Error('simulated EPERM') } return realUnlinkSync(p, ...rest) }
  let t7
  try {
    t7 = F.movePathsToTrash('godot/project/t2', ['doomed.txt', 'ok2.txt'])
  } finally {
    cp.execSync = realExecSync
    fs.unlinkSync = realUnlinkSync
  }
  ok(injected === 1, '探针确实只命中 doomed 那一项(断言不是空跑)', String(injected))
  ok(t7.ok === false && t7.moved === 1, 'moved 只数真正成功的 1 项(不是 items.length)', JSON.stringify({ ok: t7.ok, moved: t7.moved }))
  ok(t7.failed.some((f) => f.rel === 'doomed.txt' && f.error === '移入回收站失败'),
    '回收站失败 → failed 里是「移入回收站失败」(钉住这条串,Rust 侧逐字镜像)', JSON.stringify(t7.failed))
  ok(!fs.existsSync(ok2Abs), '失败项之后的项照常被删除(不中断其余)', fs.readdirSync(trashRoot2).join(','))
  ok(fs.existsSync(doomedAbs) && fs.readFileSync(doomedAbs, 'utf8') === 'D',
    '回收站失败后不得退化成硬删:原文件还在原地', fs.readdirSync(trashRoot2).join(','))

  // ---------- 6d. 入参畸形也不抛异常(只读/写/删原语的共同红线)----------
  section('6d. 不抛异常 + 闸错误串如实透传')
  const t8 = tryTrash('godot/project/t1', null)
  ok(!String(t8.error || '').startsWith('threw') && t8.ok === true && t8.moved === 0,
    'rels 为 null → 按空清单处理(不抛)', JSON.stringify(t8))
  const t9 = tryTrash('godot/project/t1', [42, undefined, ''])
  ok(!String(t9.error || '').startsWith('threw') && t9.ok === false && t9.moved === 0 &&
    t9.failed.length === 3 && t9.failed.every((f) => f.error === '非法路径'),
    '非字符串/空 rel 逐项标非法路径,不抛也不误删', JSON.stringify(t9.failed))
  // 父目录也不存在的 rel:resolveInside 会退到最近的已存在祖先(项目根本身总在),
  // 所以 '目标目录不存在' 那条在删除侧**够不着**,一律由后面的 stat 报 '文件不存在'。
  // 这里钉住的是「所有缺失形态都收敛到同一句『文件不存在』」——Rust 侧 Task 7 只需镜像这一句。
  const t10 = F.movePathsToTrash('godot/project/t1', ['nodir/x.txt'])
  ok(t10.ok === false && t10.moved === 0 &&
    t10.failed.some((f) => f.rel === 'nodir/x.txt' && f.error === '文件不存在'),
    '父目录也不存在的缺失项 → 文件不存在(不报目录不存在、不抛)', JSON.stringify(t10.failed))
  // rel 写成 Windows 反斜杠形态也要能删(对外只有 rel 一个键,形态必须容忍 —— 与 resolveRel 一致)。
  fs.mkdirSync(path.join(trashRoot, 'sub2'), { recursive: true })
  fs.writeFileSync(path.join(trashRoot, 'sub2', 'y.txt'), 'Y\n', 'utf8')
  const t11 = F.movePathsToTrash('godot/project/t1', ['sub2\\y.txt'])
  ok(t11.ok === true && t11.moved === 1, '反斜杠形态的 rel 照常解析并删除', JSON.stringify(t11))
  ok(!fs.existsSync(path.join(trashRoot, 'sub2', 'y.txt')), '反斜杠 rel 的落点正确(目标文件已消失)')
  const t12 = F.movePathsToTrash('godot/project/t1', ['sub2'])
  ok(t12.ok === true && t12.moved === 1 && !fs.existsSync(path.join(trashRoot, 'sub2')),
    '清空后的目录本身也是合法删除对象(不留空壳)')

  // ---------- 6e. 残骸核对:fixture 里只剩预期文件 ----------
  // 顺带钉住「删除只动点名项」:b.txt 与被拒绝的链接都还在,被拒的父目录没被顺手建/删。
  section('6e. 测试残骸核对')
  const leftTrash = fs.readdirSync(trashRoot).sort()
  const wantLeft = ['b.txt'].concat(canTrashLink.ok ? ['link-out-dir'] : []).sort()
  ok(leftTrash.join(',') === wantLeft.join(','),
    'trashproj 里只剩预期文件(未点名项零改动)', leftTrash.join(','))
  ok(!fs.readdirSync(trashRoot).some((n) => n.startsWith('.gpm-tmp-')),
    '删除流程不产生 .gpm-tmp-* 残骸')
  ok(!fs.existsSync(path.join(trashRoot, 'nodir')), '被拒绝的删除没在项目里长出目录树')

  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  console.log(`SKIP ${skips} 项未在本机执行(不计入上面的 PASS;>0 通常是本机没有创建符号链接的权限)`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
}
main()
