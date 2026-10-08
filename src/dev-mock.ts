// 假宿主:只为本地版面手测存在,不参与打包(vite.config.js 没有配 rollupOptions.input,
// 默认只构建 index.html,所以这个入口不会被带进 src-ztools/dist)。
//
// 为什么需要它:main.ts:22-30 明确「直接用浏览器访问 dev 地址会因缺少 ZTools API 而无法运行」,
// 于是 5 套色板 × 2 种明暗 × 3 档宽度的版面穷举只能靠肉眼在真宿主里点 —— 而 theme-system.md:52-56
// 早就说过「靠肉眼穷举 10 种组合不现实」。这里给一个够用就好的宿主,把版面问题从真宿主里剥出来。
//
// 它不是测试替身,也不验数据正确性:scanProjectTree 返回的是写死的清单,
// 任何关于「体检报得对不对」的判断仍然只能在真宿主做(docs/manual-verification.md 那 52 条不变)。
import { createApp } from 'vue'
import './main.css'
import App from './App.vue'
import { useTheme } from './composables/useTheme'

const PROJECT = {
  _id: 'godot/project/p1',
  id: 'p1',
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

const docs = new Map<string, any>([
  [PROJECT._id, { ...PROJECT }],
  ['godot/settings', { theme: 'steel', mode: 'auto' }],
  ['godot/version/4.7.2', { _id: 'godot/version/4.7.2', name: 'Godot 4.7.2', tag: '4.7.2-stable', exePath: 'E:/mock/godot.exe' }]
])

const ok = <T,>(v: T) => Promise.resolve(v)

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
  showOpenDialog: () => Promise.resolve(null),
  db: {
    get: (id: string) => docs.get(id) || null,
    put: (doc: any) => { docs.set(doc._id, doc); return { ok: true, id: doc._id } },
    remove: (doc: any) => { docs.delete(doc._id); return { ok: true } },
    allDocs: (prefix?: string) =>
      [...docs.values()].filter((d) => !prefix || String(d._id).startsWith(prefix))
  }
} as any

/** 工具页真正会调到的那几个,给真实形状;其余一律兜底并打日志(兜底不是实现,日志要说得出漏了谁) */
const PROVIDED: Record<string, any> = {
  currentPlatform: () => ok('windows'),
  scanProjectTree: () => ok({ ok: true, files: TREE.map((t) => ({ ...t })), truncated: false }),
  readProjectText: (pid: string, rel: string) =>
    ok({ ok: true, text: TEXTS[rel] ?? '', bytes: (TEXTS[rel] ?? '').length, truncated: false }),
  writeProjectText: (pid: string, rel: string) => ok({ ok: true, backupRel: `${rel}.gpm-bak-mock` }),
  movePathsToTrash: (pid: string, rels: string[]) => ok({ ok: true, moved: rels.length, failed: [] }),
  hashPaths: (pid: string, rels: string[]) =>
    ok({ hashes: rels.map((rel) => ({ rel, sha256: 'a'.repeat(64) })), failed: [] }),
  getProjectCacheInfo: () => ok({ ok: true, bytes: 6_294_016, stale: 2, entries: 4 }),
  cleanProjectCache: () => ok({ ok: true, removed: 0, failed: [] })
}

window.services = new Proxy(PROVIDED, {
  get(target, key: string) {
    if (key in target) return target[key]
    // App.vue 常驻订阅四个 watch*:不回调就会永远卡在「有任务在跑」的样子
    if (key.startsWith('watch')) return (cb: any) => { if (typeof cb === 'function') cb([]); return () => {} }
    if (key.startsWith('dismiss') || key.startsWith('cancel')) return () => ok({ ok: true })
    console.warn(`[dev-mock] 未提供的服务: ${String(key)}(夹具兜底成空列表,不代表宿主行为)`)
    return () => ok([])
  }
}) as unknown as typeof window.services

useTheme()
createApp(App).mount('#app')
