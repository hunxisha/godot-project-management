// GDScript 批量重命名 · 四种模式(modes.ts)的断言(§G Task 18)。
//
// 这一份守的是「新名叫什么」。最贵的三条:
//   · **扩展名永远不动**(三档只作用在 base;模板那一档必须含 {ext},缺了就报错而不是偷偷补);
//   · **坏名字拦在动手之前**(`/ \ : * ? " < > |`、结尾空白或点、含 ..)—— 那时还没碰盘,
//     而 Windows 上这些字符会让 renameSync 抛,而抛的时候**别的文件已经改完了**;
//   · `{index}` 只按框架给的顺序走(选中集与顺序的唯一真源在框架那边,§F 契约补充第 2 条),
//     所以同一批勾注重跑,序号分布必须一模一样。
//
// 用法:node src/composables/__tests__/build-bundle.mjs && node src/tools/builtin/__tests__/gdscriptRenameModes.test.mjs
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tkmodes.mjs')

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
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }
const F = (x) => (x && typeof x === 'object' ? x : {})
const S = (x) => (typeof x === 'string' ? x : '')

const P = (over) => ({ ...T.DEFAULT_PARAMS, ...(over || {}) })
const NAME = (rel, over, position) => {
  try {
    return F(T.newNameFor(P(over), rel, position || 1))
  } catch (e) {
    return { to: null, hits: -1, error: '__THREW__:' + (e && e.message), noop: false }
  }
}

// ---------------------------------------------------------------- 0. 导出面
section('0. 导出面')
{
  for (const n of ['splitName', 'joinName', 'nameProblem', 'splitWords', 'applyCase', 'unknownToken',
    'ordinalOf', 'newNameFor', 'paramsFrom', 'regexHitsOnNames', 'DEFAULT_PARAMS', 'RENAME_MODES', 'CASE_MODES', 'TEMPLATE_TOKENS']) {
    ok(T[n] !== undefined, `${n} 导出`)
  }
  ok(T.RENAME_MODES.join(',') === 'regex,affix,template,case', '四种模式与 §3 #16 对得上', T.RENAME_MODES)
  ok(T.TEMPLATE_TOKENS.join(',') === 'name,index,ext', '模板只认三个占位符(§3 原话)', T.TEMPLATE_TOKENS)
}

// ---------------------------------------------------------------- 1. splitName
section('1. splitName:base / ext 的分界永远是最后一个点,且不改大小写')
{
  ok(T.splitName('player.gd').base === 'player' && T.splitName('player.gd').ext === '.gd', '普通 .gd')
  ok(T.splitName('a/b.gd').dir === 'a/', '目录段带尾斜杠')
  ok(T.splitName('a.b.gd').base === 'a.b' && T.splitName('a.b.gd').ext === '.gd', '多点:只有最后一个点是分界')
  ok(T.splitName('LICENSE').base === 'LICENSE' && T.splitName('LICENSE').ext === '', '没有扩展名 ⇒ ext 空串')
  ok(T.splitName('.gitignore').base === '.gitignore' && T.splitName('.gitignore').ext === '', '点在最前面算「整名都是 base」(不是扩展名)')
  const up = T.splitName('Foo.GD')
  ok(up.base === 'Foo' && up.ext === '.GD', '扩展名的**原始大小写保留**(不能用 treeUtils.extOf,它给小写无点)')
  ok(T.splitName('a\\b.gd').dir === 'a/', '反斜杠归正斜杠')
  ok(T.splitName(undefined).base === '' && T.splitName(42).dir === '', '脏入参不抛')
  ok(T.joinName('a/', 'b', '.gd') === 'a/b.gd', 'joinName 拼回去')
  ok(T.joinName('', 'b', '') === 'b', '无目录无扩展名')
}

// ---------------------------------------------------------------- 2. nameProblem
section('2. nameProblem:坏名字拦在动手之前')
{
  ok(T.nameProblem('ok_name') === '', '合法名过')
  ok(T.nameProblem('') === '新名是空的', '空串')
  ok(T.nameProblem('..') !== '' && T.nameProblem('a..b') !== '', '含 .. 拒(归一化会把它变成别的路径)')
  for (const c of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
    ok(T.nameProblem('a' + c + 'b') !== '', `名字里有 ${c} ⇒ 拒(Windows 上 renameSync 会抛,那时别的文件已经改完了)`, T.nameProblem('a' + c + 'b'))
  }
  ok(T.nameProblem('a ') !== '', '结尾空白拒')
  ok(T.nameProblem('a.') !== '', '结尾点拒(那会变成一个没有扩展名的名字)')
  ok(T.nameProblem('中文名') === '', '中文名字合法(这插件的作者就写中文文件名)')
  ok(T.nameProblem('a b') === '', '中间空格合法')
  ok(T.nameProblem(undefined) !== '', '非字符串 ⇒ 空名那条路,不抛')
}

// ---------------------------------------------------------------- 3. 切段与大小写
section('3. splitWords / applyCase:大小写四档')
{
  ok(T.splitWords('player_model').join(',') === 'player,model', '下划线切段')
  ok(T.splitWords('player-model').join(',') === 'player,model', '连字符切段')
  ok(T.splitWords('PlayerModel').join(',') === 'Player,Model', '驼峰边界切段')
  ok(T.splitWords('a1B2').join(',') === 'a1,B2', '数字后面跟大写也算边界')
  ok(T.splitWords('  x  _  y ').join(',') === 'x,y', '连续分隔符不产生空段')
  ok(T.splitWords('').length === 0, '空串 ⇒ 无段')
  ok(T.applyCase('PlayerModel', 'lower') === 'playermodel', 'lower 不切段(纯换大小写)')
  ok(T.applyCase('player_model', 'upper') === 'PLAYER_MODEL', 'upper 不切段:下划线是内容不是分隔符的**改写目标**')
  ok(T.applyCase('player_model', 'pascal') === 'PlayerModel', 'snake → PascalCase')
  ok(T.applyCase('PlayerModel', 'snake') === 'player_model', 'PascalCase → snake')
  ok(T.applyCase('player-model', 'pascal') === 'PlayerModel', 'kebab → PascalCase')
  ok(T.applyCase('' , 'pascal') === '', '空 base 不抛')
  ok(T.applyCase('UIDToken', 'snake') === 'uidtoken', '连续大写开头整段是一词(边界只在「小写或数字 → 大写」处切,所以 HTTPServer 不会被切成 h_t_t_p_server)', T.applyCase('UIDToken', 'snake'))
}

// ---------------------------------------------------------------- 4. 模板占位符
section('4. unknownToken 与 ordinalOf')
{
  ok(T.unknownToken('{name}{index}{ext}') === '', '三个合法占位符')
  ok(T.unknownToken('{name}{foo}') === 'foo', '不认识的占位符要被点名(而不是静默留着它写进文件名)')
  ok(T.unknownToken('{}') === '', '空花括号不当占位符(那是字面文本)')
  ok(T.unknownToken('name') === '', '没有花括号 ⇒ 没有占位符')
  ok(T.ordinalOf(1, 2, 1) === '01', '起始 1 位数 2 ⇒ 01')
  ok(T.ordinalOf(1, 2, 12) === '12', '够位数就不补')
  ok(T.ordinalOf(1, 2, 100) === '100', '超位数自然变宽(不截断:截断会撞名)')
  ok(T.ordinalOf(10, 3, 1) === '010', '起始 10 ⇒ 第一个是 010')
  ok(T.ordinalOf(1, 0, 1) === '1', '位数 0 ⇒ 与 1 位等价(没有负数补零这回事)')
  ok(T.ordinalOf(1, 99, 1).length === 9, '位数上限 9 挡的是「digits 写成 99 把文件名撑成几百个零」', T.ordinalOf(1, 99, 1))
  ok(T.ordinalOf(1, 2, undefined) === '01', '位次缺失 ⇒ 按第 1 个,不抛')
  ok(T.ordinalOf(NaN, NaN, -5) === '1', '三个全是脏值 ⇒ 退默认(起始 1 / 位数 1 / 位次 1)')
}

// ---------------------------------------------------------------- 5. regex 档
section('5. 正则替换档')
{
  const r = NAME('player.gd', { mode: 'regex', pattern: 'player', replacement: 'hero' })
  ok(r.to === 'hero.gd' && r.error === '' && r.hits === 1, '基本替换', r)
  const two = NAME('a_a.gd', { mode: 'regex', pattern: 'a', replacement: 'b' })
  ok(two.hits === 2 && two.to === 'b_b.gd', '带 g:一行里两处都换(少了 g 只会换第一处)', two)
  const none = NAME('player.gd', { mode: 'regex', pattern: 'zzz', replacement: 'q' })
  ok(none.noop === true && none.to === '' && none.error === '', '一处没命中 ⇒ noop,而不是产一条「改成同一个名字」', none)
  const empty = NAME('player.gd', { mode: 'regex', pattern: '', replacement: 'x' })
  ok(empty.error === '正则是空的', '空正则 ⇒ 原因')
  const bad = NAME('player.gd', { mode: 'regex', pattern: '(', replacement: 'x' })
  ok(bad.error.startsWith('正则编译不过'), '编译不过 ⇒ 说清是正则的问题,不抛', bad.error)
  const toBlank = NAME('player.gd', { mode: 'regex', pattern: 'player', replacement: '' })
  ok(toBlank.error === '新名是空的', '替换成空串 ⇒ 走坏名字闸,不产出 .gd 这种没有名字的文件', toBlank)
  const toBad = NAME('player.gd', { mode: 'regex', pattern: 'player', replacement: 'a/b' })
  ok(toBad.error.includes('平台用不了的字符'), '替换结果带 / ⇒ 拦在动手之前', toBad.error)
  const keepExt = NAME('Foo.GD', { mode: 'regex', pattern: 'Foo', replacement: 'Bar' })
  ok(keepExt.to === 'Bar.GD', '扩展名的原始大小写不动', keepExt)
  const num = NAME('mob2.gd', { mode: 'regex', pattern: '(\\d+)', replacement: '99' })
  ok(num.to === 'mob99.gd', '捕获组能用(用户会写 $1 那种反向引用)', num)
  const zero = NAME('player.gd', { mode: 'regex', pattern: '^(?=.*)', replacement: 'x' })
  ok(zero.hits === 1 && zero.to === 'xplayer.gd', '零宽匹配不许挂死,也不许把每个字符位置都算一处命中', zero)
}

// ---------------------------------------------------------------- 6. affix 档
section('6. 前缀 / 后缀档')
{
  ok(NAME('a.gd', { mode: 'affix', prefix: 'pre_', suffix: '' }).to === 'pre_a.gd', '只加前缀')
  ok(NAME('a.gd', { mode: 'affix', prefix: '', suffix: '_s' }).to === 'a_s.gd', '只加后缀')
  const both = NAME('dir/a.gd', { mode: 'affix', prefix: 'X', suffix: 'Y' })
  ok(both.to === 'dir/XaY.gd', '两头都加,且加在 base 上(不是加在扩展名后面)', both)
  ok(NAME('a.gd', { mode: 'affix', prefix: '', suffix: '' }).error === '前缀与后缀都是空的,那不改任何东西', '两头空 ⇒ 原因')
  ok(NAME('a.GD', { mode: 'affix', prefix: 'Z' }).to === 'Za.GD', '扩展名原样')
  ok(NAME('a.gd', { mode: 'affix', prefix: 'bad/name' }).error.includes('平台用不了的字符'), '前缀里的非法字符也被闸挡下')
}

// ---------------------------------------------------------------- 7. template 档
section('7. 命名模板档({name}{index}{ext})')
{
  const d = NAME('a.gd', { mode: 'template' }, 3)
  ok(d.to === 'a03.gd', '默认模板:名字 + 两位序号 + 扩展名', d)
  const dir = NAME('skills/fire.gd', { mode: 'template' }, 1)
  ok(dir.to === 'skills/fire01.gd', '目录段原样保留(本批的模式只改文件名,不做移动文件)', dir)
  const noIdx = NAME('a.gd', { mode: 'template', template: 'npc_{name}{ext}' }, 7)
  ok(noIdx.to === 'npc_a.gd', '不含 {index} 的模板合法(序号不是必填)')
  ok(NAME('a.gd', { mode: 'template', template: '{name}{index}' }).error.includes('必须有 {ext}'), '缺 {ext} ⇒ 报错,不偷偷补扩展名(那是框架替用户改主意)')
  ok(NAME('a.gd', { mode: 'template', template: '{nmae}{ext}' }).error.includes('{nmae}'), '不认识的占位符被点名')
  const extCase = NAME('a.GD', { mode: 'template', template: 'b{index}{ext}' }, 1)
  ok(extCase.to === 'b01.GD', '模板里的 {ext} 用的是原始大小写', extCase)
  const start = NAME('a.gd', { mode: 'template', template: 'm{index}{ext}', start: 10, digits: 3 }, 1)
  ok(start.to === 'm010.gd', '序号起始与位数联动', start)
  const collision = NAME('a.gd', { mode: 'template', template: '{index}{ext}' }, 1)
  ok(collision.to === '01.gd', '不含 {name} 的模板允许(撞名由框架的批次内预检与逐条执行去挡)')
  ok(NAME('a.gd', { mode: 'template', template: '{name}{index}{ext}', digits: 0 }).to === 'a1.gd', '位数 0 退到 1:序号不会被拼成空串(那会让整批撞同一个名字)')
  const doubleDot = NAME('a.gd', { mode: 'template', template: '{name}1.{ext}' }, 1)
  ok(doubleDot.error.includes('{ext} 前面不要再写点'),
    '模板在 {ext} 前又写一个点 ⇒ 点名是模板的问题(它自带那个点),而不是丢一句「结尾不能是点」让人猜', doubleDot)
  const tailDot = NAME('a.gd', { mode: 'template', template: '{name}{ext}.' }, 1)
  ok(tailDot.error === '名字结尾不能是点', '模板产出结尾是点 ⇒ 闸拦下', tailDot)
}

// ---------------------------------------------------------------- 8. case 档
section('8. 大小写档(内部形状用 caseMode;schema 那个下划线键由 §9 的 paramsFrom 负责)')
{
  ok(NAME('PlayerModel.gd', { mode: 'case', caseMode: 'snake' }).to === 'player_model.gd', 'Pascal → snake')
  ok(NAME('player_model.gd', { mode: 'case', caseMode: 'pascal' }).to === 'PlayerModel.gd', 'snake → Pascal')
  ok(NAME('Player.gd', { mode: 'case', caseMode: 'lower' }).to === 'player.gd', 'lower')
  ok(NAME('player.gd', { mode: 'case', caseMode: 'upper' }).to === 'PLAYER.gd', 'upper')
  const noop = NAME('player.gd', { mode: 'case', caseMode: 'lower' })
  ok(noop.noop === true && noop.error === '', '已经是目标形态 ⇒ noop(不产一条假变更)', noop)
  const bad = NAME('a.gd', { mode: 'case', caseMode: 'nope' })
  ok(bad.error.startsWith('case_mode'), '直接拿一份自己拼的 ModeParams 传进来时也要给得出原因,不许悄悄按 snake 算', bad)
}

// ---------------------------------------------------------------- 9. paramsFrom
section('9. paramsFrom:框架给的值仍是外来数据')
{
  const d = T.paramsFrom(undefined)
  ok(d.p.mode === T.DEFAULT_PARAMS.mode && d.skips.length === 0, '整个 params 缺失 ⇒ 退默认,不抛')
  const m = T.paramsFrom({ mode: 'nope' })
  ok(m.p.mode === T.DEFAULT_PARAMS.mode && m.skips.length === 1, 'mode 不认 ⇒ 退默认并记一句', m.skips)
  const cn = T.paramsFrom({ case_mode: 'pascal' })
  ok(cn.p.caseMode === 'pascal', 'schema 的键是下划线 case_mode,内部读成 caseMode(键名写错会被 schema 校验拒,这里钉住两边一致)')
  const n = T.paramsFrom({ start: '3', digits: true })
  ok(n.skips.length === 2 && n.p.start === T.DEFAULT_PARAMS.start && n.p.digits === T.DEFAULT_PARAMS.digits, '数字位给串/布尔 ⇒ 记两句 skips 并退默认', n.skips)
  const num = T.paramsFrom({ start: 5, digits: 3 })
  ok(num.p.start === 5 && num.p.digits === 3, '正常数字原样取')
  const empty = T.paramsFrom({ pattern: undefined, replacement: undefined })
  ok(empty.p.pattern === '' && empty.p.replacement === '', '文本位缺失 ⇒ 空串(必填校验由 schema 那层做)')
  ok(T.paramsFrom('nope').p.mode === T.DEFAULT_PARAMS.mode, 'params 是字符串 ⇒ 全默认,不抛')
}

// ---------------------------------------------------------------- 10. regexHitsOnNames
section('10. regexHitsOnNames:表单那句「匹配到几处」与产出同源')
{
  const r = T.regexHitsOnNames('a', ['aa.gd', 'ba.gd', 'zz.gd'])
  ok(r.count === 3 && r.error === '', '两处 + 一处 + 零处 = 3(数的是命中处数,不是文件数)', r)
  ok(T.regexHitsOnNames('', ['a.gd']).count === 0, '空正则 ⇒ 0 且不抛')
  ok(T.regexHitsOnNames('(', ['a.gd']).error !== '', '坏正则 ⇒ 有原因(表单每敲一个字都会调这里)')
  ok(T.regexHitsOnNames('a', undefined).count === 0, 'rels 不是数组 ⇒ 0')
  ok(T.regexHitsOnNames('a', [null, 42, 'a.gd']).count === 1, '数组里塞脏项 ⇒ 跳过而不是抛')
  const zero = T.regexHitsOnNames('^(?=.*)', ['ab.gd'])
  ok(zero.count === 1 && zero.error === '', '零宽正则在文件句柄上也只数一处(挂死与「每位置都算」两种错都要挡)', zero)
}

// ---------------------------------------------------------------- 11. 不抛与 noop
section('11. 脏 rel 与跨档一致性')
{
  for (const bad of [undefined, null, 42, '', {}]) {
    const r = NAME(bad, { mode: 'affix', prefix: 'x' })
    ok(typeof r.error === 'string', `rel 是 ${JSON.stringify(bad) ?? String(bad)} ⇒ 有结论不抛`, r)
  }
  const slash = NAME('nonexistent/deep/x.gd', { mode: 'affix', prefix: 'p' })
  ok(slash.to === 'nonexistent/deep/px.gd', '模式只是字符串运算:它不知道文件在不在(那是 plan 那一层读盘的事)', slash)
  const rootFile = NAME('project.godot', { mode: 'affix', prefix: 'x' })
  ok(rootFile.to === 'xproject.godot', '模式档不拦 project.godot —— 拦它的是改名原语(Task 15)与工具的 reason,一条判据只在一处')
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
