// 工具箱 · 骨架生成器的纯部分(§5.9 / Q19 / Q34 / A-17 / §D #16)。
//
// 为什么这个模块和加载器同批、且优先级不低于它(§5.9 原话):
// 「点一下生成一个能跑的骨架、改两行就出效果」是陌生用户会不会写插件的**唯一**决定因素。
// 所以这里的模板不是演示代码,而是**契约的可执行样本** —— 它自己生成的 manifest
// 必须过 `manifest.ts` 的校验器,它自己的导出名必须对得上 `loader.checkModuleShape`。
//
// 三条判据:
//   1. **生成前自检**:模板与校验器一旦漂移(改了字段名、加了必填项),这里直接拒绝生成并把原因摊开,
//      而不是让用户装出一个「拒载」的插件再去列表里猜。措辞来自校验器本身,不另写一份。
//   2. **id 冲突按小写比对,内置工具单独点名**:目录名 = id(§5.1 + `toolplugins.js:32`),
//      Windows 目录不区分大小写,所以撞名就是撞名;而注册时「先注册者保留」(loader.byId),
//      跟内置工具抢 id 的结局是用户的插件悄悄消失 —— 那种幽灵行为必须在生成之前就拦下。
//      「目录存在但那份 manifest 读不出 id」(坏插件)同样占着这个名字,也要拒。
//   3. **权限面文案逐字进模板与 README**(§D #16):这段是 §6 R-1 缓解①,一个字不改;
//      第 13 个 Task 会把它同一份贴到 UI 上。措辞不许出现「沙箱」「隔离」。
//
// 纯函数:不碰 fs、不碰 window。落盘由渲染层调 `services.gpm.writeToolPlugin`(Task 5 的原语,
// 它自己还有「已存在不覆」与越界两道闸)。

import type { ToolManifest } from './manifest'
import { validateManifest } from './manifest'

/** 两种骨架(§5.2:action 走三段式,view 自己渲染) */
export const SCAFFOLD_KINDS = ['action', 'view'] as const

/** 骨架固定生成的三个文件(`toolplugins.js:35` 约定 manifest 就叫 manifest.json,目录名一层裸名) */
export const MANIFEST_FILE = 'manifest.json'
export const ENTRY_FILE = 'index.js'
export const README_FILE = 'README.md'

/** §6 R-1 缓解①:这段是验收项 A-12 要逐字出现在 UI 上的那句,模板与 README 复用同一个常量 */
export const PERMISSION_TEXT = '插件能读写你的 Godot 项目文件、能调用 ZTools 的全部宿主 API，并可以通过宿主 API 进一步提权。它拿不到裸 Node，但这不构成安全边界。只装你信任的。'

export interface ScaffoldFile {
  /** 插件目录内的相对路径(裸名,正斜杠) */
  rel: string
  text: string
}

/** 已经存在的插件(来自 `listToolPlugins` 的条目,形状故意收得很窄) */
export interface ExistingTool {
  id?: string
  dirName?: string
  name?: string
  /** 'builtin' 的冲突要单独说:注册时先注册者保留,用户插件会被顶掉 */
  source?: string
}

/** 用户/界面给的生成本意;运行时按**未校验数据**处理(坏值一律拒生成,不猜) */
export interface ScaffoldInput {
  kind?: unknown
  id?: unknown
  name?: unknown
  summary?: unknown
  cmds?: unknown
  capabilities?: unknown
  tags?: unknown
  author?: unknown
  version?: unknown
}

export type ScaffoldResult =
  | { ok: true, dirName: string, manifest: ToolManifest, files: ScaffoldFile[], notice: string }
  | { ok: false, errors: string[] }

function str(v: unknown): string { return typeof v === 'string' ? v : '' }

/**
 * id / 目录名冲突判据。返回一句能直接显示的原因,没冲突返回空串。
 *
 * 比对一律先小写:目录名 = id,而 Windows 上 `MyTool` 与 `mytool` 是同一个目录。
 * 合法 id 天生只有小写(manifest.ts 的 `ID_RE`),所以这条只是把**磁盘上来的 dirName** 那一侧抹平。
 */
export function idConflictReason(id: unknown, existing: ExistingTool[]): string {
  const key = str(id).trim().toLowerCase()
  if (!key) return ''
  const list = Array.isArray(existing) ? existing : []
  for (const e of list) {
    const eid = str(e && e.id).trim().toLowerCase()
    if (eid && eid === key) {
      const who = str(e && e.name) || key
      return str(e && e.source) === 'builtin'
        ? `id「${key}」已被内置工具「${who}」占用:注册时先注册者保留,你的插件会被顶掉而列表里看不到原因。换个 id。`
        : `id「${key}」已被插件「${who}」占用(目录 ${str(e && e.dirName) || key})。换个 id,或先卸载那个。`
    }
  }
  for (const e of list) {
    const dir = str(e && e.dirName).trim().toLowerCase()
    if (dir && dir === key) {
      const eid = str(e && e.id).trim()
      return `插件目录「${dir}」已经存在(${eid ? `它那份 manifest 的 id 是 ${eid}` : '它那份 manifest 读不出 id'},骨架要生成的目录与之撞名。`
    }
  }
  return ''
}

/** 按生成意图拼出 manifest 的**原始对象**(未校验;校验在 buildSkeleton 里做) */
function manifestOf(kind: 'action' | 'view', input: ScaffoldInput): Record<string, unknown> {
  const id = str(input.id).trim()
  const name = str(input.name).trim() || id
  const m: Record<string, unknown> = {
    id,
    name,
    version: str(input.version).trim() || '0.1.0',
    apiVersion: 1,
    kind,
    ui: kind === 'view' ? 'render' : 'schema',
    summary: str(input.summary).trim() || '骨架示例:请改这句(它显示在工具箱列表里)',
    cmds: Array.isArray(input.cmds) ? input.cmds : [id],
    entry: ENTRY_FILE,
    // 新写的东西默认就是「未完成」:列表里带灰标、默认不启用(DEV-6),
    // 而 README 与提示语承诺的正是这一档 —— 少了这行,那两处措辞就是空头支票
    status: 'dev',
    capabilities: Array.isArray(input.capabilities)
      ? input.capabilities
      : (kind === 'view' ? ['tree', 'text', 'ui'] : ['tree', 'text', 'write'])
  }
  if (input.tags !== undefined) m.tags = input.tags
  if (str(input.author).trim()) m.author = str(input.author).trim()
  return m
}

/**
 * entry 模板正文。
 *
 * 注释里那三条是「纯契约补充」定死的内容(§F:改它们就是 apiVersion+1),
 * 权限面那段是 §6 R-1 缓解①的逐字文案 —— 这两块不许在生成后被模板自己改写。
 */
function entryText(kind: 'action' | 'view', id: string): string {
  const head = [
    `// ${id} · Godot 工坊工具插件(apiVersion 1)`,
    '//',
    '// 这个文件由框架按 ES 模块执行(顶层 export 就是插件交出去的接口),没有别的入口。',
    '//',
    '// ── entry 契约(改这些语义 = apiVersion 加 1 = 现有插件全部失效,别随手改)──────────',
    '//   export const schema   = [ ... ]                      // 参数声明;ui:\'schema\' 时必填,没有参数就给空数组',
    '//   export async function plan(ctx, files, params)       // 只算不写,返回 Change[]',
    '//   export async function apply(ctx, change)             // 只写这一条,返回 {ok, text?, error?}',
    '//   export function view(ctx, files)                     // kind:\'view\' 时必填,用 ctx.vue.h 渲染',
    '//',
    '// ── 三条必须记住的语义 ──',
    '// 1) `Change.id` 是**稳定键**:预览 → 勾选 → 执行三步之间要认出「还是那一条」。',
    `//    不给 id 时框架按 \`${id}:<kind>:<rel>\` 补一个;自己写就别含时间戳、别含数组序号。`,
    '// 2) `files` 由框架给(用户在界面上勾了哪些文件),**不许**自己去 ctx.scanTree 猜选中集,',
    '//    否则「用户到底选了哪些」同时存在两个真源。',
    '// 3) 取消:`ctx.cancelled` 是布尔快照,`ctx.onCancel(fn)` 挂回调。plan 与 apply 的循环里都要查它并',
    '//    **提前返回已完成部分**;没处理的条由框架记进账本,原因固定「已取消」。',
    '//',
    '// ── 权限面(§6 R-1,逐字)──',
    `// ${PERMISSION_TEXT}`,
    '// 框架只挡「手滑的合法插件」:越界改动强制升为 high 风险、写盘前先落备份、删除一律进回收站。',
    '// 它挡不住恶意插件 —— 这段代码能拿到 window 与 globalThis:这里没有沙箱也没有隔离,别按「已被隔离」写代码。',
    ''
  ]
  return head.join('\n') + (kind === 'view' ? VIEW_BODY : ACTION_BODY)
}

const ACTION_BODY = [
  "// ui:'schema' ⇒ 界面由框架按这份声明画,插件一行 UI 都不写。",
  "// 字段类型第 1 批只有:text / textarea / number / boolean / select / regex(只计数不高亮) / files(限项目内)。",
  "// 键名以 src/toolkit/schema.ts 的 FieldDesc 为准:说明用 help、默认值用 def(select 的选项用 {value, label})。",
  "// 写成 hint / default 不会报错,只会被校验器当陌生键丢掉 —— 表单于是少了说明、默认值也回落到 false。",
  "export const schema = [",
  "  {",
  "    key: 'targets',",
  "    label: '要标注的文件',",
  "    type: 'files',",
  "    exts: ['.gd'],",
  "    multiple: true,",
  "    help: '框架按这里声明的后缀过滤项目文件,勾中的会作为 plan() 的 files 参数交给你'",
  "  },",
  "  {",
  "    key: 'mark_lines',",
  "    label: '同时统计行数',",
  "    type: 'boolean',",
  "    def: true,",
  "    help: '关掉它,下面那段演示逻辑就只加一行注释'",
  "  }",
  "]",
  "",
  '/** 只算不写:返回「打算对哪些文件做什么」。框架负责预览、勾选、备份、执行、记账本。 */',
  'export async function plan(ctx, files, params) {',
  '  const changes = []',
  '  for (const f of files) {',
  '    // 循环里查取消:被跳过的条不用自己编失败原因,框架会记「已取消」',
  '    if (ctx.cancelled) break',
  '    // ctx.readText 给的是 { text, truncated, skippedBinary, bytes, error } —— 后两种是「调用成功但没给正文」,',
  '    // 拿它们改写就等于把半个文件(或一个二进制)写回去。判据:没拿到完整正文就不动,而不是猜。',
  '    const r = await ctx.readText(f.rel)',
  "    if (r.error) { ctx.log('warn', `读不到 ${f.rel}:${r.error}`); continue }",
  "    if (r.truncated || r.skippedBinary) { ctx.log('warn', `${f.rel}:没拿到完整正文,这次不改写`); continue }",
  '    const body = String(r.text)',
  '    const mark = params.mark_lines ? ` (共 ${body.split("\\n").length} 行)` : ""',
  '    const next = `# gpm 骨架示例:这一行是演示添加的,改你自己的逻辑\\n` + body',
  '    changes.push({',
  '      rel: f.rel,',
  "      kind: 'rewrite',",
  '      label: `加一行演示注释${mark}`,',
  "      risk: 'low',",
  "      reason: '只在文件头追加一行注释,原文一字不动;写盘前框架已落备份,可一键还原',",
  '      // 正文在这里就算好放 payload.text ⇒ 预览阶段能看到 diff。',
  "      // 想等执行那一刻再算(例如要读回盘上的最新内容),就实现下面的 apply()。",
  '      payload: { text: next }',
  '    })',
  '  }',
  '  if (!changes.length) ctx.notify(\'这个骨架的 plan 没找到要改的文件:先勾选中文件再执行\')',
  '  return changes',
  '}',
  '',
  '// apply 可以不实现:上面每条 change 的 payload.text 就是正文。',
  '// 需要「执行时才产出正文」时把它打开 —— 只处理传进来的那一条,别顺手改别的文件。',
  '// export async function apply(ctx, change) {',
  '//   const text = await ctx.readText(change.rel)',
  "//   if (!text.ok) return { ok: false, error: `读不到 ${change.rel}:${text.error}` }",
  '//   return { ok: true, text: \'# 改你自己的逻辑\\n\' + String(text.content) }',
  '// }',
  ''
].join('\n')

const VIEW_BODY = [
  "// kind:'view' ⇒ ui 必须是 'render',界面由插件自己画,框架只给 ctx.vue(= vue 的 h/ref/computed/onMounted)。",
  '// 主题令牌在渲染层已经挂好:颜色只用 var(--text)/--text-2/--text-3/--bg/--surface/--brand/--ok/--warn/--danger,',
  '// 尺寸写字面 px(本仓库没有间距令牌)。**不要**引入 Tailwind/shadcn,也不要新增 CSS 变量。',
  'export function view(ctx, files) {',
  "  const { h, ref, onMounted } = ctx.vue",
  '  const shown = ref(0)',
  "  onMounted(() => { shown.value = files.length })",
  '  return h(\'div\', { class: \'gpm-view\' }, [',
  "    h('p', null, `${ctx.toolName} 跑起来了。当前项目: ${ctx.projectId || '(没选项目)'}`),",
  "    h('p', null, `框架交给你 ${shown.value} 个选中文件。改这个文件试试: ${ctx.toolId}/index.js`),",
  "    h('button', { onClick: () => ctx.notify('点了按钮,通知走的是宿主 ZTools.notify') }, '点我'),",
  '  ])',
  '}',
  ''
].join('\n')

/** README:三条判据的作者视角版本 + 装进去的下一步 */
function readmeText(kind: 'action' | 'view', id: string, dirName: string): string {
  return [
    `# ${id}(Godot 工坊工具骨架)`,
    '',
    `骨架生成的目录 \`${dirName}/\` 里只有三个文件:\`${MANIFEST_FILE}\`(元数据与能力声明)、\`${ENTRY_FILE}\`(逻辑)、这份 README。`,
    `把它放进工具目录(默认 \`~/.gpm-tools/\`,可在工具箱首页改),回工具箱首页点「重新扫描」就会出现。`,
    '',
    '## 先读这一段:权限面',
    '',
    `> ${PERMISSION_TEXT}`,
    '',
    '框架挡的是「手滑的合法插件」:越界改动强制升为高风险并单独分组、写盘前先落备份、删除一律进回收站、',
    `账本记住每个文件的备份名以便一键还原。**框架挡不住恶意插件**,别把它当沙箱。`,
    '',
    '## 下一步改哪里',
    '',
    kind === 'action'
      ? [
          '1. `manifest.json` 的 `name` / `summary` / `cmds`(关键词撞了内置入口或别的插件时,列表会标黄并说明被谁占用)。',
          '2. `index.js` 的 `schema`(要哪些参数)与 `plan`(要对每个文件做什么)。',
          '3. 正文在 `plan` 里算好放 `payload.text` 就能看到 diff 预览;要执行时才算就实现 `apply`。'
        ].join('\n')
      : [
          '1. `manifest.json` 的 `name` / `summary` / `cmds`。',
          '2. `index.js` 的 `view(ctx, files)` —— 用 `ctx.vue.h` 画。',
          '3. 要裸写文件得在 manifest 里加 `"unsafe": true`,列表会把它标红;能不走这条路就别走。'
        ].join('\n'),
    '',
    '## 这个骨架的 status 是 `dev`',
    '',
    '所以它出现在列表里会带「未完成」标记,并且**默认没启用** —— 打开列表里那个开关才会出现在 ZTools 搜索框里。',
    '写完把 `status` 改成 `stable`(或直接删掉这个字段)。',
    '',
    '## 三个最容易踩的空头支票',
    '',
    '- `Change.id` 是**稳定键**:自己给时不要放时间戳或数组序号 —— 预览、勾选、执行三步之间要认出「还是那一条」。',
    '- 不要用 `ctx.scanTree` 去猜用户选了哪些文件:`plan(ctx, files, params)` 的 `files` 就是唯一真源。',
    '- `plan`/`apply` 的循环里要查 `ctx.cancelled` 并提前返回已完成部分。',
    ''
  ].join('\n')
}

/** 生成后要给用户看的那句(措辞在这里,渲染层不复述) */
function noticeFor(dirName: string): string {
  return `骨架已生成到 ${dirName}/。回工具箱首页点「重新扫描」才会出现在列表里;它是 status:dev,默认没启用,要手动打开。`
}

/**
 * 生成骨架的文件集(纯函数,不落盘)。
 *
 * 拒绝生成的三种情况,原因都直接可显示:kind 不是 action/view、id 与已有插件或目录撞名、
 * 模板产出的 manifest 过不了自己的校验器。第三种是**自检**:模板与校验器漂移时在这里炸,
 * 而不是让用户装出一个被拒载的插件。
 */
export function buildSkeleton(input: ScaffoldInput, existing: ExistingTool[]): ScaffoldResult {
  const errors: string[] = []
  const kindRaw = str(input && input.kind).trim()
  if (kindRaw !== 'action' && kindRaw !== 'view') {
    return { ok: false, errors: [`kind 只能是 ${SCAFFOLD_KINDS.join(' / ')},现在是「${kindRaw || str(input && input.kind) || '缺失'}」`] }
  }
  const kind = kindRaw as 'action' | 'view'
  const id = str(input && input.id).trim()
  const clash = idConflictReason(id, Array.isArray(existing) ? existing : [])
  if (clash) errors.push(clash)
  if (errors.length) return { ok: false, errors }

  const raw = manifestOf(kind, input || {})
  const files: ScaffoldFile[] = [
    { rel: MANIFEST_FILE, text: `${JSON.stringify(raw, null, 2)}\n` },
    { rel: ENTRY_FILE, text: entryText(kind, id) },
    { rel: README_FILE, text: readmeText(kind, id, id) }
  ]
  const checked = validateManifest(raw, { files: files.map((f) => f.rel) })
  if (!checked.ok) {
    return { ok: false, errors: checked.issues.map((i) => `骨架模板产出的 manifest 过不了校验(${i.field}):${i.message}`) }
  }
  return { ok: true, dirName: id, manifest: checked.manifest, files, notice: noticeFor(id) }
}
