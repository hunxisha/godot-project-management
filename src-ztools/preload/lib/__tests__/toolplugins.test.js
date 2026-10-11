// toolplugins.js 回归测试:工具箱用的 3 个**项目外路径**文件系统原语(§5.10 / A-18)。
//
// 为什么不能复用 inspectfs 的那两道闸:那两道闸的语义是「相对**项目根**」,而插件目录在 `~/.gpm-tools/`,
// 在项目之外。把项目根的闸搬过来,要么把插件目录当项目根硬塞(错误串会说「项目不存在」,用户看不懂),
// 要么绕过闸(§6 R-4:骨架生成器就能往任意路径写文件)。所以这里是一条**语义不同的新闸**,
// 判据必须自己完整覆盖 `..` / 绝对路径 / 盘符 / 符号链接 四种(R-4 明写「先写断言再写实现」)。
//
// 与 inspectfs 同形的纪律,一条都不能少:
//   · 原语**不抛异常**,一律 {ok:false,error};
//   · 错误串复用那批('非法路径' / '路径无法解析' / '文件不存在' / '写入失败' / '目标目录不存在'),
//     不新增文案,也不把 realpath 查到的外部真实路径回显给用户;
//   · 批量接口里单条失败**不中断其余**,失败项如实回报;
//   · rel 一律正斜杠、对外只有 rel 一个键,绝对路径由这里拼。
//
// 新增的一条方向性判据:写侧默认**不覆已存在**的文件。骨架生成器撞名时报错,
// 而不是静默把别人写好的插件改一半(那正是「用户装的插件坏了却不知道为什么」的形态)。
//
// 用法:node src-ztools/preload/lib/__tests__/toolplugins.test.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const LIB = path.resolve(__dirname, '..')

let pass = 0
let skips = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
/** 本机跑不了(建符号链接要权限)时**显式 SKIP,不计入 PASS** —— 全绿不等于没测 */
function skipAssert(label, reason) { skips++; console.log(`  SKIP  ${label}${reason ? ' → ' + reason : ''}`) }
function section(t) { console.log(`\n=== ${t} ===`) }

// 桩掉 window.ztools.db:toolsRoot 要读 godot/settings 里的 toolsRoot 配置
const DB = new Map()
global.window = { ztools: { db: { get: (id) => (DB.get(id) ? { ...DB.get(id) } : null) } } }
const P = require(path.join(LIB, 'toolplugins.js'))

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-toolplugins-'))
/** @param {string} rel */
const abs = (rel) => path.join(WORK, rel.replace(/\//g, path.sep))
const put = (rel, text) => {
  const a = abs(rel)
  fs.mkdirSync(path.dirname(a), { recursive: true })
  fs.writeFileSync(a, text, 'utf8')
  return a
}
const putManifest = (id, over) =>
  put(`${id}/manifest.json`, JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, kind: 'action', ui: 'schema', summary: 's', cmds: [id], entry: 'index.js', capabilities: [], ...over }))
const mkdir = (rel) => fs.mkdirSync(abs(rel), { recursive: true })

/** Windows 上建符号链接需要管理员权限或开发者模式:试一次,失败就整节 SKIP */
function trySymlink(target, linkPath, kind) {
  try {
    fs.symlinkSync(target, linkPath, kind)
    return true
  } catch (e) {
    return false
  }
}

console.log(`工作目录:${WORK}`)

section('0. 导出面')
for (const n of ['toolsRoot', 'listToolPlugins', 'readToolPlugin', 'writeToolPlugin', 'resolveToolPath']) {
  ok(typeof P[n] === 'function', `${n} 是函数`)
}

section('1. toolsRoot:可配置 + 有默认值(形状照 docpaths.js:34)')
{
  DB.delete('godot/settings')
  const home = os.homedir()
  const d0 = P.toolsRoot()
  ok(d0.ok === true, '没有设置时也给出目录', d0.error)
  ok(d0.dir === path.join(home, '.gpm-tools'), '缺省是 ~/.gpm-tools', d0.dir)
  ok(path.isAbsolute(d0.dir), '给出的永远是绝对路径')

  DB.set('godot/settings', { toolsRoot: WORK })
  ok(P.toolsRoot().dir === WORK, '设置里的绝对路径直接用(用户可改,Q11=A + 追加需求)', P.toolsRoot().dir)

  DB.set('godot/settings', { toolsRoot: '   ' })
  ok(P.toolsRoot().dir === path.join(home, '.gpm-tools'), '只有空白 ⇒ 退回默认值,而不是把空串当目录')

  DB.set('godot/settings', { toolsRoot: 'relative/dir' })
  const rel = P.toolsRoot()
  ok(rel.ok === false && rel.error.includes('绝对'), '相对路径配置**拒用**:相对路径会随 cwd 漂,变成往未知目录写', rel.error)

  DB.set('godot/settings', { toolsRoot: 42 })
  ok(P.toolsRoot().ok === false, '非字符串配置拒用(而不是 String(42) 当成目录名)')

  DB.set('godot/settings', { toolsRoot: WORK + path.sep })
  ok(P.toolsRoot().dir === WORK, '尾巴分隔符归一掉(否则拼出来的路径会出现双分隔符)')

  DB.set('godot/settings', { toolsRoot: 'D:\\no\\such\\dir\\gpm-test' })
  const nd = P.toolsRoot()
  ok(nd.ok === true && nd.dir.length > 0, '不存在的目录在 toolsRoot 阶段仍然给出(创建是 list 的事)', nd)

  DB.delete('godot/settings')
}

section('2. resolveToolPath:字面闸四种坏形态(A-18 前三类)')
{
  const R = (rel) => P.resolveToolPath(WORK, rel)
  // resolveToolPath 的合同是 **string | null**(照 resolveRel 的用法形态),不是 {ok,error};
  // 所以它不进 §7 那圈「原语一律给 {ok,…} 形状」的循环 —— 那是两种合同,别混着断言。
  for (const junk of [undefined, null, 42, {}]) {
    let threw = null
    let got = null
    try { got = P.resolveToolPath(junk, 'a/b.js') } catch (e) { threw = e }
    ok(threw === null && got === null, `坏根(${JSON.stringify(junk) ?? String(junk)}) ⇒ null 且不抛`, String(threw))
  }
  ok(R('a/manifest.json') !== null, '正常相对路径给绝对路径')
  ok(R('./a/b.js') !== null && R('a/./b.js') !== null && R('a//b.js') !== null, '`.` 段与空段吃掉(与 resolveRel 同形)')
  for (const bad of ['../evil.js', 'a/../../evil.js', '..', '/', '/etc/passwd', 'C:\\Windows\\x.js', 'C:/x.js', 'c:/x.js', '']) {
    ok(R(bad) === null, `越界/绝对/盘符/空 ⇒ null:${JSON.stringify(bad)}`)
  }
  for (const bad of [undefined, null, 42, {}, ['a']]) {
    ok(R(bad) === null, `非字符串 ⇒ null 且不抛(${JSON.stringify(bad) ?? String(bad)})`)
  }
  ok(R('a\\b.js') !== null, '反斜杠归正斜杠(Windows 作者手写路径形态)')
}

section('3. listToolPlugins:目录不存在要创建,且失败要说得出原因')
{
  const dir = path.join(WORK, 'fresh-' + Date.now())
  const r = P.listToolPlugins(dir)
  ok(r.ok === true, '空目录(还不存在)⇒ 创建并给出空清单', r.error)
  ok(fs.existsSync(dir), '目录真被建出来了(§D #2:不存在时能否创建)')
  ok(Array.isArray(r.entries) && r.entries.length === 0, 'entries 是空数组,不是 undefined', r.entries)
  ok(r.created === true, '回报里标出「这次是刚建的」(UI 可以第一次提示权限面)')
  ok(r.dir === dir, '回显的 dir 就是解析后的绝对路径')

  // 建不出来的目录:拿一个**已存在的文件**当父路径(mkdir 必然 ENOTDIR),
  // 而不是赌「D:\no\such 不存在」—— 那台机器上要真能建,断言就假绿了。
  put('a/manifest.json', '{}')
  const doomed = path.join(abs('a/manifest.json'), 'sub')
  const bad = P.listToolPlugins(doomed)
  ok(bad.ok === false && typeof bad.error === 'string' && bad.error.length > 0,
    '建不出来的目录 ⇒ ok:false + 原因,**不是静默空列表**(§D #2 要的正是这条)', bad)
  ok(bad.ok === false && bad.entries.length === 0, '失败时 entries 仍是空数组(UI 不必判两种形状)', bad.entries)

  put('a/manifest.json', '{}')
  const notDir = P.listToolPlugins(abs('a/manifest.json'))
  ok(notDir.ok === false, '路径指向一个文件 ⇒ 拒,不当目录列', notDir.error)
}

section('4. listToolPlugins:条目形状与逐个隔离')
{
  const base = path.join(WORK, 'scan-' + Date.now())
  mkdir('scan-x'); fs.mkdirSync(base, { recursive: true })
  const inBase = (rel, text) => { const a = path.join(base, rel.split('/').join(path.sep)); fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, text, 'utf8'); return a }
  inBase('good/manifest.json', JSON.stringify({ id: 'good', name: 'G', apiVersion: 1, kind: 'action', ui: 'schema', summary: 's', cmds: ['g'], entry: 'index.js', capabilities: [] }))
  inBase('good/index.js', 'export const schema = []\n')
  inBase('good/lib/util.js', 'x')
  inBase('nomanifest/index.js', '没有 manifest')
  inBase('brokenjson/manifest.json', '{ 这不是 JSON')
  inBase('toobig/manifest.json', JSON.stringify({ id: 'toobig', pad: 'x'.repeat(300 * 1024) }))
  inBase('subdirs/manifest.json', '{}')
  inBase('subdirs/node_modules/pkg/i.js', 'x')
  fs.writeFileSync(path.join(base, 'a-plain-file.txt'), '不是目录', 'utf8')

  const r = P.listToolPlugins(base)
  ok(r.ok === true, '扫描成功', r.error)
  const names = r.entries.map((e) => e.name)
  ok(names.indexOf('a-plain-file.txt') < 0, '只列目录:根下的普通文件不算插件', names)
  ok(names.length === 5, '五个子目录全进清单(坏的那个也在,自己带 error)', names)
  ok(names.join(',') === names.slice().sort().join(','), '顺序按目录名升序(清单要稳定,不然每次扫都重排)')

  const good = r.entries.find((e) => e.name === 'good')
  ok(good && good.error === undefined, '好条目不带 error', good && good.error)
  ok(typeof good.manifestText === 'string' && JSON.parse(good.manifestText).id === 'good', '给 manifest **原文**,解析交给渲染层(本层不懂 schema)', good.manifestText && good.manifestText.slice(0, 40))
  ok(good.files.includes('index.js') && good.files.includes('lib/util.js'), 'files 是正斜杠相对路径,含子目录里的文件', good.files)
  ok(good.files.join(',') === good.files.slice().sort().join(','), 'files 也保序(确定性纪律)', good.files)
  ok(!good.files.some((f) => f.startsWith('/') || f.includes('..')), 'files 里没有绝对路径或 ..', good.files)

  const noM = r.entries.find((e) => e.name === 'nomanifest')
  ok(noM && typeof noM.error === 'string' && noM.error.length > 0, '缺 manifest.json ⇒ 该条目带 error(不是整批失败)', noM)
  ok(noM && noM.manifestText === '', '坏条目的 manifestText 是空串,不是 undefined', noM && noM.manifestText)

  const badJson = r.entries.find((e) => e.name === 'brokenjson')
  ok(badJson && badJson.error.includes('JSON'), 'manifest 不是合法 JSON ⇒ 原因点名 JSON', badJson && badJson.error)

  const big = r.entries.find((e) => e.name === 'toobig')
  ok(big && big.error.includes('过大'), '超大 manifest ⇒ 拒读并说明「过大」(不给半截内容去解析)', big && big.error)

  const sub = r.entries.find((e) => e.name === 'subdirs')
  ok(sub && !sub.files.some((f) => f.indexOf('node_modules') >= 0), 'node_modules 这类依赖目录不进 files(清单会涨到几千行)', sub && sub.files)
}

section('5. readToolPlugin:符号链接是这里唯一能挡的绕过(A-18 第四类)')
{
  const base = path.join(WORK, 'read-' + Date.now())
  fs.mkdirSync(path.join(base, 'pl', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(base, 'pl', 'index.js'), 'export const schema = []', 'utf8')
  fs.writeFileSync(path.join(base, 'pl', 'empty.js'), '', 'utf8')
  fs.writeFileSync(path.join(base, 'secret.bin'), Buffer.from([0x2f, 0x2f, 0x00, 0x00, 0x61]))
  fs.writeFileSync(path.join(base, 'pl', 'big.js'), 'a'.repeat(2000), 'utf8')

  const r = P.readToolPlugin(base, 'pl', 'index.js')
  ok(r.ok === true && r.text === 'export const schema = []', '正常读回 utf8 正文', r)
  ok(typeof r.bytes === 'number', 'bytes 是刚读进来的字节数', r.bytes)
  ok(r.truncated === false && r.skippedBinary === false, '两个标记都假')

  const e = P.readToolPlugin(base, 'pl', 'empty.js')
  ok(e.ok === true && e.text === '', '空文件读到空串(不是 error)', e)

  const bin = P.readToolPlugin(base, 'pl', '../../secret.bin')
  ok(bin.ok === false && bin.error === '非法路径', '用 .. 跳出插件目录 ⇒ 拒(读也是动物件的外面那一层)', bin)

  const ab = P.readToolPlugin(base, 'pl', path.join(base, 'secret.bin'))
  ok(ab.ok === false, '给绝对路径 ⇒ 拒', ab.error)

  const drv = P.readToolPlugin(base, 'pl', 'C:/Windows/win.ini')
  ok(drv.ok === false, '给盘符路径 ⇒ 拒', drv.error)

  const miss = P.readToolPlugin(base, 'pl', 'nope.js')
  ok(miss.ok === false && miss.error === '文件不存在', '不存在 ⇒ 「文件不存在」,复用旧文案', miss)

  const noDir = P.readToolPlugin(base, 'ghost', 'index.js')
  ok(noDir.ok === false && typeof noDir.error === 'string', '插件目录不存在 ⇒ 有原因,不抛', noDir)

  const badRel = P.readToolPlugin(base, 'pl', undefined)
  ok(badRel.ok === false && badRel.error === '非法路径', 'rel 非字符串 ⇒ 「非法路径」不抛', badRel)

  const badPlugin = P.readToolPlugin(base, '..', 'index.js')
  ok(badPlugin.ok === false, 'pluginDir 本身带 .. ⇒ 拒(它必须是工具目录下的**一层**子目录)', badPlugin.error)
  const badPlugin2 = P.readToolPlugin(base, 'a/b', 'index.js')
  ok(badPlugin2.ok === false, 'pluginDir 带路径分隔符 ⇒ 拒', badPlugin2.error)
  const badPlugin3 = P.readToolPlugin(base, 'C:/x', 'index.js')
  ok(badPlugin3.ok === false, 'pluginDir 带盘符 ⇒ 拒', badPlugin3.error)

  // 超限:与 readProjectText 同形,只报 truncated 不给内容
  const big = P.readToolPlugin(base, 'pl', 'big.js', { maxBytes: 1000 })
  ok(big.ok === true && big.truncated === true && big.bytes === 2000 && big.text === undefined,
    '超 maxBytes ⇒ truncated + bytes,不返回内容', big)

  // 二进制:前 512 字节含 NUL ⇒ skippedBinary
  fs.copyFileSync(path.join(base, 'secret.bin'), path.join(base, 'pl', 'blob.bin'))
  const blob = P.readToolPlugin(base, 'pl', 'blob.bin')
  ok(blob.ok === true && blob.skippedBinary === true && blob.text === undefined, '含 NUL ⇒ skippedBinary 不给正文(与旧原语同口径)', blob)

  // 符号链接:插件目录内一条指向外部的链接,字面闸看不出来,只有 realpath 闸能挡
  const linkRel = path.join(base, 'pl', 'escape.js')
  const made = trySymlink(path.join(base, 'secret.bin'), linkRel, 'file')
  if (!made) {
    skipAssert('插件目录内指向外部的符号链接被拒', '本机无权建符号链接(Windows 需开发者模式/管理员)')
    skipAssert('目录级符号链接的插件条目被排除', '同上')
  } else {
    const linkRead = P.readToolPlugin(base, 'pl', 'escape.js')
    ok(linkRead.ok === false && linkRead.error === '非法路径', '插件目录内指向外部的符号链接 ⇒ 拒(realpath 真实落点闸)', linkRead)
    const dirLink = path.join(base, 'linked')
    const madeDir = trySymlink(path.join(base, 'pl'), dirLink, 'dir')
    if (madeDir) {
      const scan = P.listToolPlugins(base)
      const names = scan.entries.map((x) => x.name)
      ok(!names.includes('linked'), '链接目录不进插件清单(方向是少动:宁可少列,不去跟随别人指到哪就扫哪)', names)
    } else {
      skipAssert('目录级符号链接的插件条目被排除', '本机无权建目录符号链接')
    }
  }
}

section('5b. junction(目录联结):这台机器**不需要管理员权限**就能建,所以 A-18 第四类在这儿真验')
{
  // 前面那节的 fs.symlinkSync 在这台机器上 EPERM(Windows 的文件符号链接要开发者模式),
  // 于是三条断言只能 SKIP —— 但**目录联结(junction)是 reparse point,普通权限就能建**,
  // 而 readdirSync(withFileTypes) 对它的 isSymbolicLink() 返回 true(本机实测)。
  // 所以「插件目录通向外面」这条真实攻击形态可以在这里验掉,只把文件级链接留给真机清单。
  const base = path.join(WORK, 'jct-' + Date.now())
  // outside 必须在工具目录**之外**:realpath 闸的判据是「真实落点还在根内没有」,
  // 把链接目标放在根里面会让这条断言恒真(我第一版就是这么写的,验了个空气)。
  const outside = path.join(WORK, 'jct-outside-' + Date.now())
  fs.mkdirSync(path.join(outside, 'inner'), { recursive: true })
  fs.writeFileSync(path.join(outside, 'victim.js'), '原始内容', 'utf8')
  fs.writeFileSync(path.join(outside, 'manifest.json'), '{"id":"smoke"}', 'utf8')
  fs.mkdirSync(base, { recursive: true })

  let made = false
  try {
    fs.symlinkSync(outside, path.join(base, 'jct'), 'junction')
    made = true
  } catch (e) {
    made = false
  }
  if (!made) {
    skipAssert('junction 指向外部的目录不被当插件列出', '本机连 junction 也建不出来')
  } else {
    ok(fs.lstatSync(path.join(base, 'jct')).isSymbolicLink(), '先证明这个 junction 在 lstat 眼里确实是链接(否则下面三条是在验空气)')

    const scan = P.listToolPlugins(base)
    const names = scan.entries.map((x) => x.name)
    ok(!names.includes('jct'), 'junction 目录不进插件清单:不跟随别人指到哪就扫哪', names)

    const r = P.readToolPlugin(base, 'jct', 'victim.js')
    ok(r.ok === false && r.error === '非法路径', '从 junction 读外面的文件 ⇒ 拒(realpath 真实落点闸)', r)

    const w = P.writeToolPlugin(base, 'jct', [{ rel: 'planted.js', text: 'x' }])
    ok(w.ok === false, '往 junction 目录里写 ⇒ 整批拒(骨架生成器不能借链接落到任意路径)', w.error)
    ok(!fs.existsSync(path.join(outside, 'planted.js')), '外面那个目录里没长出文件', fs.existsSync(path.join(outside, 'planted.js')))
    ok(fs.readFileSync(path.join(outside, 'victim.js'), 'utf8') === '原始内容', '外面那个文件内容一字未改')

    // 配套:同一份 junction 下面**真有**插件目录时,合法那条仍然要能扫出来(证明不是整目录被误拒)
    fs.mkdirSync(path.join(base, 'real'), { recursive: true })
    fs.writeFileSync(path.join(base, 'real', 'manifest.json'), JSON.stringify({ id: 'real', name: 'R', apiVersion: 1, kind: 'action', ui: 'schema', summary: 's', cmds: ['r'], entry: 'index.js', capabilities: [] }), 'utf8')
    const scan2 = P.listToolPlugins(base)
    ok(scan2.entries.map((x) => x.name).includes('real'), '真目录照样列出来(排除的只有链接,不是整个工具目录)', scan2.entries.map((x) => x.name))
  }
}

section('6. writeToolPlugin:骨架生成器的落点(§A / A-17 的地基)')
{
  const base = path.join(WORK, 'write-' + Date.now())
  const w = (pluginDir, files, opts) => P.writeToolPlugin(base, pluginDir, files, opts)

  const okWrite = w('newtool', [
    { rel: 'manifest.json', text: '{"id":"newtool"}' },
    { rel: 'lib/util.js', text: 'x' }
  ])
  ok(okWrite.ok === true, '新建插件目录并写两个文件', okWrite.error)
  ok(fs.existsSync(path.join(base, 'newtool', 'manifest.json')), 'manifest 真落盘')
  ok(fs.existsSync(path.join(base, 'newtool', 'lib', 'util.js')), '子目录被创建(骨架带 lib/ 是常态)')
  ok(okWrite.written.join(',') === 'manifest.json,lib/util.js', 'written 按给出顺序回报', okWrite.written)
  ok(okWrite.dir === path.join(base, 'newtool'), '回报插件目录的绝对路径(UI 的「打开目录」要用)', okWrite.dir)

  const again = w('newtool', [{ rel: 'manifest.json', text: '覆一下' }])
  ok(again.ok === false, '同名文件默认**不覆**(撞名要报错,不能静默把别人的插件改一半)', again.error)
  ok(again.failed.length === 1 && again.failed[0].error.includes('已存在'), '失败原因点名「已存在」', again.failed)
  ok(fs.readFileSync(path.join(base, 'newtool', 'manifest.json'), 'utf8') === '{"id":"newtool"}', '盘上内容一字未改', fs.readFileSync(path.join(base, 'newtool', 'manifest.json'), 'utf8'))

  const forced = w('newtool', [{ rel: 'manifest.json', text: '{"id":"newtool","v":2}' }], { overwrite: true })
  ok(forced.ok === true && fs.readFileSync(path.join(base, 'newtool', 'manifest.json'), 'utf8').includes('"v":2'),
    '显式 overwrite:true 才覆(升级自己写的骨架是合法场景)', forced)

  // 越界四类
  const esc = w('pl2', [{ rel: '../escape.js', text: 'x' }, { rel: 'ok.js', text: 'y' }])
  ok(esc.ok === false && esc.failed.length === 1 && esc.failed[0].rel === '../escape.js',
    '`..` 那一项被拒,**其余那条照写**(单条失败不中断其余)', esc)
  ok(fs.existsSync(path.join(base, 'pl2', 'ok.js')), '没越界的那条真落盘', fs.existsSync(path.join(base, 'pl2', 'ok.js')))
  ok(!fs.existsSync(path.join(base, 'escape.js')), '越界那条没在父目录长出来', fs.existsSync(path.join(base, 'escape.js')))
  ok(esc.failed[0].error === '非法路径', '错误串复用旧文案,不新造', esc.failed[0])

  const absw = w('pl3', [{ rel: path.join(base, 'abs.js'), text: 'x' }])
  ok(absw.ok === false, '绝对路径 ⇒ 拒', absw.failed)
  const drvw = w('pl4', [{ rel: 'C:/Windows/x.js', text: 'x' }])
  ok(drvw.ok === false, '盘符 ⇒ 拒', drvw.failed)
  const nul = w('pl5', [{ rel: 'a/../../b.js', text: 'x' }])
  ok(nul.ok === false, '多段 .. 往上跳 ⇒ 拒', nul.failed)

  // pluginDir 自己不合格
  for (const bad of ['..', 'a/b', 'C:/x', '../evil', '', ' ', 'a\\b', '.']) {
    const r = w(bad, [{ rel: 'x.js', text: 'x' }])
    ok(r.ok === false && r.written.length === 0, `非法 pluginDir 整批拒:${JSON.stringify(bad)}`, r.error)
  }

  // 空清单 / 脏元素
  ok(w('pl6', []).ok === false, '空 files ⇒ 拒(骨架生成器不该静默建个空目录)')
  const dirty = w('pl7', [{ rel: 'a.js' }, { text: 'b' }, null, { rel: 'ok.js', text: 'y' }])
  ok(dirty.ok === false, '脏元素 ⇒ 有失败回报', dirty.failed)
  ok(dirty.failed.length === 3, '三个坏元素各报一条', dirty.failed)
  ok(fs.existsSync(path.join(base, 'pl7', 'ok.js')), '好的那条仍然写成(单条失败不中断)', fs.existsSync(path.join(base, 'pl7', 'ok.js')))

  // text 非字符串一律拒(不能把 undefined 写进文件)
  const notText = w('pl8', [{ rel: 'x.js', text: undefined }])
  ok(notText.ok === false && notText.written.length === 0, 'text 是 undefined ⇒ 拒写(与 orchestrate 同一条教训)', notText)

  // 符号链接:目录级链接指向外面 ⇒ 写侧必须拒
  const outside = path.join(base, 'outside-target')
  fs.mkdirSync(outside, { recursive: true })
  const linkedDir = path.join(base, 'linkeddir')
  const madeLink = trySymlink(outside, linkedDir, 'dir')
  if (!madeLink) {
    skipAssert('写进指向外部的链接目录被拒', '本机无权建目录符号链接')
  } else {
    const intoLink = w('linkeddir', [{ rel: 'x.js', text: 'x' }])
    ok(intoLink.ok === false, 'pluginDir 是通向外部目录的符号链接 ⇒ 拒写(真实落点闸)', intoLink)
    ok(!fs.existsSync(path.join(outside, 'x.js')), '外面那个目录里没长出文件', fs.existsSync(path.join(outside, 'x.js')))
    const fileLink = path.join(base, 'newtool', 'link.js')
    if (trySymlink(outside, fileLink, 'file')) {
      const over = w('newtool', [{ rel: 'link.js', text: '覆它' }], { overwrite: true })
      ok(over.ok === false || !fs.existsSync(path.join(outside)), '覆写一个通向外部的链接文件 ⇒ 拒(否则改的是别人家的文件)', over)
    } else {
      skipAssert('覆写通向外部的链接文件被拒', '本机无权建文件符号链接')
    }
  }
}

section('7. 不抛异常红线')
{
  const cases = [
    () => P.toolsRoot(),
    () => P.listToolPlugins(undefined),
    () => P.listToolPlugins(42),
    () => P.listToolPlugins(null),
    () => P.readToolPlugin(undefined, undefined, undefined),
    () => P.writeToolPlugin(undefined, undefined, undefined)
  ]
  for (const [i, fn] of cases.entries()) {
    let threw = null
    let res = null
    try { res = fn() } catch (e) { threw = e }
    ok(threw === null, `第 ${i + 1} 组脏入参不抛异常`, threw && String(threw.message))
    if (threw === null) {
      ok(res !== null && typeof res === 'object' && (res.ok === false || res.ok === true), `第 ${i + 1} 组给出 {ok,…} 形状,不是 null/undefined`, res)
      if (res && typeof res === 'object' && 'error' in res) ok(typeof res.error === 'string', `第 ${i + 1} 组的 error 是字符串(空串也算说过)`, res.error)
    }
  }
}

try { fs.rmSync(WORK, { recursive: true, force: true }) } catch (e) { /* 临时目录清不掉不影响结论 */ }

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}${skips ? `  SKIP ${skips}` : ''}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
