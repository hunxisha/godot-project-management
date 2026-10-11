// 假宿主:只为本地版面与整页手测存在,不参与打包(vite.config.js 没有配 rollupOptions.input,
// 默认只构建 index.html,所以这个入口不会被带进 src-ztools/dist)。
//
// 为什么需要它:main.ts:22-30 明确「直接用浏览器访问 dev 地址会因缺少 ZTools API 而无法运行」,
// 于是 5 套色板 × 2 种明暗 × 3 档宽度的版面穷举只能靠肉眼在真宿主里点 —— 而 theme-system.md:52-56
// 早就说过「靠肉眼穷举 10 种组合不现实」。这里给一个够用就好的宿主,把版面问题从真宿主里剥出来。
//
// 摆的形状照**真宿主**摆,不是照「页面想要什么」摆(那是把缺口藏起来):
//   · `window.services` 只有 `services.js:347` 那张表里的原语 —— **没有** getDoc/putDoc/removeDoc,
//     文档读写在渲染层走桥接层(`services/bridge.ts` → `window.ztools.db`);
//   · `setFeature` 回 `{ success, error? }`(不是 d.ts 声明的 boolean),且只按 `code` 去重;
//   · `getFeatures()` 只回动态 feature,看不到 `plugin.json` 那 5 个静态的。
//
// 它仍然不是测试替身,也不验数据正确性:这里的文件与插件都是内存里的假数据。
// 任何「报得对不对」的判断只能在真宿主做(docs/manual-verification.md)。
// ⚠ 已知缺口(§D #15,**本批按纪律不顺手修**):没给 `backupStats`,点「备份」tab 会 TypeError
//    (`BackupsView.vue:195` 读 `stats.byMode.zip`)。要补得照真实原语的返回形状补,随手编桩会让
//    「拿假宿主验备份 UI」变成假通过。
import { createApp } from 'vue'
import './main.css'
import App from './App.vue'
import { useTheme } from './composables/useTheme'

// 真宿主里 `id` 就是完整文档 id(`projectDocId(rootDir)`,preload `projects.js`),
// 与 `_id` 同值;之前这里写成短 id,页面把它交给 `scanProjectTree` 在真宿主上是读不到项目的。
const PROJECT = {
  _id: 'godot/project/p1',
  id: 'godot/project/p1',
  name: 'Demo 体检项目',
  path: 'E:/mock/demo',
  versionId: 'godot/version/4.7.2',
  favorite: false,
  openCount: 3,
  lastOpenedAt: Date.now()
}

/** 一棵故意埋了问题的清单:断链、重复键、大文件、缓存陈旧、未引用资源都要有得报 */
const TREE = [
  { rel: 'project.godot', size: 4096, mtimeMs: Date.now(), ext: 'godot' },
  { rel: 'scene/main.tscn', size: 8192, mtimeMs: Date.now(), ext: 'tscn' },
  { rel: 'scene/enemy-spawn-controller.tscn', size: 1200, mtimeMs: Date.now(), ext: 'tscn' },
  { rel: 'audio/bgm-loop-version-2-final.ogg', size: 5_242_880, mtimeMs: Date.now(), ext: 'ogg' },
  { rel: 'assets/ui/icon_atlas_large.png', size: 3_145_728, mtimeMs: Date.now(), ext: 'png' },
  { rel: 'scripts/player.gd', size: 300, mtimeMs: Date.now(), ext: 'gd' },
  { rel: 'scripts/player.gd.uid', size: 32, mtimeMs: Date.now(), ext: 'uid' },
  { rel: '.godot/imported/bgm-loop-version-2-final.oggstr', size: 6_291_456, mtimeMs: Date.now() - 86400000, ext: 'str' },
  { rel: '.godot/imported/icon_atlas_large.png.import', size: 2048, mtimeMs: Date.now(), ext: 'import' },
  { rel: '.godot/editor/project_metadata.cfg', size: 512, mtimeMs: Date.now(), ext: 'cfg' }
]

const TEXTS: Record<string, string> = {
  'project.godot': [
    'config_version=5',
    '',
    '[application]',
    '',
    'config/name="Demo"',
    'config/name="Demo 重复键"',
    'run/main_scene="res://scene/main.tscn"',
    'config/features=PackedStringArray("4.7", "Forward Plus")',
    '',
    '[input]',
    '',
    'move={"deadzone":0.5,"events":[]}',
    '',
    '[rendering]',
    '',
    'textures/vram_compression/import_etc2_astc=true'
  ].join('\n'),
  'scene/main.tscn': [
    '[gd_scene load_steps=3 format=3 uid="uid://cmain1"]',
    '',
    '[ext_resource type="Script" path="res://scripts/missing.gd" id="1_a"]',
    '[ext_resource type="PackedScene" path="res://scene/gone.tscn" id="2_b"]',
    '',
    '[node name="Root" type="Node2D"]',
    'script = ExtResource("1_a")',
    '',
    '[node name="Spawn" parent="." instance=ExtResource("2_b")]',
    ''
  ].join('\n'),
  'scene/enemy-spawn-controller.tscn': [
    '[gd_scene load_steps=2 format=3 uid="uid://cspawn1"]',
    '',
    '[node name="Root" type="Node2D"]',
    '',
    '[node name="Root" type="Node2D" parent="."]',
    ''
  ].join('\n'),
  'scripts/player.gd': 'extends CharacterBody2D\n\nfunc _ready() -> void:\n\tprint("hi")  \n\n\nfunc _process(delta: float) -> void:\n\tif Input.is_action_just_pressed("jump"):\n\t\tvelocity.y = -300\n',
  'scripts/player.gd.uid': 'uid://bplayer1\n',
  'assets/ui/icon_atlas_large.png.import': '[remap]\n\nimporter="texture"\ntype="CompressedTexture2D"\npath="res://.godot/imported/icon_atlas_large.png-abc.ctex"\n',
  'audio/bgm-loop-version-2-final.ogg.import': '[remap]\n\nimporter="ogg_vorbis"\ntype="AudioStreamOggVorbis"\npath="res://.godot/imported/bgm-loop-version-2-final.oggstr"\n'
}

// ---------- 可写的虚拟盘(读 → 改 → 回滚要真转得起来) ----------
//
// 原来是一口写死的 TEXTS:写完再读还是老内容,于是「执行→回执→还原」在这页面上验不出任何东西。
// 现在读返回 FILES 的当前内容,写会先把旧内容存成 `.gpm-bak-<ts>`(真宿主同一条约定,
// 见 `inspectfs.js:122` 附近),删除走 movePathsToTrash 并从清单里摘掉。
let FILES: Record<string, string> = { ...TEXTS }
const BINARY = new Set(TREE.filter((t) => !(t.rel in TEXTS)).map((t) => t.rel))
let INVENTORY = TREE.map((t) => ({ ...t }))
let bakSeq = 0
const extOf = (rel: string) => (rel.includes('.') ? (rel.split('.').pop() || '').toLowerCase() : '')
const sizeOf = (rel: string) => (rel in FILES ? FILES[rel].length : (BINARY.has(rel) ? (TREE.find((t) => t.rel === rel)?.size || 0) : 0))
function touch(rel: string) {
  const hit = INVENTORY.find((t) => t.rel === rel)
  if (hit) { hit.size = sizeOf(rel); hit.mtimeMs = Date.now() } else INVENTORY.push({ rel, size: sizeOf(rel), mtimeMs: Date.now(), ext: extOf(rel) })
}

// ---------- 改名假盘(`inspectfs.js:245-367` 的内存镜像) ----------

/** 真主机 `canonRel` + `resolveRel` 的合成版:反斜杠归一、丢空段与 `.`、`..`/绝对/盘符一律当非法 */
function canonRel(v: unknown): string {
  if (typeof v !== 'string' || !v) return ''
  const norm = v.replace(/\\/g, '/')
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return ''
  const stack: string[] = []
  for (const p of norm.split('/')) {
    if (!p || p === '.') continue
    if (p === '..') return ''
    stack.push(p)
  }
  return stack.join('/')
}

/** 边车尾缀:与真主机同一张表,名字一律「主 rel + 尾缀」重拼(`player.gd.uid`,不是 `player.uid`) */
const SIDECAR_SUFFIXES = ['.uid', '.import']

function allRels(): string[] {
  const s = new Set<string>(Object.keys(FILES))
  for (const t of INVENTORY) s.add(t.rel)
  for (const r of BINARY) s.add(r)
  return [...s]
}

/**
 * 假盘按 **Windows 语义**认「同一份文件」:大小写不敏感、拼法保留。
 * ⚠ 这是模仿,不是实测 —— 真宿主在这台机器上的行为仍是 TK-29(§D #17),别把这里跑通当已验。
 */
function diskKey(rel: string): string {
  const all = allRels()
  if (all.includes(rel)) return rel
  const l = rel.toLowerCase()
  return all.find((r) => r.toLowerCase() === l) || ''
}

/** 搬名字:内容跟着走,清单里的 `rel` / `ext` 跟着改,**mtimeMs 不动** —— 改名是同一份文件的移动,不重刷时间戳(DEV-11 判死「trash + write 拼假改名」靠的就是这条) */
function renameOnDisk(from: string, to: string) {
  const k = diskKey(from)
  if (!k) return
  if (k in FILES) {
    FILES[to] = FILES[k]
    if (k !== to) delete FILES[k]
  }
  if (BINARY.has(k)) { BINARY.delete(k); BINARY.add(to) }
  const hit = INVENTORY.find((t) => t.rel === k)
  if (hit) { hit.rel = to; hit.ext = extOf(to); hit.size = sizeOf(to) }
}

// ---------- 假「工具目录」(~/.gpm-tools 的位置) ----------
//
// 目录是真的读盘、条目是真的执行;这里给的是同形状的内存版,所以「选文件→预览→执行→回执→账本→还原」
// 整页能在浏览器里点。**执行不是假加载器**:`useToolkit.REAL_DEPS.execute` 走的就是
// `URL.createObjectURL` + 动态 import,浏览器里那一段插件代码是真被 JS 引擎跑的。
// 「装进真宿主以后」的那一半(磁盘上的目录、asar、宿主 CSP)仍然只能真机验(A-10 / A-19)。
const TOOLS_DIR = 'E:/mock/.gpm-tools'
const MANIFEST_MAX_BYTES = 256 * 1024

const DEMO_MANIFEST = JSON.stringify({
  id: 'demo-tag',
  name: '演示:末尾加标记',
  version: '1.0.0',
  apiVersion: 1,
  kind: 'action',
  ui: 'schema',
  summary: '假宿主里的第三方插件:勾几个 .gd,末尾各加一行注释,用来看整页在浏览器里跑起来的样子',
  cmds: ['演示标记', 'demotag'],
  entry: 'index.js',
  capabilities: ['tree', 'text', 'write', 'store', 'ui'],
  author: '版面夹具',
  tags: ['演示'],
  icon: 'pen'
}, null, 2)

/** 生成的插件代码是 ESM 文本(里面统一用双引号,省得在 TS 字面量里套转义) */
const DEMO_ENTRY = [
  '// 这只插件由假宿主提供:文本交进内存,执行走的是真机制(blob + 动态 import)。',
  'export const schema = [',
  "  { key: 'targets', label: '要加标记的文件', type: 'files', exts: ['.gd'], multiple: true, help: '框架按这里声明的后缀过滤项目文件,勾中的作为 plan 的 files' },",
  "  { key: 'mark', label: '标记内容', type: 'text', def: 'TODO', help: '追加到文件末尾那一行注释写什么' }",
  ']',
  '',
  'export async function plan(ctx, files, params) {',
  '  const mark = String(params && params.mark ? params.mark : "TODO")',
  '  const out = []',
  '  for (const f of files) {',
  '    if (ctx.cancelled) break',
  '    const r = await ctx.readText(f.rel)',
  "    if (r.error || r.truncated || r.skippedBinary) { ctx.log('warn', '读不到 ' + f.rel + ':' + (r.error || '没给完整正文')); continue }",
  '    if (r.text.split("\\n").some((l) => l.indexOf("# " + mark) >= 0)) continue',
  '    out.push({',
  '      rel: f.rel,',
  "      kind: 'rewrite',",
  '      label: "末尾加一行 # " + mark,',
  '      reason: "只追加一行,不动原有内容",',
  "      risk: 'low',",
  '      payload: { text: r.text + "\\n# " + mark + "\\n" }',
  '    })',
  '  }',
  '  return out',
  '}',
  '',
  'export async function apply(ctx, change) {',
  '  return { ok: true, text: change.payload.text }',
  '}'
].join('\n')

/** 目录名 → 该目录里的文件(相对路径 → 文本) */
const TOOLS: Record<string, Record<string, string>> = {
  'broken-manifest': { 'manifest.json': '{ "id": "broken", "name": "坏' },
  // 与内置那位的 cmds 撞同一个词:用来在浏览器里看 A-15「后装让位」的观感(不注册 feature、标黄、仍可打开)
  'clash-format': {
    'manifest.json': JSON.stringify({
      id: 'clash-format',
      name: '演示:关键词撞车',
      version: '1.0.0',
      apiVersion: 1,
      kind: 'action',
      ui: 'schema',
      summary: 'cmds 与内置的「格式化」撞车,用来看被让位那一行的标黄与说明(A-15)',
      cmds: ['格式化'],
      entry: 'index.js',
      capabilities: ['tree', 'text', 'write'],
      tags: ['演示']
    }, null, 2),
    'index.js': [
      '// 撞关键词用的最小插件:能被列出、能打开,plan 永远交空清单(它不参与这轮的观感验证)。',
      'export const schema = [',
      "  { key: 'targets', label: '要格式化的文件', type: 'files', exts: ['.gd'], multiple: true }",
      ']',
      'export async function plan() {',
      '  return []',
      '}'
    ].join('\n')
  },
  'demo-tag': { 'manifest.json': DEMO_MANIFEST, 'index.js': DEMO_ENTRY },
  'no-manifest': { 'README.md': '这个目录里没有 manifest.json —— 用来看「坏插件也列出来并带原因」那一行长什么样' }
}

/** 目录名合法性与越界闸的真判据在 `toolplugins.js`,这里只挡明显非法的(不是把它重写一遍) */
function pluginDirBad(name: unknown): boolean {
  return typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(name)
}
function relBad(rel: unknown): boolean {
  return typeof rel !== 'string' || rel === '' || rel.startsWith('/') || /^\.{0,2}[\\/]/.test(rel) || rel.includes('..') || /^[a-zA-Z]:/.test(rel)
}

const docs = new Map<string, any>([
  [PROJECT._id, { ...PROJECT }],
  ['godot/settings', { theme: 'steel', mode: 'auto' }],
  ['godot/version/4.7.2', { _id: 'godot/version/4.7.2', name: 'Godot 4.7.2', tag: '4.7.2-stable', exePath: 'E:/mock/godot.exe' }]
])

const ok = <T,>(v: T) => Promise.resolve(v)

/** 动态 feature 表:宿主那边存在 LMDB,**只按 code 去重**,不做 cmds 冲突检查(实测,见 §4.5) */
const FEATURES: any[] = []

window.ztools = {
  setExpendHeight: () => {},
  setSubInput: () => {},
  removeSubInput: () => {},
  hideMainWindow: () => {},
  onPluginEnter: () => {},
  isDarkColors: () => false,
  isDesktop: () => true,
  isWindows: () => true,
  isMacOS: () => false,
  isLinux: () => false,
  showNotification: (body: string) => console.log('[notify]', body),
  shellOpenPath: (p: string) => console.log('[open]', p),
  shellShowItemInFolder: (p: string) => console.log('[reveal]', p),
  shellOpenExternal: (u: string) => console.log('[ext]', u),
  // 宿主这两个是**同步**返回值(d.ts:531 `string[]|undefined`、:543 `string|undefined`),
  // 原来给的是 Promise —— 形状不对,而且永远「取消」,对话框那一条 UI 就验不到。
  showOpenDialog: (o?: any) => {
    const dir = !!(o && Array.isArray(o.properties) && o.properties.includes('openDirectory'))
    console.log('[dev-mock] showOpenDialog', o)
    return dir ? ['E:/mock/demo'] : ['E:/mock/demo/scripts/player.gd']
  },
  showSaveDialog: (o?: any) => { console.log('[dev-mock] showSaveDialog', o); return 'E:/mock/out.json' },
  /** 回 `{ success, error? }`,不是 `ztools.api.d.ts:489` 声明的 boolean(R-6:按 boolean 判会永远为真) */
  setFeature: (f: any) => {
    if (!f || typeof f.code !== 'string' || !Array.isArray(f.cmds)) return { success: false, error: 'feature 需要 code 与 cmds' }
    const i = FEATURES.findIndex((x) => x.code === f.code)
    if (i >= 0) { FEATURES[i] = f } else { FEATURES.push(f) }
    console.log('[dev-mock] setFeature', f.code, '→ 动态 feature 共', FEATURES.length, '条')
    return { success: true }
  },
  removeFeature: (c: any) => {
    const codes = Array.isArray(c) ? c : [c]
    for (const code of codes) {
      const i = FEATURES.findIndex((x) => x.code === code)
      if (i >= 0) FEATURES.splice(i, 1)
    }
    return { success: true }
  },
  /** 只回动态 feature(看不到 plugin.json 里那 5 个静态的 —— 冲突判据由 features.ts 自己补齐) */
  getFeatures: () => FEATURES.map((f) => ({ ...f })),
  db: {
    get: (id: string) => docs.get(id) || null,
    put: (doc: any) => { docs.set(doc._id, doc); return { ok: true, id: doc._id } },
    remove: (doc: any) => { docs.delete(doc._id); return { ok: true } },
    allDocs: (prefix?: string) =>
      [...docs.values()].filter((d) => !prefix || String(d._id).startsWith(prefix))
  }
} as any

/** 工具箱会调到的那几个,给真实形状;其余一律兜底并打日志(兜底不是实现,日志要说得出漏了谁) */
const PROVIDED: Record<string, any> = {
  currentPlatform: () => ok('windows'),
  // 清单跟着虚拟盘走:exts 过滤与 includeCache 的默认排除都照 `inspectfs.js` 的语义摆
  scanProjectTree: (pid: string, opts?: { includeCache?: boolean, exts?: string[] }) => {
    const o = opts || {}
    const exts = Array.isArray(o.exts) ? o.exts.map((e) => String(e).replace(/^\./, '').toLowerCase()) : []
    let files = INVENTORY.filter((t) => o.includeCache === true || !t.rel.startsWith('.godot/'))
    if (exts.length) files = files.filter((t) => exts.includes(t.ext || extOf(t.rel)))
    return ok({ ok: true, files: files.map((t) => ({ ...t })), truncated: false })
  },
  readProjectText: (pid: string, rel: string) => {
    if (rel in FILES) return ok({ ok: true, text: FILES[rel], bytes: FILES[rel].length, truncated: false, skippedBinary: false })
    if (BINARY.has(rel)) return ok({ ok: true, bytes: sizeOf(rel), skippedBinary: true })
    return ok({ ok: false, error: `文件不存在: ${rel}` })
  },
  writeProjectText: (pid: string, rel: string, text: string, opts?: { backup?: boolean }) => {
    if (typeof text !== 'string') return ok({ ok: false, error: '内容不是文本' })
    let backupRel: string | undefined
    if (rel in FILES && opts?.backup !== false) {
      backupRel = `${rel}.gpm-bak-${Date.now()}-${++bakSeq}`
      FILES[backupRel] = FILES[rel]
      touch(backupRel)
    }
    FILES[rel] = text
    touch(rel)
    return ok({ ok: true, bytes: text.length, backupRel })
  },
  // 改名(含边车)。返回形状与错误串照 `inspectfs.js:292-367`,不是照「页面想要什么」摆(G-14)。
  // ⚠ 假盘是扁平的内存表,**没有目录** ⇒ `'目录改名不支持'` 与 `'目标目录不存在'` 这两串在这里
  //    永远不会出现。它们只有真宿主验得到(§12),不许因为这一条没触发就当已覆盖。
  renameProjectPath: (pid: string, rel: string, to: string, opts?: { sidecar?: boolean }) => {
    const o = opts || {}
    const fromRel = canonRel(rel)
    const toRel = canonRel(to)
    if (!fromRel || !toRel) return ok({ ok: false, error: '非法路径' })
    if (fromRel === toRel) return ok({ ok: false, error: '改名前后是同一个名字' })
    // project.godot 是项目身份:改名等于把这份登记作废(与真宿主同一串)
    if (fromRel === 'project.godot') return ok({ ok: false, error: '项目主配置文件不改名' })
    if (!diskKey(fromRel)) return ok({ ok: false, error: '文件不存在' })
    if (diskKey(toRel) && diskKey(toRel) !== diskKey(fromRel)) return ok({ ok: false, error: '目标已存在' })

    const pairs = [{ from: fromRel, to: toRel }]
    if (o.sidecar !== false) {
      for (const suffix of SIDECAR_SUFFIXES) {
        const s = fromRel + suffix
        const d = toRel + suffix
        if (!diskKey(s)) {
          // 源没有边车可搬,但新名的边车槽位已经躺着别人的东西 ⇒ 照真主机一样在动盘之前拒
          if (diskKey(d)) return ok({ ok: false, error: '目标已存在' })
          continue
        }
        if (diskKey(d) && diskKey(d) !== diskKey(s)) return ok({ ok: false, error: '目标已存在' })
        pairs.push({ from: s, to: d })
      }
    }
    for (const p of pairs) renameOnDisk(p.from, p.to)
    return ok({ ok: true, from: fromRel, to: toRel, moved: pairs.map((p) => ({ ...p })) })
  },
  movePathsToTrash: (pid: string, rels: string[]) => {
    const list = Array.isArray(rels) ? rels : []
    const failed: { rel: string, error: string }[] = []
    let moved = 0
    for (const rel of list) {
      const known = rel in FILES || BINARY.has(rel) || INVENTORY.some((t) => t.rel === rel)
      if (!known) { failed.push({ rel, error: '文件不存在' }); continue }
      delete FILES[rel]
      INVENTORY = INVENTORY.filter((t) => t.rel !== rel)
      moved++
    }
    return ok({ ok: failed.length === 0, moved, failed })
  },
  // 假哈希:内容派生、稳定,但**不是** SHA-256(界面只关心「两个不一样」);别拿它验正确性
  hashPaths: (pid: string, rels: string[]) => {
    const list = Array.isArray(rels) ? rels : []
    const hashes: { rel: string, sha256: string }[] = []
    const failed: { rel: string, error: string }[] = []
    for (const rel of list) {
      if (!(rel in FILES)) { failed.push({ rel, error: '文件不存在' }); continue }
      let h = 0x811c9dc5
      for (let i = 0; i < FILES[rel].length; i++) { h ^= FILES[rel].charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
      hashes.push({ rel, sha256: (h.toString(16).padStart(8, '0') + h.toString(16).padStart(8, '0')).repeat(8).slice(0, 64) })
    }
    return ok({ ok: failed.length === 0, hashes, failed })
  },
  getProjectCacheInfo: () => ok({ ok: true, bytes: 6_294_016, stale: 2, entries: 4 }),
  cleanProjectCache: () => ok({ ok: true, removed: 0, failed: [] }),

  // ---- 工具箱那四条项目外路径的原语(形状照 `types/services.ts:249-278` 与 `toolplugins.js`) ----
  toolsRoot: () => ok({ ok: true, dir: TOOLS_DIR, source: 'default', error: '' }),
  listToolPlugins: (dir?: string) => {
    const root = typeof dir === 'string' && dir ? dir : TOOLS_DIR
    const entries = Object.keys(TOOLS).sort().map((name) => {
      const files = Object.keys(TOOLS[name])
      const base = { name, abs: `${root}/${name}`, manifestText: '', files, bytes: 0 }
      if (pluginDirBad(name)) {
        return { ...base, error: '目录名不合法:只能用小写字母、数字、点、下划线和短横线,首字符必须是字母或数字' }
      }
      const mf = files.includes('manifest.json') ? TOOLS[name]['manifest.json'] : null
      if (mf === null) return { ...base, error: '缺 manifest.json' }
      if (mf.length > MANIFEST_MAX_BYTES) {
        return { ...base, error: `manifest.json 过大(${mf.length} 字节 > ${MANIFEST_MAX_BYTES}),没有解析` }
      }
      return { ...base, manifestText: mf, bytes: mf.length }
    })
    return ok({ ok: true, dir: root, created: false, error: '', entries })
  },
  readToolPlugin: (dir: string, pluginDir: string, rel: string) => {
    if (pluginDirBad(pluginDir) || relBad(rel)) return ok({ ok: false, error: '非法路径' })
    const text = TOOLS[pluginDir] ? TOOLS[pluginDir][rel] : undefined
    if (typeof text !== 'string') return ok({ ok: false, error: `文件不存在: ${pluginDir}/${rel}` })
    return ok({ ok: true, text, bytes: text.length, truncated: false, skippedBinary: false })
  },
  writeToolPlugin: (dir: string, pluginDir: string, files: { rel: string, text: string }[], opts?: { overwrite?: boolean }) => {
    const res = { ok: false, dir: typeof dir === 'string' ? dir : '', written: [] as string[], failed: [] as { rel: string, error: string }[], error: '' }
    if (pluginDirBad(pluginDir)) { res.error = '非法路径'; return ok(res) }
    const list = Array.isArray(files) ? files : []
    if (!TOOLS[pluginDir]) TOOLS[pluginDir] = {}
    for (const f of list) {
      const rel = f && typeof f.rel === 'string' ? f.rel : ''
      if (!rel || relBad(rel)) { res.failed.push({ rel: rel || '(缺 rel)', error: '非法路径' }); continue }
      if (!f || typeof f.text !== 'string') { res.failed.push({ rel, error: '内容不是文本' }); continue }
      const exists = typeof TOOLS[pluginDir][rel] === 'string'
      if (exists && opts?.overwrite !== true) { res.failed.push({ rel, error: '文件已存在,未覆写(要覆盖得显式同意)' }); continue }
      TOOLS[pluginDir][rel] = f.text
      res.written.push(rel)
    }
    // 与 `toolplugins.js:450` 同一条判据:写成才算 ok,而且原因要说得出
    res.ok = res.failed.length === 0 && res.written.length > 0
    if (!res.ok && !res.error) res.error = res.failed.length ? '有文件没写成' : '一个文件都没写成'
    return ok(res)
  }
}

window.services = new Proxy(PROVIDED, {
  get(target, key: string) {
    if (key in target) return target[key]
    // 兜底**不许**给 `then` / `catch`,也不给 symbol 键:`ScaffoldDialog.vue:36` 写的是
    // `await window.services`(真宿主上那是个普通对象,读 .then 得 undefined 就原样通过)。
    // 这里一给函数,整个 Proxy 就被当成 thenable,而兜底函数从不 resolve ⇒ 界面卡在「生成中」永不返回。
    if (typeof key !== 'string' || key === 'then' || key === 'catch' || key === 'finally') return undefined
    // App.vue 常驻订阅四个 watch*:不回调就会永远卡在「有任务在跑」的样子
    if (key.startsWith('watch')) return (cb: any) => { if (typeof cb === 'function') cb([]); return () => {} }
    if (key.startsWith('dismiss') || key.startsWith('cancel')) return () => ok({ ok: true })
    console.warn(`[dev-mock] 未提供的服务: ${String(key)}(夹具兜底成空列表,不代表宿主行为)`)
    return () => ok([])
  }
}) as unknown as typeof window.services

useTheme()
createApp(App).mount('#app')
