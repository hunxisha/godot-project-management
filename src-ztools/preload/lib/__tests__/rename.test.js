// rename.test.js —— 项目内改名原语(§G Task 15,兑现 §F DEV-11 欠的那条通道)。
//
// 为什么必须是一条**新原语**而不是拿现有两块拼:§F DEV-11 判死过 ——
// `movePathsToTrash` + `writeProjectText` 拼出来的「假改名」会丢 `.uid` 边车与 mtime 语义
// (写完新文件 mtime 就是「现在」,Godot 的导入器按 mtime 判是否重导,于是每个被改名的资产都被重导一遍)。
// 所以这里钉的第一节就是**字节与 mtime 都不许变**。
//
// 四条与同族原语(inspectfs.js 的读/写/删)一致的纪律,一条都不松:
//   · 原语**不抛异常**,一律 {ok:false,error}(工具页要把原因显示出来);
//   · 错误串逐字复用那批('项目不存在' / '非法路径' / '文件不存在' / '目标目录不存在'),
//     本批只新增三条说得出新语义的串:'目标已存在' / '目录改名不支持' / '项目主配置文件不改名'
//     (旧那批没有一说得出这三件事的,硬复用就是在谎报原因);
//   · 越界一律 `'非法路径'` 一串糊到底(inspectfs.js:62-63 的原话:不透露挡掉的到底是哪一类);
//   · 对外只有 rel(正斜杠、相对项目根),绝对路径与盘符一个都不回显。
//
// 边车名字一律用「主 rel + 尾缀」切(`X.a.b.uid` 的源是 `X.a.b`)—— 第 5 节那条双重后缀的断言钉住它,
// 那是旧 `inspectors/uid.ts` 的 UID_SUFFIX 注释点过的坑(用 basename 重拼会拼错)。
//
// ⚠ 一条**测不到**的分支,记在这里防止被当成已验:预检(每个源必须是普通文件、每个目标必须没被占、
// 父目录必须存在)全部通过后,剩下能失败的只有真实 I/O 错误(EPERM/EINVAL)。那种失败发生在第 2、3 个
// move 上时需要「回退已搬的那几个」,而本机造不出确定性的中间态(占句柄在同进程共享模式下不拦 rename)。
// 实现里保留 best-effort 回退,断言只钉「第一步就失败 ⇒ 盘上干净」这一支,多步那一支进 §12 真机项。
//
// 用法:node src-ztools/preload/lib/__tests__/rename.test.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const LIB = path.resolve(__dirname, '..')

let pass = 0
let skips = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}
/** 本机跑不了(建符号链接要权限)时**显式 SKIP,不计入 PASS** —— 全绿不等于没测 */
function skipAssert(label, reason) { skips++; console.log(`  SKIP  ${label}${reason ? ' → ' + reason : ''}`) }
function section(t) { console.log(`\n=== ${t} ===`) }

// 桩掉 window.ztools.db:原语只读项目文档拿 path(与 inspectfs.test.js 同一套)
const DB = new Map()
global.window = { ztools: { db: { get: (id) => (DB.get(id) ? { ...DB.get(id) } : null) } } }
const F = require(path.join(LIB, 'inspectfs.js'))

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-rename-'))

/**
 * TDD 的取值器:实现还不存在时**返回一个失败对象**,而不是抛 TypeError 把整个套件撞停
 * (§F Task 10 的教训:「撞停的样子很像抓到了」,其实一条统计都没产出)。
 */
function RN(pid, rel, to, opts) {
  if (typeof F.renameProjectPath !== 'function') return { ok: false, error: '__NO_IMPL__' }
  try {
    return F.renameProjectPath(pid, rel, to, opts)
  } catch (e) {
    return { ok: false, error: '__THREW__:' + (e && e.message) }
  }
}

let seq = 0
/** 造一棵临时项目根并登记进 db,返回 projectId。值给 null 表示「那是个目录」 */
function makeProject(spec) {
  const root = path.join(WORK, 'p' + (++seq))
  fs.mkdirSync(root, { recursive: true })
  for (const [rel, content] of Object.entries(spec || {})) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    if (content === null) fs.mkdirSync(abs, { recursive: true })
    else fs.writeFileSync(abs, content, 'utf8')
  }
  const id = 'godot/project/p' + seq
  DB.set(id, { _id: id, id: 'p' + seq, path: root, name: 'R' + seq })
  return id
}
/** 项目根 → 绝对路径(只有测试要用,原语永不外泄绝对路径) */
function rootOf(pid) { return (DB.get(pid) || {}).path }
function absOf(pid, rel) { return path.join(rootOf(pid), ...rel.split('/')) }
/** 读不到给 null,不抛 —— 红态(实现还没建、文件自然不在)必须把整趟跑完拿到 FAIL 计数,
 *  而不是用一次 ENOENT 把套件撞停(§F Task 10:「撞停的样子很像抓到了」) */
function read(pid, rel) {
  try { return fs.readFileSync(absOf(pid, rel), 'utf8') } catch (e) { return null }
}
function mtimeOf(pid, rel) {
  try { return Math.round(fs.statSync(absOf(pid, rel)).mtimeMs) } catch (e) { return -1 }
}
/** 同样为红态兜底:实现没给 moved 时按空数组判,不在断言里抛 */
function mv(r) { return Array.isArray(r && r.moved) ? r.moved : [] }
/** 在 null-safe 的读结果上找子串(直接对 read() 的返回值调 .includes 会在红态把套件撞停) */
function has(pid, rel, sub) { const t = read(pid, rel); return typeof t === 'string' && t.includes(sub) }
/** 读项目外的绝对路径(链接夹具的靶子),读不到给 null —— 变异态下文件可能真的被搬走了,不许撞停 */
function peek(absPath) { try { return fs.readFileSync(absPath, 'utf8') } catch (e) { return null } }
/** 盘上清单(目录不算,链接按名字收),用于「一条都没动」的比对 */
function listing(pid) {
  const root = rootOf(pid)
  const out = []
  const walk = (dir, base) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? base + '/' + e.name : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), rel)
      else out.push(rel)
    }
  }
  if (fs.existsSync(root)) walk(root, '')
  return out.sort()
}
/** 定死 mtime:改名前把时间戳按到过去,成功改名后必须还是那个值(拼接版会跳成「现在」) */
function pinMtime(pid, rel, ms) {
  const t = new Date(ms)
  fs.utimesSync(absOf(pid, rel), t, t)
  return ms
}
const PINNED = Date.UTC(2020, 0, 1, 0, 0, 0)

// ---------------------------------------------------------------- 0. 导出面
section('0. 导出面')
{
  ok(typeof F.renameProjectPath === 'function', 'renameProjectPath 是函数(先写断言时这条本该红)', typeof F.renameProjectPath)
  ok(typeof F.writeProjectText === 'function' && typeof F.movePathsToTrash === 'function', '既有原语一个都没被动掉')
  ok(typeof F.resolveInside === 'function', '改名复用同一道 resolveInside,没有另立第三道越界闸')
}

// ---------------------------------------------------------------- 1. 改名不改内容
section('1. 正常改名:字节与 mtime 都不许变(DEV-11 拒绝拼接版的理由就钉在这一节)')
{
  const pid = makeProject({
    'project.godot': 'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n',
    'player.gd': 'extends Node\n',
    'player.gd.uid': 'uid://abc123\n',
    'main.tscn': '[gd_scene load_steps=2 format=3 uid="uid://scene1"]\n[ext_resource type="Script" path="res://player.gd" id="1_x"]\n'
  })
  const m0 = pinMtime(pid, 'player.gd', PINNED)
  pinMtime(pid, 'player.gd.uid', PINNED)
  const r = RN(pid, 'player.gd', 'hero.gd')
  ok(r.ok === true, '改名成功', r)
  ok(r.from === 'player.gd' && r.to === 'hero.gd', 'from/to 回的是归一后的 rel', r)
  ok(!fs.existsSync(absOf(pid, 'player.gd')), '旧名没了')
  ok(read(pid, 'hero.gd') === 'extends Node\n', '新名内容逐字节相同(不是复制再写)')
  ok(mtimeOf(pid, 'hero.gd') === m0, 'mtime 一字不变 —— writeProjectText 那一版在这里必然跳成现在')
  ok(fs.existsSync(absOf(pid, 'hero.gd.uid')), 'A-24:.uid 边车跟着搬到新名')
  ok(!fs.existsSync(absOf(pid, 'player.gd.uid')), 'A-24:旧名的边车没留下孤儿')
  ok(read(pid, 'hero.gd.uid') === 'uid://abc123\n', '边车内容一字不改(uid 与文件名无关,改它等于自断引用)')
  ok(mtimeOf(pid, 'hero.gd.uid') === PINNED, '边车的 mtime 也不变(边车同样是 inode 移动)')
  ok(mv(r).length === 2, 'moved 含主文件 + 边车两条', mv(r))
  ok(!!mv(r)[0] && mv(r)[0].from === 'player.gd', 'moved 第一条是主文件(顺序定死,回执按它数边车)', mv(r)[0])
  ok(!!mv(r)[1] && mv(r)[1].from === 'player.gd.uid' && mv(r)[1].to === 'hero.gd.uid', '边车那一对是「主 rel + 尾缀」,不是 basename 重拼', mv(r)[1])
  ok(has(pid, 'main.tscn', 'res://player.gd'), '原语只搬文件:引用文本一个字节都不改(改写是渲染层工具的活)')
}

// ---------------------------------------------------------------- 2. rel 形态
section('2. rel 形态归一(与 resolveRel 同一套:反斜杠 / ./ / 重复斜杠)')
{
  const pid = makeProject({ 'a.gd': 'A\n', 'sub/b.gd': 'B\n' })
  const r1 = RN(pid, '.\\a.gd', 'a2.gd')
  ok(r1.ok === true, '旧名写成 .\\a.gd 照样改得动', r1)
  ok(r1.from === 'a.gd' && !fs.existsSync(absOf(pid, 'a.gd')) && read(pid, 'a2.gd') === 'A\n', '回报里的 from 是归一后的 rel(渲染层据此对账)', r1)
  const r2 = RN(pid, 'a2.gd', './sub//b2.gd')
  ok(r2.ok === true && r2.to === 'sub/b2.gd', '新名里的 ./ 与重复斜杠被归一(回给渲染层的 rel 与 scanProjectTree 同形)', r2)
  ok(read(pid, 'sub/b2.gd') === 'A\n', '跨目录改名成功(原语通用;本批的 UI 只改同目录名)')
  const r3 = RN(pid, 'sub/b2.gd', 'nowhere/x.gd')
  ok(r3.ok === false && r3.error === '目标目录不存在', '新名的父目录不存在 ⇒ 拒,绝不 mkdir(与 writeProjectText 同一条:typo 不该长出目录树)', r3)
  ok(listing(pid).indexOf('sub/b2.gd') >= 0, '被拒的改名没在盘上留下任何东西', listing(pid))
}

// ---------------------------------------------------------------- 3. 四种越界
section('3. 四种越界一律拒(§G A-18 同族:.. / 绝对路径 / 盘符 / 符号链接)')
{
  const pid = makeProject({ 'a.gd': 'A\n', 'sub/keep.gd': 'K\n' })
  const root = rootOf(pid)
  const before = listing(pid).join()

  const up1 = RN(pid, '../stolen.gd', 'x.gd')
  ok(up1.ok === false && up1.error === '非法路径', '旧名带 .. 跳出项目 ⇒ 非法路径', up1)
  const up2 = RN(pid, 'a.gd', '../stolen.gd')
  ok(up2.ok === false && up2.error === '非法路径', '新名带 .. 跳出项目 ⇒ 非法路径', up2)
  ok(!fs.existsSync(path.join(WORK, 'stolen.gd')), 'WORK 底下没长出被偷出来的文件')

  const ab = RN(pid, 'a.gd', path.join(WORK, 'outside-abs.gd'))
  ok(ab.ok === false && ab.error === '非法路径', '新名给绝对路径 ⇒ 非法路径', ab)
  const drv = RN(pid, 'a.gd', 'C:/Windows/win.gd')
  ok(drv.ok === false && drv.error === '非法路径', '新名给盘符路径 ⇒ 非法路径', drv)
  const drv2 = RN(pid, 'D:bad.gd', 'x.gd')
  ok(drv2.ok === false && drv2.error === '非法路径', '旧名给盘符路径 ⇒ 非法路径', drv2)
  ok(listing(pid).join() === before, '越界这一组一条都没动盘', listing(pid))

  const noProj = RN('godot/project/ghost', 'a.gd', 'b.gd')
  ok(noProj.ok === false && noProj.error === '项目不存在', '未登记的 projectId ⇒ 「项目不存在」(复用旧串)', noProj)

  // 外面那一棵树:链接类夹具的靶子。**必须放在项目根之外** —— 放在根里面会让包含闸恒真、验空气
  const outside = path.join(WORK, 'rn-outside-' + Date.now())
  fs.mkdirSync(path.join(outside, 'inner'), { recursive: true })
  fs.writeFileSync(path.join(outside, 'victim.gd'), '外面\n', 'utf8')

  // junction 是 reparse point,这台机器普通权限就能建(第 1 批 Task 5 同一条出路)
  let madeJct = false
  try { fs.symlinkSync(outside, path.join(root, 'jct'), 'junction'); madeJct = true } catch (e) { madeJct = false }
  if (!madeJct) {
    skipAssert('先证明那个目录联结在 lstat 眼里确实是链接', '本机连 junction 也建不出来')
    skipAssert('旧名落在指向外面的链接里 ⇒ 拒', '本机连 junction 也建不出来')
    skipAssert('新名落在指向外面的链接里 ⇒ 拒', '本机连 junction 也建不出来')
  } else {
    ok(fs.lstatSync(path.join(root, 'jct')).isSymbolicLink(), '先证明这个 junction 在 lstat 眼里确实是链接(否则下面三条是在验空气)')
    const out1 = RN(pid, 'jct/victim.gd', 'victim.gd')
    ok(out1.ok === false && out1.error === '非法路径', '旧名落在指向外面的链接里 ⇒ 拒(真实落点闸,不是字面闸)', out1)
    const out2 = RN(pid, 'a.gd', 'jct/planted.gd')
    ok(out2.ok === false && out2.error === '非法路径', '新名落在指向外面的链接里 ⇒ 拒(否则改的是别人家的名字)', out2)
    // ⚠ 上面两条的「拒」有一半是**边车循环顺手挡的**:`<旧名>.uid` / `<新名>.uid` 各自也过一道 resolveInside,
    // 于是把主文件那一道闸单独降级时,这两条照样绿(第一版 K1「越界闸降成 resolveRel」就是这么活下来的)。
    // 下面这两条带 sidecar:false,让主闸**一个人**面对链接 —— 降级就必红。
    const out3 = RN(pid, 'jct/victim.gd', 'victim.gd', { sidecar: false })
    ok(out3.ok === false && out3.error === '非法路径', 'sidecar:false 时主文件那道闸要独立挡住链接(不靠边车循环补位)', out3)
    const out4 = RN(pid, 'a.gd', 'jct/planted2.gd', { sidecar: false })
    ok(out4.ok === false && out4.error === '非法路径', '目标侧同理:不搬边车时也要拒', out4)
    ok(!fs.existsSync(path.join(outside, 'planted.gd')) && !fs.existsSync(path.join(outside, 'planted2.gd')), '外面那个目录里没长出新名字的文件')
    ok(peek(path.join(outside, 'victim.gd')) === '外面\n', '外面那个文件的名字与内容都没动')
    const inner = RN(pid, 'sub/keep.gd', 'keep.gd')
    ok(inner.ok === true, '项目内真目录里的文件照样改得动(排除的只有链接,不是整个子树)', inner)
  }

  // 文件级符号链接:Windows 要开发者模式 ⇒ 建不出来就显式 SKIP(进 §12 真机项,不许算成已过)
  let madeFile = false
  try { fs.symlinkSync(path.join(outside, 'victim.gd'), path.join(root, 'link.gd'), 'file'); madeFile = true } catch (e) { madeFile = false }
  if (!madeFile) {
    skipAssert('改名一条指向项目外的文件级链接 ⇒ 按真实落点拒', '本机没有创建文件符号链接的权限(要开发者模式)')
    skipAssert('链接目标本身的名字不许被顺带改掉', '本机没有创建文件符号链接的权限(要开发者模式)')
  } else {
    const t = RN(pid, 'link.gd', 'link2.gd')
    ok(t.ok === false && t.error === '非法路径', '改名一条指向项目外的文件级链接 ⇒ 按真实落点拒', t)
    ok(fs.existsSync(path.join(outside, 'victim.gd')), '外面那个被链接指着的文件名字没被动', undefined)
  }
}

// ---------------------------------------------------------------- 4. 拒绝形态
section('4. 拒绝形态:目标重名 / 目录 / 项目主配置 / 前后同名 / 名字本身非法')
{
  const pid = makeProject({ 'a.gd': 'A\n', 'b.gd': 'B\n', 'project.godot': 'config_version=5\n', 'dir': null })
  const before = listing(pid).join()

  const dup = RN(pid, 'a.gd', 'b.gd')
  ok(dup.ok === false && dup.error === '目标已存在', '新名已被占用 ⇒ 拒(不是覆掉别人)', dup)
  ok(read(pid, 'a.gd') === 'A\n' && read(pid, 'b.gd') === 'B\n', '两个文件都还在、内容没换(覆掉就是数据丢失)')

  const dirSrc = RN(pid, 'dir', 'dir2')
  ok(dirSrc.ok === false && dirSrc.error === '目录改名不支持', '目录改名本批不支持(要递归改整棵树里每一个 rel 的引用)', dirSrc)

  const pg = RN(pid, 'project.godot', 'project2.godot')
  ok(pg.ok === false && pg.error === '项目主配置文件不改名', 'project.godot 是项目身份,改名等于把项目作废', pg)
  ok(fs.existsSync(absOf(pid, 'project.godot')), '被拒后 project.godot 仍在原处(宿主的项目登记没坏)')

  const toPg = RN(pid, 'a.gd', 'project.godot')
  ok(toPg.ok === false && toPg.error === '目标已存在', '改成 project.godot 由「目标已存在」挡住,不重复发明一条串', toPg)

  const same = RN(pid, 'a.gd', 'a.gd')
  ok(same.ok === false && same.error === '改名前后是同一个名字', 'rel === to ⇒ 拒,不去碰盘(也不产生一次假成功)', same)
  const same2 = RN(pid, './a.gd', 'a.gd')
  ok(same2.ok === false && same2.error === '改名前后是同一个名字', '归一后同名(./a.gd vs a.gd)同样算「同一个名字」', same2)

  const miss = RN(pid, 'nope.gd', 'hero.gd')
  ok(miss.ok === false && miss.error === '文件不存在', '旧名不在盘上 ⇒ 「文件不存在」(复用旧串)', miss)

  ok(listing(pid).join() === before, '这一组全部拒在动盘之前:盘上清单一字不变', listing(pid))

  // 名字里有本平台不能用的字符:预检看不出来(它不存在的),到 move 那一刻才炸 ⇒ 必须收口成失败而不是抛
  if (process.platform === 'win32') {
    const bad = RN(pid, 'a.gd', 'b?.gd')
    ok(bad.ok === false && bad.error === '重命名失败', 'Windows 上非法文件名字符 ⇒ 「重命名失败」,不抛', bad)
    ok(listing(pid).join() === before, '这一条也没在盘上留下任何东西', listing(pid))
  } else {
    const bad = RN(pid, 'a.gd', 'b?.gd')
    ok(bad.ok === true, 'POSIX 上「?」是合法文件名 ⇒ 照样改得动(这条不假装平台无关)', bad)
  }
}

// ---------------------------------------------------------------- 5. 边车
section('5. 边车:两种尾缀都搬、按「主 rel + 尾缀」切、没有边车时不报错')
{
  const pid = makeProject({
    'solo.gd': 'S\n',
    'icon.png': '假 PNG\n',
    'icon.png.import': '[remap]\nimporter="texture"\nuid="uid://tex1"\n',
    'a.b.gd': 'D\n',
    'a.b.gd.uid': 'uid://dbl\n',
    'only-uid.cs': 'C\n',
    'only-uid.cs.uid': 'uid://cs1\n',
    'fake.gd': 'X\n',
    'fake.gd.uid': null
  })
  const r1 = RN(pid, 'solo.gd', 'solo2.gd')
  ok(r1.ok === true && mv(r1).length === 1, '没有边车 ⇒ moved 只有主文件一条,不算失败', mv(r1))

  const r2 = RN(pid, 'icon.png', 'logo.png')
  ok(r2.ok === true && mv(r2).length === 2, '.import 边车跟着搬(不搬 = 引擎按旧名找导入元数据,资产掉回未导入态)', mv(r2))
  ok(has(pid, 'logo.png.import', 'uid="uid://tex1"'), '边车里的 uid 一字不改(DEV-26)')
  ok(!fs.existsSync(absOf(pid, 'icon.png.import')), '旧名边车没留孤儿')

  const r3 = RN(pid, 'a.b.gd', 'c.b.gd')
  ok(r3.ok === true && mv(r3).length === 2 && mv(r3)[1].from === 'a.b.gd.uid' && mv(r3)[1].to === 'c.b.gd.uid', '双重后缀的边车按「主 rel + 尾缀」切,不用 basename 重拼', mv(r3))
  ok(read(pid, 'c.b.gd.uid') === 'uid://dbl\n', '双重后缀的边车内容没动')

  const r4 = RN(pid, 'only-uid.cs', 'renamed.cs')
  ok(r4.ok === true && mv(r4).length === 2, '非 .gd 的主文件照样带 .uid 边车(原语不认识 GDScript)', mv(r4))

  const r5 = RN(pid, 'renamed.cs', 'renamed2.cs', { sidecar: false })
  ok(r5.ok === true && mv(r5).length === 1, 'opts.sidecar:false ⇒ 只搬主文件(调用方显式要求,默认永远是 true)', mv(r5))
  ok(fs.existsSync(absOf(pid, 'renamed.cs.uid')), 'sidecar:false 时旧边车**留着**(这是显式选择,不是漏搬)')

  // 名字叫边车尾缀、实际是个目录 ⇒ 不是边车,不搬也不算失败
  const r6 = RN(pid, 'fake.gd', 'real.gd')
  ok(r6.ok === true && mv(r6).length === 1, '「fake.gd.uid」是个目录 ⇒ 不当边车搬(只有普通文件才算)', mv(r6))
  ok(fs.existsSync(absOf(pid, 'real.gd')), '主文件照样搬到了新名')

  // 自撞:新名的边车槽位已被占(真实形态:目录里先长出一个同名边车)
  const pid2 = makeProject({ 'q.gd': 'Q\n', 'p.gd.uid': 'uid://taken\n' })
  const before2 = listing(pid2).join()
  const r7 = RN(pid2, 'q.gd', 'p.gd')
  ok(r7.ok === false && r7.error === '目标已存在', '新名的边车槽位被占 ⇒ 整条拒(先搬主文件就留下「主文件在、边车对不上」的半截)', r7)
  ok(listing(pid2).join() === before2, '这一条同样拒在动盘之前', listing(pid2))
}

// ---------------------------------------------------------------- 6. 大小写
section('6. 只有大小写不同的改名(Windows 不敏感 / Linux 敏感 ⇒ 两边都不许误拒)')
{
  const pid = makeProject({ 'Foo.gd': 'F\n' })
  const r = RN(pid, 'Foo.gd', 'foo.gd')
  ok(r.ok === true, '大小写仅改名不许报「目标已存在」(否则这类改名在这台机器上永远做不成)', r)
  if (process.platform === 'win32' || process.platform === 'darwin') {
    const names = fs.readdirSync(rootOf(pid))
    ok(names.length === 1, '大小写不敏感的文件系统上盘上只剩一份文件', names)
    ok(names[0] === 'foo.gd', '盘上的真实大小写改到了新写法', names)
  } else {
    const names = fs.readdirSync(rootOf(pid)).sort()
    ok(names.join() === 'Foo.gd,foo.gd', '大小写敏感的平台上是两个不同文件:新名建出来了', names)
  }
}

// ---------------------------------------------------------------- 7. 不抛异常红线
section('7. 不抛异常红线:脏入参一律 {ok:false,error}')
{
  const pid = makeProject({ 'a.gd': 'A\n' })
  const dirty = [
    [undefined, 'b.gd'], [null, 'b.gd'], [123, 'b.gd'], [['a'], 'b.gd'], ['', 'b.gd'], [{}, 'b.gd'],
    ['a.gd', undefined], ['a.gd', null], ['a.gd', 42], ['a.gd', ''], ['a.gd', {}], ['a.gd', ['b.gd']]
  ]
  for (const [rel, to] of dirty) {
    const r = RN(pid, rel, to)
    ok(!!r && typeof r === 'object' && r.ok === false && typeof r.error === 'string' && !!r.error,
      `脏入参 (${JSON.stringify(rel)}, ${JSON.stringify(to)}) 回对象带原因,不抛`, r)
  }
  const rOpts = RN(pid, 'a.gd', 'b.gd', 'not-an-object')
  ok(rOpts.ok === true && mv(rOpts).length === 1, 'opts 是字符串 ⇒ 当没给(走默认边车),不抛(与 writeProjectText 的 o = opts || {} 同法)', rOpts)
  ok(RN(undefined, 'a.gd', 'b.gd').error === '项目不存在', 'projectId 是 undefined ⇒ 「项目不存在」不抛')
  ok(RN({}, 'a.gd', 'b.gd').error === '项目不存在', 'projectId 是对象 ⇒ 「项目不存在」不抛')
  ok(listing(pid).join() === 'b.gd', '整组脏入参跑完盘上只有被成功改名那一条', listing(pid))
}

// ---------------------------------------------------------------- 8. 返回形状
section('8. 返回形状:全仓只有 rel,绝对路径与盘符不外泄')
{
  const pid = makeProject({ 'deep/old.gd': 'O\n', 'deep/old.gd.uid': 'uid://d\n' })
  const r = RN(pid, 'deep/old.gd', 'deep/new.gd')
  ok(r.ok === true, '改名成功', r)
  const flat = JSON.stringify(r)
  ok(flat.indexOf(rootOf(pid)) < 0, '回报里没有项目根的绝对路径', flat)
  ok(!/[a-zA-Z]:[\\/]/.test(flat), '回报里没有盘符', flat)
  ok(flat.indexOf('\\') < 0, '回报里没有反斜杠(一律正斜杠 rel)', flat)
  ok(mv(r).every((m) => typeof m.from === 'string' && typeof m.to === 'string' && Object.keys(m).length === 2), 'moved 每项只有 from/to 两个键', mv(r))
  ok(mv(r).length === 2 && mv(r)[1].from === 'deep/old.gd.uid', '边车那一对带目录前缀(不丢路径段)', mv(r))
  ok(r.error === undefined || r.error === '', '成功时不给 error 串(渲染层要能按「有没有 error」判)', r)
}

// ---------------------------------------------------------------- 9. 串一致性
section('9. 与兄弟原语的错误串一致性(同一件事不许有两串说法)')
{
  const pid = makeProject({ 'a.gd': 'A\n' })
  ok(RN('godot/project/ghost', 'a.gd', 'b.gd').error === F.scanProjectTree('godot/project/ghost').error, '「项目不存在」与 scanProjectTree 同一串')
  ok(RN(pid, '../x.gd', 'b.gd').error === F.readProjectText(pid, '../x.gd').error, '「非法路径」与 readProjectText 同一串')
  ok(RN(pid, 'nope.gd', 'b.gd').error === F.readProjectText(pid, 'nope.gd').error, '「文件不存在」与 readProjectText 同一串')
  ok(RN(pid, 'a.gd', 'nodir/b.gd').error === F.writeProjectText(pid, 'nodir/b.gd', 'x').error, '「目标目录不存在」与 writeProjectText 同一串')
}

// ---------------------------------------------------------------- 汇总
console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
console.log(`SKIP ${skips} 项未在本机执行(不计入上面的 PASS;>0 通常是本机没有创建符号链接的权限)`)
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
