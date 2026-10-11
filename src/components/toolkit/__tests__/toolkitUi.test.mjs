// 工具箱 · 第 1 批 Task 12c:.vue 那一层的断言。
//
// ⚠ 机制说在前面:本仓库**没有**组件挂载测试能力(要 vite + plugin-vue + DOM,等于引 vitest/jsdom,
// 违反「不引入新依赖」)。所以这一层沿用 `src/components/versions/TemplateFeaturePanel.test.mjs`
// 那套已确立的做法:**读源码文本 + 正则判结构**。它测不出「点下去行为对不对」,
// 那些由 useToolkit / useToolPage / toolkit/* 的纯函数与组装层断言负责(都有真执行)。
// 因此这里只钉两类东西:① 结构与接线在不在;② **措辞与判据不许在这一层另写一份**(最容易悄悄漂移的地方)。
import { existsSync, readFileSync } from 'node:fs'
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
/** 去掉注释后的扫描面:注释是给人讲理由的,拿它判「代码里有没有这句话」会一直假红 */
const code = (x) => String(x).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
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
  // 数出现次数而不是「有没有出现过」:首页有两处用途(目录那一块 + 首次弹的模态),
  // 只判「含不含」的话,拔掉其中一处照样绿(U1 那把刀就是这么活下来的)
  ok((SRC.home.match(/<PermissionNotice/g) || []).length >= 2, '首页两处都摆:目录那一块 + 首次装插件的模态(A-12)')
  ok(SRC.scaffold.includes('<PermissionNotice'), '生成骨架之前也摆一次')
  ok(SRC.home.includes('consentOpen') && SRC.home.includes('acknowledgeNewTools'), '首次装新插件时弹一次,并记住见过的目录')
  // 触发点要有两处(进页面 + 手动重扫);只判「声明了 consentOpen」的话,把赋值全删掉也照样绿
  ok((SRC.home.match(/consentOpen\.value = true/g) || []).length >= 2, '两条触发都在(U4b 那把刀就是这么抓到的)')
  for (const [name, text] of [['notice', SRC.notice], ['home', SRC.home], ['page', SRC.page], ['scaffold', SRC.scaffold], ['scaffold.ts', SRC.scaffoldTs]]) {
    const bad = text.split('\n').filter((l) => /(沙箱|隔离)/.test(l) && !/(不|别|没|非|假|挡不住)/.test(l))
    ok(bad.length === 0, `${name}:每句提到「沙箱/隔离」的话都在否定式里(R-1③)`, bad.slice(0, 2))
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
