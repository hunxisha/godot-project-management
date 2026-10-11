// 工具箱 · 第 1 批 Task 12c:.vue 那一层的断言。
//
// ⚠ 机制说在前面:本仓库**没有**组件挂载测试能力(要 vite + plugin-vue + DOM,等于引 vitest/jsdom,
// 违反「不引入新依赖」)。所以这一层沿用 `src/components/versions/TemplateFeaturePanel.test.mjs`
// 那套已确立的做法:**读源码文本 + 正则判结构**。它测不出「点下去行为对不对」,
// 那些由 useToolkit / useToolPage / toolkit/* 的纯函数与组装层断言负责(都有真执行)。
// 因此这里只钉两类东西:① 结构与接线在不在;② **措辞与判据不许在这一层另写一份**(最容易悄悄漂移的地方)。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }
const read = (rel) => {
  const p = path.resolve(ROOT, rel)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf8')
}

const FILES = {
  notice: 'src/components/toolkit/PermissionNotice.vue',
  form: 'src/components/toolkit/SchemaForm.vue',
  picker: 'src/components/toolkit/FilePicker.vue',
  list: 'src/components/toolkit/ChangeList.vue',
  diff: 'src/components/toolkit/DiffView.vue',
  ledger: 'src/components/toolkit/LedgerPanel.vue',
  scaffold: 'src/components/toolkit/ScaffoldDialog.vue',
  page: 'src/views/ToolPageView.vue',
  home: 'src/views/ToolsView.vue',
  app: 'src/App.vue',
  css: 'src/main.css',
  scaffoldTs: 'src/toolkit/scaffold.ts',
  pkg: 'package.json'
}
const SRC = {}
/**
 * 剥注释,给禁令类断言当扫描面。**不能**用「先 replace 掉块注释,再按行剔双斜杠」那种写法:
 * 行注释里 `toolkit/` 后面紧跟一个星号,就会被当成块注释的开头,于是从那一行一路吃到下一个
 * 块注释结束符之间**所有真实代码**都被剥掉 —— 这次就是 ToolPageView 第 6 行那句注释让它的
 * script 第 6~96 行整体从扫描面消失,落在那一段里的断言全部静默失明(一把本该红的刀因此「存活」)。
 * 所以这里按字符扫一遍:注释只在**字符串外**才算,三种引号与模板串各自成段。
 * (本段刻意不写出那两组成对符号 —— 写了就会在这里先把本注释提前关掉,变成语法错。这本身就是同一类坑。)
 */
function code(src) {
  const s = String(src)
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    const d = s[i + 1]
    if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') {
      i += 2
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      out += c
      i++
      while (i < s.length) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] || ''); i += 2; continue }
        if (s[i] === c) { out += s[i]; i++; break }
        if (s[i] === '\n' && c !== '`') { i++; break }        // 单双引号串不跨行,别让它一路吞到文件尾
        out += s[i]
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}
section('0. 文件都在,且都是 `<script setup>` + `<template>` 的形状')
for (const [k, rel] of Object.entries(FILES)) {
  if (k === 'css' || k === 'pkg' || k === 'scaffoldTs') continue
  const t = read(rel)
  ok(typeof t === 'string' && t.length > 60, `${rel} 存在且不是空壳`)
  if (typeof t !== 'string') continue
  SRC[k] = t
  ok(t.includes('<script setup lang="ts">'), `${k}:用的是 <script setup lang="ts">(与本仓库其余视图同形)`)
  ok(/<template>/.test(t), `${k}:有 template 块`)
}
SRC.css = read(FILES.css) || ''
SRC.pkg = read(FILES.pkg) || ''
SRC.scaffoldTs = read(FILES.scaffoldTs) || ''

section('0b. 扫描面自检:剥注释这一步不许把真实代码吃掉')
{
  // 教训来自这一轮:code() 以前把行注释里的 `toolkit/*` 当成块注释开头,于是 ToolPageView 的
  // script 第 6~96 行整段从扫描面消失 —— 落在那一段的禁令断言全部静默失明,一把本该红的刀因此「存活」。
  // **断言的靶子塌了,比根本没写这条断言更坏**:它继续报绿,而它已经什么都看不见了。
  const ANCHORS = {
    page: ['async function onRollback', '<FilePicker', '.notice {', 'showPicker'],
    form: ["f.type === 'files'", '<slot', "emit('pick-files')"],
    notice: ['PERMISSION_TEXT', 'perm-more'],
    home: ['consentOpen', '<PermissionNotice', 'onRescan'],
    scaffoldTs: ['PERMISSION_TEXT', 'buildSkeleton']
  }
  for (const [k, list] of Object.entries(ANCHORS)) {
    const raw = SRC[k] !== undefined ? SRC[k] : (read(FILES[k]) || '')
    const stripped = code(raw)
    for (const a of list) ok(stripped.includes(a), `${k}:剥注释后扫描面里还留着 ${a}`)
    ok(stripped.length > raw.length * 0.6, `${k}:剥注释后剩下的字节数没塌掉四成`, [stripped.length, raw.length])
  }
}

section('1. 只用 main.css 里已有的变量(不新增令牌 / 不臆造名字)')
{
  const declared = new Set((SRC.css.match(/--[a-z0-9-]+(?=\s*:)/g) || []).map((s) => s))
  ok(declared.size > 25, `先从 main.css 读到令牌清单(${declared.size} 个)`, declared.size)
  for (const k of ['notice', 'form', 'picker', 'list', 'diff', 'ledger', 'scaffold', 'page', 'home']) {
    const used = new Set((SRC[k].match(/var\((--[a-z0-9-]+)/g) || []).map((s) => s.replace(/^var\(/, '')))
    const unknown = [...used].filter((v) => !declared.has(v))
    ok(unknown.length === 0, `${k}:用到的 CSS 变量都在 main.css 里(${used.size} 种)`, unknown)
    ok(!/--sp-|gap-token|--text-1\b/.test(SRC[k]), `${k}:没臆造间距令牌或 --text-1 这类不存在的名字`)
  }
}

section('2. 不新增依赖(工具箱不引路由/状态库/样式框架)')
{
  const pkg = JSON.parse(SRC.pkg)
  const deps = Object.keys(pkg.dependencies || {})
  ok(deps.length === 1 && deps[0] === 'vue', '运行时依赖仍然只有 vue', deps)
  ok(!/vue-router|pinia|tailwind|shadcn|element-plus|ant-design/.test(SRC.pkg), 'package.json 里没有路由/状态/样式库')
  ok(!/from ['"]vue-router|createRouter|useRoute\b/.test(SRC.home + SRC.app), '路由还是那个 ref + 分支的手写实现')
}

section('3. 二级导航与直达:列表 ⇄ 工具页,code 反解不自己切字符串')
{
  ok(SRC.home.includes('v-if="K.activeTool.value"') && SRC.home.includes('<ToolPageView'), '首页里有工具页这一支(v-if 切,不引路由)')
  ok(SRC.home.includes('<div v-else class="home">'), '列表那一支挂在 v-else 上(工具页在 v-if 那一支)')
  ok(SRC.app.includes('toolIdOfCode(code)'), 'ZTools 直达用 features.ts 的反解(前缀只有一份定义)')
  ok(!SRC.app.includes("'tool-'.length") && !/String\(code\)\.startsWith\('tool-'\)/.test(SRC.app), 'App.vue 不自己切 tool- 前缀')
  ok(SRC.app.includes('tab.value = \'tools\''), '直达时切到工具箱这个入口')
  ok(SRC.app.includes('<KeepAlive include="MarketplaceView">'), 'KeepAlive 的 include 仍只覆盖市场页(工具页实测不生效,注释里记着)')
  ok(SRC.page.includes('K.closeTool()'), '返回按钮走全局状态,不是 router.back')
}

section('4. 措辞的唯一来源:这一层不许另写框架/账本那侧的句子')
{
  const owned = ['移入回收站', '默认勾选', '条在选中范围外', '可一键还原', '这一轮包含删除或改名', '没给成功证据', '备份文件仍在磁盘上', '重新扫描」才会出现']
  for (const k of ['page', 'home', 'list', 'ledger', 'form', 'picker', 'diff']) {
    const hit = owned.filter((w) => SRC[k].includes(w))
    ok(hit.length === 0, `${k}:没有把框架/账本的措辞抄一份进来`, hit)
  }
  ok(SRC.ledger.includes('entrySummaryText('), '账本那一行的话直接调 toollog 的导出')
  ok(SRC.ledger.includes('e.canRollback'), '还原按钮亮不亮读账本里重算过的判据')
  ok(!/written\.length\s*[><=]/.test(SRC.ledger), '渲染层不自己从 written/moved 反推「能不能还原」')
  ok(SRC.list.includes('props.groups') && SRC.list.includes('g.title'), '分组与分组标题原样用 groupPreview 的产物')
  ok(SRC.page.includes('page.warn.value') && SRC.page.includes('page.summary.value'), '风险话与摘要都取自 useToolPage(=orchestrate)')
}

section('5. 权限面(A-12):文案只有一份,且不含「已沙箱」式暗示')
{
  ok(SRC.notice.includes("import { PERMISSION_TEXT } from '../../toolkit/scaffold'"), 'PermissionNotice 引的是 scaffold 里那份常量')
  ok(!SRC.notice.includes('插件能读写你的 Godot 项目文件'), '那句话没有被复制进组件(复制一份就是第二份真相)')
  ok(SRC.notice.includes('{{ PERMISSION_TEXT }}'), '渲染的是常量本身')
  // 提示框的标题也是措辞红线的一部分:把「这不是安全边界」换成中性词(比如「权限说明」),
  // 正文那句就会被读成「虽然能提权,但环境本身是安全的」。允许同义否定,不允许把否定删掉。
  const DENY = /(不是|不构成|并非|谈不上|算不上)安全边界/
  ok(DENY.test(SRC.notice), 'PermissionNotice 的默认标题明说这层边界不存在(A-12)')
  ok(DENY.test(SRC.home), '首次装插件那个模态的标题也自带这句否定(A-12)')
  // 数出现次数而不是「有没有出现过」:首页有两处用途(目录那一块 + 首次弹的模态),
  // 只判「含不含」的话,拔掉其中一处照样绿(U1 那把刀就是这么活下来的)
  ok((SRC.home.match(/<PermissionNotice/g) || []).length >= 2, '首页两处都摆:目录那一块 + 首次装插件的模态(A-12)')
  ok(SRC.scaffold.includes('<PermissionNotice'), '生成骨架之前也摆一次')
  ok(SRC.home.includes('consentOpen') && SRC.home.includes('acknowledgeNewTools'), '首次装新插件时弹一次,并记住见过的目录')
  // 触发点要有两处(进页面 + 手动重扫);只判「声明了 consentOpen」的话,把赋值全删掉也照样绿
  ok((SRC.home.match(/consentOpen\.value = true/g) || []).length >= 2, '两条触发都在(U4b 那把刀就是这么抓到的)')
  // R-1③ 按**行**判,不是子串黑名单:凡提到「沙箱/隔离」的行必须自带否定词,否则就是在暗示「它是安全的」
  // —— 宿主实测 contextIsolation:false + webSecurity:false,那句话是假的(§6 R-1)。
  // 扫描面按目录整片扫(新加一个组件自动进来),不是手挑五份:当年「属性绑定不在扫描面」
  // 就是靠这种缺口让已经修掉的谎原样回归的。
  // 「错误隔离 / 前缀隔离」说的是框架机制(一条坏插件不连累其他条、store 键各归各插件),不是安全承诺。
  // 放行只针对**机制名本身**:把机制名抹掉后如果那句话还在提「沙箱/隔离」,就照样按承诺判红 ——
  // 否则「前缀隔离,插件在隔离环境里运行」这种半句机制半句谎的写法会躲在白名单里。
  const NEG = /(不|别|没|非|假|挡不住)/
  const stripMechanism = (l) => l.replace(/(错误|前缀|命名|实例|作用域)隔离/g, '')
  const isBadLine = (l) => /(沙箱|隔离)/.test(l) && !NEG.test(l) && /(沙箱|隔离)/.test(stripMechanism(l))
  const norm = (p) => p.replace(/\\/g, '/')
  const wording = new Map()
  for (const rel of ['src/App.vue', 'src/main.css', 'src/views/ToolsView.vue', 'src/views/ToolPageView.vue', 'src/composables/useToolkit.ts', 'src/composables/useToolPage.ts']) {
    const t = read(rel)
    if (typeof t === 'string') wording.set(norm(rel), t)
  }
  for (const dir of ['src/toolkit', 'src/components/toolkit', 'src/tools/builtin/gdscript-format']) {
    const abs = path.resolve(ROOT, dir)
    if (!existsSync(abs)) continue
    for (const f of readdirSync(abs)) {
      if (!/\.(ts|vue|json)$/.test(f)) continue
      const t = read(`${dir}/${f}`)
      if (typeof t === 'string') wording.set(norm(`${dir}/${f}`), t)
    }
  }
  // 下限:目录改名或整体挪走时扫描面会塌成 0,那时候「全绿」是最坏的假绿
  ok(wording.size >= 20, `措辞红线扫到 ${wording.size} 个文件(整片工具箱面)`, wording.size)
  for (const [rel, text] of wording) {
    const bad = text.split(/\r?\n/).filter(isBadLine)
    ok(bad.length === 0, `${rel}:每句提到「沙箱/隔离」都在否定式或机制名里(R-1③)`, bad.slice(0, 2).map((l) => l.trim().slice(0, 80)))
  }
}

section('6. schema 渲染器:七种字段都画,files 不自己画第二份勾选')
{
  for (const t of ['files', 'select', 'boolean', 'textarea', 'number', 'regex']) {
    ok(SRC.form.includes(`'${t}'`), `${t} 类型有分支`)
  }
  ok(SRC.form.includes("f.type === 'text' ? 'text'") || SRC.form.includes('v-else class="input"'), 'text 走兜底分支')
  ok(!SRC.form.includes('candidates'), 'files 字段不画候选列表(选中集归 FilePicker,两处各画就是两个真源)')
  ok(SRC.form.includes("emit('pick-files')"), 'files 只把「去挑文件」转成事件')
  ok(SRC.form.includes('fieldHint('), '约束文本取自 schema.fieldHint(措辞在 schema.ts)')
  ok(SRC.form.includes('errOf(f.key)'), '校验错误内联到出错的那个字段下面')
  ok(SRC.form.includes('props.fields.length') && SRC.form.includes('不需要参数'), '零参数的工具也能画(空数组合法)')
}

section('7. 预览与 diff:不裁列表,degraded 不糊弄')
{
  ok(!SRC.list.includes('.slice(0,'), 'ChangeList 不截断列表(勾选要求看得见每一条)')
  ok(SRC.list.includes("'out'") && SRC.list.includes('高危'), '越界组与高危标记在(§5.4 单独分组)')
  ok(SRC.list.includes('c.reason') && SRC.list.includes('risk === \'high\''), '高危那条把 reason 摊开显示')
  ok(!SRC.list.includes('v-model'), '列表不自己持有勾选状态(checked 由页面给)')
  ok(SRC.diff.includes('hunks(') && SRC.diff.includes('diffStat('), 'diff 的折叠与统计都调 diff.ts 的纯函数')
  ok(SRC.diff.includes('h.lines'), '按 DiffHunk 的形状画(hunk 里是 lines)')
  ok(SRC.diff.includes('degraded'), 'degraded 那一支在')
  ok(!/差异过大,未逐行比对/.test(code(SRC.diff)), '退化那句统计文案不写在代码里(diffStat 是唯一来源)')
  ok(SRC.diff.includes('class="add"') || SRC.diff.includes(':class="ln.op"'), '增删两类行有各自的样式类')
}

section('8. 文件挑选:截断要说,勾选交回页面')
{
  ok(SRC.picker.includes('props.truncated'), '清单截断时显示警告(挑文件是用户在决定动哪些文件)')
  ok(SRC.picker.includes("emit('update:model'"), '勾选结果交回页面,自己不存第二份')
  ok(SRC.picker.includes('q.value') && SRC.picker.includes('.toLowerCase()'), '候选可按路径过滤')
  ok(!/window\.services|services\.scanProjectTree/.test(code(SRC.picker)), '组件不自己去扫树(候选是页面给的)')
}

section('9. 骨架生成对话框:纯函数负责判断,这里只收表单与落盘')
{
  ok(SRC.scaffold.includes('buildSkeleton('), '生成前交给 scaffold.ts 的纯函数(id 冲突与模板自检都在那边)')
  ok(SRC.scaffold.includes('errors') && SRC.scaffold.includes('r.errors'), '拒生成时把原因逐条列出来(A-17)')
  ok(SRC.scaffold.includes('writeToolPlugin'), '落盘走 Task 5 那条项目外路径原语(它还有「已存在不覆」与越界两道闸)')
  ok(!SRC.scaffold.includes('unlink') && !SRC.scaffold.includes('rmSync'), '这个对话框不删任何东西')
  ok(SRC.scaffold.includes('<PermissionNotice'), '生成前也摆权限面(A-12 的另一处)')
}

section('10. 工具页:状态门、取消、回滚、账本都接上了')
{
  ok(SRC.page.includes('tool.state !== \'ok\'') && SRC.page.includes('tool.reason'), '坏工具显示原因而不是给一堆按不动的按钮')
  ok(SRC.page.includes('page.canExecute.value'), '执行按钮的可用性取 runGate 的判定')
  ok(SRC.page.includes('page.cancel()') && SRC.page.includes('page.running.value'), '执行中可取消(取消语义在 orchestrate 那边)')
  ok(SRC.page.includes('page.rollback('), '还原按钮接的是账本那条通道')
  ok(SRC.page.includes('LedgerPanel') && SRC.page.includes('page.recent.value'), '本工具最近几条在页内(Q29=C)')
  ok(SRC.page.includes('projects.visible.value') && SRC.page.includes('K.setCurrentProject'), '页头有项目切换器,当前项目取全局那一份(Q26)')
  ok(SRC.page.includes('watch(pidRef'), '换项目会重拉文件树并重算计划(旧计划属于上一个项目)')
  ok(SRC.page.includes('try {') && SRC.page.includes('抛异常'), 'view 型渲染包在 try 里:插件炸了只塌这一块')
  ok(SRC.page.includes('<SchemaForm') && SRC.page.includes('<ChangeList'), 'action 型走表单 + 预览勾选')

  // ── 真宿主反馈的两条:「点挑选文件无反应」与「被拦的提示是绿的」 ──────────────
  // 这一组全部扫**剥注释后的面**(code()):禁令类断言扫原文的话,一句解释「以前这里写成什么样」的
  // 注释就会把自己打红 —— 而那种红只会引人去删注释,不是去改代码。(位置判据同理:注释里提一次
  // `#files-picker` 就能把 indexOf 指错地方。)
  const pageCode = code(SRC.page)
  const formCode = code(SRC.form)
  // ① 面板必须就地展开在它服务的那个字段下面。以前 FilePicker 挂在**整张表单卡片之后**,
  //    而内置格式化有七个字段 ⇒ 点完按钮视口里什么都不变,用户的原话就是「无反应」。
  const iSlot = pageCode.indexOf('#files-picker')
  const iPick = pageCode.indexOf('<FilePicker')
  const iFormClose = pageCode.indexOf('</SchemaForm>')
  ok(iSlot >= 0 && iPick > iSlot && iFormClose > iPick,
    '文件面板交给 SchemaForm 的 files-picker 插槽(在表单内部、字段正下方),不是表单下面那块独立卡片',
    [iSlot, iPick, iFormClose])
  ok(formCode.includes('name="files-picker"'), 'SchemaForm 那侧留了插槽(候选仍然不由它自己画 —— 选中集只有一个真源)')
  // ② 按钮要表达开合:它是 toggle,再点一次会收起,文案不跟着变就像「点了没反应」的第二次
  ok(formCode.includes('pickerOpen'), '面板开合状态传进了表单组件', null)
  ok(formCode.includes('收起'), '「挑选文件」按钮有收起态文案(toggle 必须看得出来)')
  ok(pageCode.includes('picker-open'), '页面把状态传下去(不是两边各存一份)')
  // ③ notice 的两种语义要有两种颜色。判的是**方向**:除了成功色,还得有一条坏色规则,
  //    而且模板挂类要由级别驱动 —— 只判「含不含 .bad」的话,写个死类名也能过。
  ok(/\.notice[.\s]+bad\b[^{]*\{[^}]*var\(--(danger|warn)/.test(pageCode),
    '样式里存在 notice 的坏色一档(只有一种 --ok 色 = 失败冒充成功)', null)
  ok(pageCode.includes('noticeKind'), '那条提示的类由 notice 的级别驱动,不是写死一种颜色')
  ok((pageCode.match(/page\.notice\.value\s*=/g) || []).length === 0,
    '视图不直接写 notice(回滚那句以前是视图覆盖上去的 ⇒ 永远是绿,而且多一处真源)',
    (pageCode.match(/page\.notice[^\n]*/g) || []).slice(0, 3))
}

section('10b. notice 只有一个写入口(漏定级要在结构上不可能,而不是靠自觉)')
{
  const ts = code(read('src/composables/useToolPage.ts') || '')   // 同样扫剥注释后的面:注释里引用旧写法不该打红
  ok((ts.match(/notice\.value\s*=/g) || []).length === 1,
    'useToolPage 里对 notice 的直接赋值恰好一处(在 say 内部);八处语义各自赋值迟早漏一级',
    (ts.match(/[^\n]*notice\.value\s*=[^\n]*/g) || []))
  ok(ts.includes('noticeKind'), '级别与文本同一次设置(noticeKind 在场)')
  ok((ts.match(/say\(/g) || []).length >= 8, '各处提示都走 say(数一下调用点)', (ts.match(/say\(/g) || []).length)
}

section('11. 首页:§3 第 10 项列的东西逐项在场(Q13=B / Q25)')
{
  for (const [label, needle] of [['搜索框', 'v-model="K.query.value"'], ['kind chip', "K.kindFilter.value === 'action'"], ['标签 chip', 'K.tags.value'], ['列表/网格切换', "K.setViewMode('grid')"], ['打开目录', 'onOpenDir'], ['重新扫描', 'onRescan'], ['新建工具骨架', 'scaffoldOpen = true'], ['历史入口', 'historyOpen = !historyOpen'], ['启用开关', 'onToggle']]) {
    ok(SRC.home.includes(needle), `${label} 在`)
  }
  ok(SRC.home.includes("K.viewMode.value === 'grid' ? 'grid' : 'list'"), '列表为主,网格可切(Q13=B)')
  ok(SRC.home.includes('.grid {') && SRC.home.includes('minmax('), '网格态有真正的栅格样式')
  ok(SRC.home.includes('t.state !== \'ok\''), '坏插件也列出来并带原因(loader 的错误隔离延伸到列表)')
  ok(SRC.home.includes('K.conflictOf(t)'), '关键词被占的那行有标记与说明(A-15)')
  ok(SRC.home.includes('class="tag danger"'), '载入失败有独立徽标(与「未完成」「已禁用」分得开)')
  ok(SRC.home.includes('histProject') && SRC.home.includes('entriesForProject'), '历史面板可按项目筛选(Q29=C)')
  ok(SRC.home.includes("histProject.value === '*'"), '「全部项目」用哨兵 *,不与 toollog 里「没归属」的空串混用')
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
