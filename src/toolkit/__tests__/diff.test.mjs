// 工具箱 · 第 1 批 Task 3:行级 LCS diff(src/toolkit/diff.ts)的断言。
//
// §7 A-9 是全批**唯一在验收条款里点名要变异取证**的一条:「把 LCS 换成朴素逐行比对要红」。
// 所以这里的关键夹具都是「行会错位」的形态 —— 朴素 zip 逐行比对这些输入会说出完全不同的话,
// 而 LCS 要说得出「第 3 行是插入的、第 1 与第 2 行没动」。
// 只测「改一个字符」那种输入是测不出 LCS 的:zip 与 LCS 在那种场合结论相同,断言就成了没牙的。
//
// 另一组钉的是 DEV-9 的退化路径与 DEV-8 的「diff 只是预览,不是判据」:
// 大文件不许冻界面,但退化必须**看得见**,且退化时 added/removed/行数这些事实照样要说得出。
//
// 用法:node src/composables/__tests__/build-bundle.mjs && node src/toolkit/__tests__/diff.test.mjs
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tkdiff.mjs')

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const T = await import(pathToFileURL(BUNDLE).href)

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }

const L = (d, i) => F(FA(F(d).lines)[i])
const F = (x) => (x && typeof x === 'object' ? x : {})
/** 把第 i 个块读成一组标量:块不存在时全给「没有」的值,断言红一条而不是撞停 */
const H = (arr, i) => {
  const x = F(arr[i])
  const ls = FA(x.lines)
  return { so: N(x.startOld), sn: N(x.startNew), n: ls.length, ops: ls.map((l) => F(l).op[0]).join('') }
}
const FA = (x) => (Array.isArray(x) ? x : [])
const N = (x) => (typeof x === 'number' ? x : -1)
const S = (x) => (typeof x === 'string' ? x : '')
const cnt = (d) => ({
  same: FA(F(d).lines).filter((x) => F(x).op === 'same').length,
  del: FA(F(d).lines).filter((x) => F(x).op === 'del').length,
  add: FA(F(d).lines).filter((x) => F(x).op === 'add').length
})
const ops = (d) => FA(F(d).lines).map((x) => F(x).op[0]).join('')
const txt = (d) => d.lines.map((x) => x.text).join('|')

section('0b. 产物与源码同步(本批被 stale bundle 咬过两轮)')
{
  // 为什么要这一节:变异脚本改完源码若忘了重打 bundle,断言跑的就是旧产物 —— 绿是假的
  // (第 0 批 Task 3 栽过,本批 Task 2 的诊断脚本又栽一次)。
  // ⚠ 探针只能拿**改名免疫**的东西:esbuild 会把循环变量 i/j 改写成 i2/j2,
  //   所以拿源码里的整句去 bundle 里找是错的判据(实测就是这么假红一次)。
  //   字符串字面量与导出常量才会原样进产物,它们才是可靠的「产物==源码」证据。
  const src = readFileSync(path.resolve(ROOT, 'src', 'toolkit', 'diff.ts'), 'utf8')
  const out = readFileSync(BUNDLE, 'utf8')
  // 只拿**字符串字面量**做同步探针:标识符会被改名(i→i2),数字会被改写成 4e6,
  // 而 `同进同出` 的判据能同时抓住「源码改了产物没重打」与「产物被旧变异污染」两个方向。
  for (const lit of ['差异过大,未逐行比对', '没有可比对的差异', '无变化']) {
    // 同进同出:源码有这句措辞 ⇔ 产物也有 —— 不一致就说明产物是旧的
    ok(src.includes(lit) === out.includes(lit),
      `措辞「${lit}」在源码与产物里同进同出(不同步就是吃了旧 bundle)`,
      { src: src.includes(lit), out: out.includes(lit) })
  }
  ok(T.MAX_LCS_CELLS === 4000000,
    '预算值从**产物**里读出来仍是 4000000(esbuild 把 4_000_000 改写成 4e6,所以数字也不能拿文本比)',
    T.MAX_LCS_CELLS)
  // ⚠ 上面这条刻意用「同进同出」而不是「产物里必须有」:esbuild 会把作用域冲突的循环变量
  //   i/j 改写成 i2/j2,拿源码整句去产物里找是错的判据(我这样假红过一轮)。字面量不受改名影响。
  // 标识符级的判据只对源码成立,别拿去查产物
  ok(src.includes('let prev = changed[0]'), '源码里 hunks 的 prev 从第一个改动行起算')
  ok(!src.includes('let prev = 0'), '源码里不再把 prev 初始化成 0(实测抓到的那处并块误切)')
  ok(!src.includes('prevPrevEnd'), '源码里没有未定义的 prevPrevEnd 残留')
  // perf 基准不许被挂进常规测试链(第 0 批被删的 perf.test.mjs 的同一约定)
  const pkg = JSON.parse(readFileSync(path.resolve(ROOT, 'package.json'), 'utf8'))
  ok(!(pkg.scripts.test || '').includes('diff.perf'), 'npm test 里没有 diff.perf.mjs(opt-in 约定守得住)')
  ok(!(pkg.scripts['test:renderer'] || '').includes('diff.perf'), 'test:renderer 里没有 diff.perf.mjs')
  ok((pkg.scripts['test:perf'] || '').includes('diff.perf.mjs'), 'test:perf 这条单列的脚本还在')
}

section('0. 导出面')

for (const n of ['diffText', 'hunks', 'diffStat', 'renamePairs', 'MAX_LCS_CELLS']) ok(T[n] !== undefined, `${n} 已导出`)
ok(T.MAX_LCS_CELLS === 4000000, '预算是 4_000_000 格(20k 行 × 20k 行会算 4 亿格把界面冻死)', T.MAX_LCS_CELLS)

section('1. 完全相同:identical 为真,零增删,行号两侧一致')
{
  const d = T.diffText('a\nb\nc', 'a\nb\nc')
  ok(d.identical === true, 'identical=true')
  ok(d.degraded === false, 'degraded=false')
  ok(d.added === 0 && d.removed === 0, '零增删', d)
  ok(ops(d) === 'sss', '三行全 same', ops(d))
  ok(L(d, 1).oldNo === 2 && L(d, 1).newNo === 2, '两侧行号一致(格式化报告里最不该出错的一件事)', L(d, 1))
  ok(T.diffStat(d) === '无变化', '摘要说「无变化」而不是「+0 -0」', T.diffStat(d))
  ok(T.hunks(d.lines).length === 0, '没有改动 ⇒ 零个块', T.hunks(d.lines))
}

section('2. 朴素逐行比对在这三组上会说错话(A-9 的主战场)')
{
  // ① 中间插一行:zip 会把从第 2 行起**全部**判成改动
  const ins = T.diffText('a\nb\nc', 'a\nX\nb\nc')
  ok(cnt(ins).same === 3, '插入一行时,原有三行仍然都算 unchanged(zip 会说只有 1 行没变)', cnt(ins))
  ok(ops(ins) === 'sass', '逐行来路是 same/add/same/same', ops(ins))
  ok(L(ins, 1).op === 'add' && L(ins, 1).newNo === 2 && L(ins, 1).oldNo === null, '插入行只有新行号,旧行号是 null', L(ins, 1))
  ok(L(ins, 2).text === 'b' && L(ins, 2).oldNo === 2 && L(ins, 2).newNo === 3, '原来的 b 挪到新第 3 行:两个行号都要给且不相等', L(ins, 2))
  ok(ins.added === 1 && ins.removed === 0, '统计只算中间差异段:加 1 删 0', ins)

  // ② 删一行:zip 会把尾巴全判成删
  const del = T.diffText('a\nb\nc\nd', 'a\nc\nd')
  ok(cnt(del).same === 3, '删一行时其余三行仍 unchanged', cnt(del))
  ok(ops(del) === 'sdss', '逐行来路 same/del/same/same', ops(del))
  ok(L(del, 1).op === 'del' && L(del, 1).oldNo === 2 && L(del, 1).newNo === null, '被删的行只给旧行号', L(del, 1))
  ok(del.added === 0 && del.removed === 1, '加 0 删 1', del)

  // ③ 交错改动:zip 会说「第 2、3、4 行都变了」,而真实只有 b→B 与 d→D 两处改写。
  //    LCS 数出来的 add/del 各 2 —— 这就是为什么统计必须按 emit 出来的 op 数,
  //    不能拿「中间差异段的行数」充数(中间段是 3 行,报 +3 -3 就是虚报)。
  const mix = T.diffText('a\nb\nc\nd', 'a\nB\nc\nD')
  ok(cnt(mix).same === 2, 'a 与 c 没动(按位置比会把 b/d 也算进「相同」以外的桶)', cnt(mix))
  ok(mix.added === 2 && mix.removed === 2, '两处改写:加 2 删 2(不是中间段的 3 行)', mix)
  ok(T.diffStat(mix) === '+2 -2', '摘要就是 +2 -2', T.diffStat(mix))
  ok(ops(mix) === 'sadsad', '来路序列:两处改写各出一对 add/del(实测是 add 在前 —— 平局由回溯规则定,这里只钉形状不承诺谁在前)', ops(mix))
}

section('3. 首尾公共段被剥掉,但仍要画出来(UI 要有上下文)')
{
  const d = T.diffText('h1\nh2\ngone\nh3', 'h1\nh2\nh3')
  ok(L(d, 0).op === 'same' && L(d, 0).oldNo === 1 && L(d, 0).newNo === 1, '开头两行的上下文照样进 lines', L(d, 0))
  ok(L(d, 1).text === 'h2', '第二段上下文是真的 h2', L(d, 1).text)
  ok(L(d, 2).op === 'del' && L(d, 2).text === 'gone', '中间那条删除被认出来', L(d, 2))
  ok(L(d, 3).op === 'same' && L(d, 3).oldNo === 4 && L(d, 3).newNo === 3, '结尾的 h3:旧 4 行 → 新 3 行(行号位移是真的,不是漏行)', L(d, 3))
  ok(d.added === 0 && d.removed === 1, '统计只数中间差异段(前后缀不计),所以格式化「只动 1 行」就报 1', d)
}

section('4. 两端都是空 / 只有一端是空')
{
  const ee = T.diffText('', '')
  ok(ee.identical === true && ee.lines.length === 0 && ee.oldCount === 0 && ee.newCount === 0, '空对空:零行、identical、不臆造出一行空行', ee)
  ok(ee.lines.length === 0, 'lines 是空数组(不是「一行长度为 0 的记录」)', ee.lines)

  const addOnly = T.diffText('', 'a\nb')
  ok(ops(addOnly) === 'aa' && addOnly.added === 2 && addOnly.removed === 0, '空文件变成两行:全是 add', addOnly)
  ok(L(addOnly, 0).oldNo === null && L(addOnly, 0).newNo === 1, 'add 行没有旧行号', L(addOnly, 0))

  const delOnly = T.diffText('a\nb', '')
  ok(ops(delOnly) === 'dd' && delOnly.removed === 2 && delOnly.added === 0, '两行变空:全是 del', delOnly)
  ok(L(delOnly, 1).oldNo === 2, 'del 行保留旧行号', L(delOnly, 1))

  const single = T.diffText('x', 'x')
  ok(single.identical === true && single.lines.length === 1 && L(single, 0).text === 'x', '单行且相同:一行 same,不是零行', single)

  // CRLF:宿主读回来的文本带 \r,按 `\n` 切就带尾随 \r —— 与 parsers/gdScript.ts 同一口径,不在这里发明第二套
  const crlf = T.diffText('a\r\nb', 'a\r\nB')
  ok(crlf.added === 1 && crlf.removed === 1, 'CRLF 文本按 \\n 切行仍能认出那一行被改', crlf)
  ok(L(crlf, 0).op === 'same' && L(crlf, 0).text === 'a\r', '第一行带尾随 \\r 原样进 lines(行切分只按 \\n 的证明)', L(crlf, 0).text)
}

section('5. 入参宽容:非字符串一律当空文本,不抛异常')
{
  for (const v of [undefined, null, 42, {}, ['a']]) {
    const d = T.diffText(v, v)
    ok(d && d.identical === true && d.lines.length === 0, `${JSON.stringify(v) ?? String(v)} 对自己是 identical 且零行`, d)
  }
  const d = T.diffText(undefined, 'a')
  ok(d.added === 1 && d.oldCount === 0, 'undefined 对 "a" ⇒ 当作空文本再比,不抛', d)
  ok(T.diffText(null, null).degraded === false, '非字符串不会误触退化路径')
}

section('6. 退化路径(DEV-9):超预算就不逐行比,但事实照说')
{
  const oldT = Array.from({ length: 50 }, (_, i) => `o${i}`).join('\n')
  const newT = Array.from({ length: 40 }, (_, i) => `n${i}`).join('\n')
  const d = T.diffText(oldT, newT, 100)
  ok(d.degraded === true, '50×40 > 100 格 ⇒ 退化')
  ok(d.lines.length === 0, '退化时不给逐行结果(给半截比不给更坏)', d.lines.length)
  ok(d.identical === false, '退化不等于「没变化」')
  ok(d.oldCount === 50 && d.newCount === 40, '两侧总行数仍是事实', d)
  ok(d.added === 40 && d.removed === 50, '中间差异段的增删行数照算(前后缀剥完之后是整段)', d)
  ok(S(T.diffStat(d)).includes('未逐行比对') && S(T.diffStat(d)).includes('50') && S(T.diffStat(d)).includes('40'),
    '摘要明说「未逐行比对」并给出行数:UI 不许把退化伪装成一份干净 diff', T.diffStat(d))

  // 没超预算时绝不能误触退化:同尺寸、预算给足
  const fine = T.diffText(oldT, oldT.replace('o7', 'X7'), 100000)
  ok(fine.degraded === false && fine.added === 1 && fine.removed === 1, '预算充足时走真 LCS,不误触退化', fine)

  // 前后缀剥离让退化很难被触发:500 行里只改中间 1 行,中间段只有 2 行
  const big = Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n')
  const big2 = big.replace('l250', 'CHANGED')
  const d2 = T.diffText(big, big2, 16)
  ok(d2.degraded === false, '500 行改 1 行:剥完前后缀只剩 2×2 格,预算 16 也够(这一步才是大文件不卡的原因)', d2)
  ok(d2.added === 1 && d2.removed === 1, '巨型文件上的单行改动仍然报 +1 -1', d2)

  // maxCells=0 是「一律退化」的极端注入:两侧都非空且中间段非零就必须退化
  const zero = T.diffText('a\nb', 'a\nB', 0)
  ok(zero.degraded === true && zero.lines.length === 0, 'maxCells=0 ⇒ 任何非平凡差异都退化(退化闸真的在读预算)', zero)
}

section('7. hunks:上下文折叠与并块')
{
  const d = T.diffText('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12', '1\nX\n3\n4\n5\n6\n7\n8\n9\n10\n11\nY')
  const h = T.hunks(d.lines)
  ok(h.length === 2, '两处改动隔 10 行(> 2×context+1)⇒ 两个块', h.length)
  ok(H(h,0).so === 1 && H(h,0).sn === 1, '第一块从第 1 行起(上下文顶到文件头就止于头)', h[0])
  ok(H(h,0).n === 6 && H(h,0).ops === 'sadsss', '第一块:改动对 + 后面 3 行上下文,前上下文被文件头截短', H(h,0))
  ok(FA(F(h[0]).lines).some((x) => F(x).text === 'X' && F(x).op === 'add'), '第一块里真有那条 add')
  ok(H(h,1).so === 9, '第二块的起始行号来自它自己第一行(不是整份文件的头)', h[1])
  ok(H(h,1).n === 5 && H(h,1).ops === 'sssad', '第二块:3 行前上下文 + 改动对', H(h,1))

  // 并块:两处改动只隔 4 行,context=3 ⇒ 合成一块
  const close = T.diffText('a\nb\nc\nd\ne\nf\ng', 'A\nb\nc\nd\ne\nf\nG')
  const hc = T.hunks(close.lines)
  ok(hc.length === 1, '相隔不超过 2×context+1 的两处改动并成一块(否则格式化会碎成一堆一行块)', hc.length)
  ok(H(hc,0).n === 9, '并块后一块就覆盖全部 7 行 + 首尾改动', H(hc,0))

  // context 真的在被读:同一份 diff,context 从 0 到 3 的块大小必须单调变大
  const one = T.diffText('a\nb\nc', 'a\nB\nc')
  const sizes = [0, 1, 2, 3].map((c) => FA(T.hunks(one.lines, c)).reduce((m, x) => m + F(x).lines.length, 0))
  ok(N(sizes[0]) === 2, 'context=0 ⇒ 块里只剩 add+del 两行(证明 context 不是摆设)', sizes)
  ok(N(sizes[1]) === 4 && N(sizes[3]) === 4, 'context≥1 时这块已顶到文件两端(4 行),不会无限长大', sizes)
  ok(T.hunks(one.lines, 0).length === 1, 'context=0 时一处改动的两个 op 仍在同一块里(prev 从第一个改动行起算)')

  // 边界:identical / degraded / 脏入参
  ok(T.hunks(T.diffText('a\nb', 'a\nb').lines).length === 0, '无变化 ⇒ 零块')
  ok(T.hunks(T.diffText('a\nb', 'c\nd', 0).lines).length === 0, '退化时 lines 为空 ⇒ 零块(不是崩)')
  for (const v of [undefined, null, 'x', 42]) ok(T.hunks(v).length === 0, `hunks(${JSON.stringify(v) ?? String(v)}) 给空数组不抛`)
  ok(T.hunks([{ op: 'same', oldNo: 1, newNo: 1, text: 'a' }, null, { op: 'add', oldNo: null, newNo: 2, text: 'b' }]).length === 1,
    'lines 里混进 null 也不抛,脏元素被跳过')
}

section('8. diffStat 的每一档')
{
  ok(T.diffStat(null) === '没有可比对的差异', 'null 入参不返回空串', T.diffStat(null))
  ok(T.diffStat(undefined) === '没有可比对的差异', 'undefined 同上')
  ok(T.diffStat(T.diffText('a', 'a')) === '无变化', '相同 ⇒ 无变化')
  ok(T.diffStat(T.diffText('a\nb', 'a\nB')) === '+1 -1', '一处改写 ⇒ +1 -1', T.diffStat(T.diffText('a\nb', 'a\nB')))
  ok(T.diffStat({ degraded: true, identical: false, oldCount: 3, newCount: 4, added: 4, removed: 3, lines: [] }).includes('未逐行比对'),
    '退化档 ⇒ 明说没逐行比')
  ok(T.diffStat({ degraded: false, identical: true, lines: [], added: 0, removed: 0, oldCount: 0, newCount: 0 }) === '无变化',
    'identical 优先于计数')
}

section('9. renamePairs:§5.8 的另一种预览形态(第 2 批要用,契约现在就钉住)')
{
  const pairs = T.renamePairs([
    { rel: 'a.gd', to: 'b.gd' },
    { rel: 'c.gd', to: 'd.gd' }
  ])
  ok(pairs.length === 2 && pairs[0].from === 'a.gd' && pairs[0].to === 'b.gd', '成对给出旧名→新名', pairs)
  ok(T.renamePairs([{ rel: 'a.gd', to: 'a.gd' }]).length === 0, '前后同名不算变更,不进对照表')
  ok(T.renamePairs([{ rel: 'a.gd' }]).length === 0, '缺 to 的不进对照表(而不是显示成 a.gd → undefined)')
  ok(T.renamePairs([{ rel: 1, to: 2 }, null, 'x', undefined]).length === 0, '脏元素全跳过')
  ok(T.renamePairs(null).length === 0 && T.renamePairs(undefined).length === 0, '非数组入参给空数组不抛')
  ok(T.renamePairs([]).length === 0, '空数组 ⇒ 空表')
}

section('10. 与执行层的关系:diff 不是判据(DEV-8)')
{
  // 这一节钉的是「预览说不清」与「要不要执行」之间没有耦合:
  // 退化时 lines 空,但 added/removed/行数照给,勾选与 payload 一个字节的判据都不从 diff 里取。
  const d = T.diffText(Array.from({ length: 30 }, (_, i) => `o${i}`).join('\n'), 'x\ny', 10)
  ok(d.degraded === true && d.lines.length === 0, '退化:画不出逐行')
  ok(d.oldCount === 30 && d.newCount === 2 && d.removed === 30 && d.added === 2,
    '但事实照说 —— 退化时 added/removed 是**中间段行数**(30 删 2 增),执行朝读的是 Change 的正文,不是这份 lines', d)
  ok(T.diffText('a\nb\nc', 'a\nb\nc').lines.length === 3, '相同文件的 lines 仍是三行(same),UI 才能显示上下文而不是空白')
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
