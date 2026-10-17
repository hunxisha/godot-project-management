// 假宿主:只为本地版面手测存在,不参与打包(vite.config.js 没有配 rollupOptions.input,
// 默认只构建 index.html,所以这个入口不会被带进 src-ztools/dist)。
//
// 为什么需要它:main.ts:22-30 明确「直接用浏览器访问 dev 地址会因缺少 ZTools API 而无法运行」,
// 于是 5 套色板 × 2 种明暗 × 3 档宽度的版面穷举只能靠肉眼在真宿主里点 —— 而 theme-system.md:52-56
// 早就说过「靠肉眼穷举 10 种组合不现实」。这里给一个够用就好的宿主,把版面问题从真宿主里剥出来。
//
// 它不是测试替身,也不验数据正确性:scanProjectTree 返回的是写死的清单,
// 任何关于「读到的文件对不对」的判断仍只能在真宿主做。
// (原注引用的「体检那 52 条」已随 2026-10-13 工具页拆除作废;仍然待验的是 §7~§9,见 docs/manual-verification.md 顶部。)
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

const DAY = 86_400_000
const HOUR = 3_600_000
const startOfToday = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime()

/** 备份页版面夹具:覆盖分组/时间轴、zip/快照、缺失、孤立、已校验/无效/未校验各种形态 */
const BACKUPS: any[] = [
  { _id: 'godot/backup/b1', projectId: 'godot/project/p1', projectName: 'Demo 体检项目', mode: 'zip', destPath: 'E:/mock/backups/Demo_发布前.zip', size: 18_934_784, fileCount: 214, createdAt: startOfToday - 3 * HOUR, label: '发布前', level: 6, engineVersion: '4.7.2', verified: true, verifiedAt: Date.now() - HOUR },
  { _id: 'godot/backup/b2', projectId: 'godot/project/p1', projectName: 'Demo 体检项目', mode: 'copy', destPath: 'E:/mock/backups/Demo_snap_0930', size: 55_842_112, fileCount: 431, createdAt: startOfToday - 2 * DAY, includeCache: true, engineVersion: '4.7.2', verified: false, verifyError: '快照目录缺少 project.godot' },
  { _id: 'godot/backup/b3', projectId: 'godot/project/p1', projectName: 'Demo 体检项目', mode: 'zip', destPath: 'E:/mock/backups/Demo_2026-10-01.zip', size: 17_204_224, fileCount: 208, createdAt: startOfToday - 16 * DAY, level: 6, engineVersion: '4.7.2' },
  { _id: 'godot/backup/b4', projectId: 'godot/project/p2', projectName: '平台跳跃 Demo', mode: 'zip', destPath: 'E:/mock/backups/平台跳跃_0.9.zip', size: 8_388_608, fileCount: 96, createdAt: startOfToday - 26 * HOUR, label: '0.9 版', level: 9, engineVersion: '4.7.2', verified: true, verifiedAt: startOfToday - 26 * HOUR },
  { _id: 'godot/backup/b5', projectId: 'godot/project/p2', projectName: '平台跳跃 Demo', mode: 'zip', destPath: 'E:/mock/backups/平台跳跃_old.zip', size: 7_340_032, fileCount: 88, createdAt: startOfToday - 9 * DAY, missing: true },
  { _id: 'godot/backup/b6', projectId: 'godot/project/gone', projectName: '已删除的旧项目', mode: 'copy', destPath: 'E:/mock/backups/旧项目_snap', size: 12_582_912, fileCount: 150, createdAt: startOfToday - 20 * DAY, label: '归档' }
]

const docs = new Map<string, any>([
  [PROJECT._id, { ...PROJECT }],
  ['godot/project/p2', { _id: 'godot/project/p2', id: 'p2', name: '平台跳跃 Demo', path: 'E:/mock/platformer', versionId: 'godot/version/4.7.2', favorite: true, openCount: 12, lastOpenedAt: Date.now() - 2 * DAY }],
  ['godot/project/p3', { _id: 'godot/project/p3', id: 'p3', name: '塔防原型', path: 'E:/mock/td-prototype', versionId: 'godot/version/4.7.2', favorite: false, openCount: 1, lastOpenedAt: Date.now() - 30 * DAY }],
  ['godot/settings', {
    theme: 'steel',
    mode: 'auto',
    // 翻译默认关闭;手测版面时先打开,并塞一个假服务商,不然市场卡片永远是英文原文
    translateEnabled: true,
    translateTarget: 'zh-CN',
    translateProviders: [{ id: 'mock-openai', kind: 'openai', label: 'Mock AI', baseUrl: 'https://example.test/v1', model: 'mock-model' }],
    translateActiveId: 'mock-openai'
  }],
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
  // ---------- 备份页版面夹具 ----------
  listBackups: () => ok(BACKUPS.map((b) => ({ ...b }))),
  backupStats: () => {
    const covered = new Set(BACKUPS.map((b) => b.projectId))
    let totalSize = 0, missingCount = 0, zip = 0, copy = 0
    for (const b of BACKUPS) {
      totalSize += b.size || 0
      if (b.mode === 'copy') copy++; else zip++
      if (b.missing) missingCount++
    }
    const projects = [...docs.values()].filter((d) => String(d._id).startsWith('godot/project/'))
    return ok({
      count: BACKUPS.length,
      totalSize,
      missingCount,
      coveredProjects: projects.filter((p: any) => covered.has(p._id)).length,
      totalProjects: projects.length,
      byMode: { zip, copy }
    })
  },
  verifyBackup: (id: string) => {
    const b = BACKUPS.find((x) => x._id === id)
    return ok({ ok: true, valid: !b?.missing, error: b?.missing ? '备份文件已不存在' : undefined })
  },
  updateBackup: (id: string, patch: any) => {
    const b = BACKUPS.find((x) => x._id === id)
    if (!b) return ok({ ok: false, error: '备份记录不存在' })
    if ('label' in patch) {
      const next = String(patch.label || '').trim()
      if (next) b.label = next; else delete b.label
    }
    return ok({ ok: true })
  },
  deleteBackup: (id: string) => {
    const i = BACKUPS.findIndex((x) => x._id === id)
    if (i >= 0) BACKUPS.splice(i, 1)
    return ok({ ok: true })
  },
  deleteBackups: (ids: string[]) => {
    for (const id of ids) {
      const i = BACKUPS.findIndex((x) => x._id === id)
      if (i >= 0) BACKUPS.splice(i, 1)
    }
    return ok({ ok: true, removed: ids.length, failed: [] })
  },
  scanProjectTree: () => ok({ ok: true, files: TREE.map((t) => ({ ...t })), truncated: false }),
  readProjectText: (pid: string, rel: string) =>
    ok({ ok: true, text: TEXTS[rel] ?? '', bytes: (TEXTS[rel] ?? '').length, truncated: false }),
  writeProjectText: (pid: string, rel: string) => ok({ ok: true, backupRel: `${rel}.gpm-bak-mock` }),
  movePathsToTrash: (pid: string, rels: string[]) => ok({ ok: true, moved: rels.length, failed: [] }),
  hashPaths: (pid: string, rels: string[]) =>
    ok({ hashes: rels.map((rel) => ({ rel, sha256: 'a'.repeat(64) })), failed: [] }),
  getProjectCacheInfo: () => ok({ ok: true, bytes: 6_294_016, stale: 2, entries: 4 }),
  cleanProjectCache: () => ok({ ok: true, removed: 0, failed: [] }),
  // ---------- 翻译(回显式假译文:能看出「替换有没有发生」,不验质量) ----------
  // 富文本用 >…< 之间插「【译】」的方式伪造,标签结构原样留着,和真链路同一形状。
  translateParts: (payload: any) => {
    const items = (payload?.items || []).map((i: any) => ({
      key: i.key,
      text: i.kind === 'html' || i.kind === 'changes'
        ? String(i.text).replace(/>([^<>]{2,})</g, '>【译】$1<')
        : `【译】${i.text}`
    }))
    return ok({ ok: items.length > 0, items, failed: [], fromCache: 0 })
  },
  testTranslateProvider: () => ok({ ok: true, ms: 42, sample: '你好,世界' }),
  translateCacheInfo: () => ok({ count: 3, sizeBytes: 4096, entries: 12 }),
  translateCacheClear: () => ok({ ok: true, removed: 3 })
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
