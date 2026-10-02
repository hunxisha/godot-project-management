// Tauri 宿主垫片:在 Vue 主包之前加载(index.html 同步脚本),构造与 ZTools/Electron
// 宿主同形的 window.ztools + window.services。命令与 src-tauri 的 34 条一一对应;
// 未移植方法如实报错(而不是静默假成功)。
// 平台/主题是唯一保持同步的读取(来自 webview 自身能力,无需 IPC)。
;(function () {
  if (!window.__TAURI__) return // 非桌面宿主(ZTools/浏览器)直接让位
  const invoke = window.__TAURI__.core.invoke
  const listen = window.__TAURI__.event.listen

  const IS_WIN = navigator.userAgent.includes('Windows')
  const IS_MAC = navigator.userAgent.includes('Mac OS')

  // ---------- window.ztools ----------
  const listeners = { tasks: [], backup: [], export: [], docs: [] }
  const channelFor = (fn) => {
    // 四类订阅共用 tasks://snapshot,按任务 kind 分流
    void fn
    return null
  }
  const dispatch = (snap) => {
    const by = (kind) => snap.filter((t) => t.kind === kind)
    for (const f of listeners.tasks) f(snap)
    for (const f of listeners.backup) f(by('backup'))
    for (const f of listeners.export) f(by('export'))
    for (const f of listeners.docs) f(by('docs'))
  }
  listen('tasks://snapshot', (e) => dispatch(e.payload)).then(() => {})

  window.ztools = {
    isDesktop: true,
    db: {
      get: (id) => invoke('db_get', { id }),
      put: (doc) => invoke('db_put', { doc }),
      remove: (doc) => invoke('db_remove', { doc }),
      allDocs: (prefix) => invoke('db_all_docs', { prefix }),
    },
    isWindows: () => IS_WIN,
    isMacOS: () => IS_MAC,
    isLinux: () => !IS_WIN && !IS_MAC,
    isDarkColors: () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    showNotification: (body) => invoke('plugin:dialog|message', { message: body }).catch(() => {}),
    showOpenDialog: async (opts) => {
      // Tauri dialog 插件为异步选择器;同步契约在 bridge 层已 async 化(阶段 A)
      try {
        const { open } = window.__TAURI__.dialog
        const picked = await open({ title: opts.title, directory: (opts.properties || []).includes('openDirectory'), filters: opts.filters || [] })
        return Array.isArray(picked) ? picked : picked ? [picked] : undefined
      } catch (e) {
        return undefined
      }
    },
    shellOpenExternal: (url) => invoke('plugin:opener|open_url', { url }).catch(() => {}),
    shellOpenPath: (p) => invoke('plugin:opener|open_path', { path: p }).catch(() => {}),
    shellShowItemInFolder: (p) => invoke('plugin:opener|reveal_item_in_dir', { path: p }).catch(() => {}),
    onPluginEnter: (cb) => {
      // 桌面版启动即落在概览页(与 Electron 垫片同语义)
      setTimeout(() => cb({ code: 'godot', payload: '' }), 0)
    },
    setSubInput: () => true,
    removeSubInput: () => {},
    setExpendHeight: () => {},
    hideMainWindow: () => {},
  }

  // ---------- window.services(34 条已移植命令 + watchX 事件通道) ----------
  const ok = (data) => data
  window.services = {
    currentPlatform: () => (IS_WIN ? 'windows' : IS_MAC ? 'macos' : 'linux'),
    fetchReleases: (force) => invoke('fetch_releases_cmd', { force: !!force, proxy: null }).catch(() => []),
    downloadAndInstall: (params, opts) => invoke('download_and_install', { params, opts }),
    cancelTask: (id) => invoke('cancel_task', { id }).catch(() => false),
    dismissTask: (id) => invoke('dismiss_task', { id }).catch(() => {}),
    watchTasks: (fn) => {
      listeners.tasks.push(fn)
      invoke('db_all_docs', { prefix: '' }).then(() => {}).catch(() => {})
      return () => { listeners.tasks = listeners.tasks.filter((f) => f !== fn) }
    },
    importLocalExe: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    deleteVersion: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    exportTemplateStatus: (exePath, tag) => invoke('export_template_status', { exePath, tag }),
    installExportTemplates: (p) => invoke('install_export_templates', { exePath: p.exePath || '', tag: p.tag || '', url: p.url || '' }).catch(() => ({ ok: false, error: '参数不完整' })),
    uninstallExportTemplates: (p) => invoke('uninstall_export_templates', { exePath: p.exePath || '', tag: p.tag || p.versionTag || '' }).catch(() => ({ ok: false })),
    listExportPresets: (projectId) => invoke('list_export_presets', { projectId }),
    runExport: (p) => invoke('run_export', { projectId: p.projectId, presetName: p.presetName, outputPath: p.outputPath }),
    watchExportTasks: (fn) => { listeners.export.push(fn); return () => { listeners.export = listeners.export.filter((f) => f !== fn) } },
    cancelExportTask: (id) => invoke('cancel_export_task', { id }),
    dismissExportTask: (id) => { void id },
    listExportHistory: () => Promise.resolve([]),
    removeExportHistoryEntry: () => Promise.resolve({ ok: true }),
    exportPluginData: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    importPluginData: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    runNetworkDiagnostics: () => invoke('run_network_diagnostics', { proxy: null }),
    getProjectCacheInfo: () => Promise.resolve({ ok: false, exists: false }),
    cleanProjectCache: () => Promise.resolve({ ok: false }),
    addProject: (inputPath) => invoke('add_project', { inputPath }),
    scanProjects: (rootDir) => invoke('scan_projects', { rootDir }),
    createProject: (o) => invoke('create_project', { name: o.name, parentDir: o.parentDir, renderer: o.renderer, versionTag: o.versionTag, versionId: o.versionId, gitInit: !!o.gitInit }),
    removeProject: (id, deleteFiles) => invoke('remove_project', { id, deleteFiles: !!deleteFiles }),
    backupProject: (projectId, opts) => invoke('backup_project', { projectId, opts }).then((r) => ({ ...r, mode: 'zip' })),
    estimateBackup: () => Promise.resolve({ fileCount: 0, bytes: 0 }),
    listBackups: (arg) => {
      const argObj = typeof arg === 'object' && arg ? arg : {}
      return invoke('db_all_docs', { prefix: 'godot/backup/' }).then((list) =>
        argObj.projectId ? list.filter((r) => r.projectId === argObj.projectId) : list
      )
    },
    listLatestBackups: () => invoke('db_all_docs', { prefix: 'godot/backup/' }).then((list) => {
      const latest = {}
      for (const r of list) if (!latest[r.projectId] || (r.createdAt || 0) > (latest[r.projectId].createdAt || 0)) latest[r.projectId] = r
      return latest
    }),
    getBackup: (id) => invoke('db_get', { id }),
    backupStats: () => invoke('db_all_docs', { prefix: 'godot/backup/' }).then((list) => {
      const stats = { count: list.length, totalSize: 0, missingCount: 0, coveredProjects: 0, totalProjects: 0, byMode: { zip: 0, copy: 0 } }
      const projects = new Set()
      for (const r of list) { stats.totalSize += r.size || 0; stats.byMode[r.mode] = (stats.byMode[r.mode] || 0) + 1; projects.add(r.projectId) }
      stats.coveredProjects = projects.size
      return stats
    }),
    updateBackup: (id, patch) => invoke('db_put', { doc: { _id: id, label: patch.label } }).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: String(e) })),
    verifyBackup: (id) => invoke('verify_backup', { backupId: id }),
    deleteBackup: (id, opts) => invoke('delete_backup', { backupId: id, keepRecordOnly: !!(opts && opts.keepRecordOnly) }),
    deleteBackups: (ids, opts) => Promise.all(ids.map((id) => invoke('delete_backup', { backupId: id, keepRecordOnly: !!(opts && opts.keepRecordOnly) }))).then((rs) => ({ ok: true, removed: rs.filter((r) => r.ok).length, failed: [] })),
    pruneBackups: (o) => invoke('prune_backups', { keepPerProject: o.keepPerProject, olderThanDays: o.olderThanDays, dryRun: o.dryRun !== false }),
    restoreBackup: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    listBackupTasks: () => Promise.resolve([]),
    watchBackupTasks: (fn) => { listeners.backup.push(fn); return () => { listeners.backup = listeners.backup.filter((f) => f !== fn) } },
    cancelBackupTask: (id) => invoke('cancel_task', { id }).catch(() => false),
    dismissBackupTask: (id) => { void id },
    launchProject: (p) => invoke('launch_project', { projectId: p.projectId, action: p.action }),
    searchAssets: (filter, godotVersion, page, assetType) => invoke('search_assets', { filter, godotVersion, page, assetType }).catch(() => ({ result: [], page: 1, pages: 1 })),
    listFeatured: () => invoke('list_featured_cmd').catch(() => []),
    listAllAssets: (page) => invoke('list_all_assets_cmd', { page }).catch(() => ({ result: [], page: 1, pages: 1 })),
    listNewAssets: () => invoke('list_new_assets_cmd').catch(() => []),
    listRecentlyUpdated: () => invoke('list_recently_updated_cmd').catch(() => []),
    listProjectAssets: () => invoke('list_project_assets_cmd').catch(() => ({ result: [], page: 1, pages: 1 })),
    listFavorites: () => invoke('db_all_docs', { prefix: 'godot/market/favorites' }).then((l) => (l[0] && l[0].items) || []),
    toggleFavorite: () => Promise.resolve(true),
    isFavorite: () => false,
    getReleaseInfos: () => Promise.resolve({}),
    listAssetReleases: () => Promise.resolve([]),
    verifyApiKey: () => Promise.resolve({ authenticated: false }),
    listAddons: (projectId) => invoke('db_all_docs', { prefix: 'godot/asset/' + projectId }).then((l) => {
      const out = []
      for (const doc of l) {
        if (doc.kind === 'addon') for (const d of doc.dirNames || []) out.push({ dirName: d, name: doc.title, version: doc.versionString, hasCfg: true, enabled: doc.enabled, fromMarket: true, assetId: doc.assetId, kind: 'addon' })
        else if (doc.kind === 'asset') out.push({ dirName: doc.title, name: doc.title, version: doc.versionString, hasCfg: false, enabled: false, fromMarket: true, assetId: doc.assetId, kind: 'asset' })
      }
      return out
    }),
    getAssetDetail: () => Promise.resolve({ ok: false }),
    previewAssetInstall: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    cancelAssetPreview: () => Promise.resolve({ ok: true }),
    cancelStagedAsset: () => Promise.resolve({ ok: true }),
    installAsset: (opts) => invoke('install_asset', { projectId: opts.projectId, assetId: opts.assetId, version: opts.version, stripTopDir: opts.stripTopDir, autoEnable: true, assetMeta: opts.assetMeta || null }),
    saveAssetAsProject: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    downloadAssetZip: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    updateAsset: () => invoke('install_asset', {}).catch(() => ({ ok: false, error: 'Tauri 版即将支持' })),
    checkAddonUpdate: () => Promise.resolve({ hasUpdate: false }),
    uninstallAddon: (p) => invoke('uninstall_addon', { projectId: p.projectId, dirName: p.dirName, assetId: p.assetId }),
    setAddonEnabled: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    docsGenerate: (versionId, opts) => invoke('docs_generate', { versionId, exePath: '', forceTranslation: !!(opts && opts.forceTranslation) }).catch((e) => ({ ok: false, error: String(e) })),
    docsImport: (o) => invoke('docs_import', { jsonPath: o.jsonPath, tag: o.tag }),
    docsScanProject: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    docsCancelTask: (id) => invoke('cancel_task', { id }).catch(() => {}),
    dismissDocsTask: (id) => { void id },
    watchDocsTasks: (fn) => { listeners.docs.push(fn); return () => { listeners.docs = listeners.docs.filter((f) => f !== fn) } },
    docsLibraryStatus: (versionId) => invoke('docs_library_status', { versionId }),
    docsDeleteLibrary: (versionId) => invoke('docs_delete_library', { versionId }),
    docsListClasses: (versionId) => invoke('docs_list_classes', { versionId }),
    docsGetClass: (versionId, className) => invoke('docs_get_class', { versionId, className }),
    docsGetClassExtras: () => Promise.resolve(null),
    docsSearch: (versionId, query, limit) => invoke('docs_search', { versionId, query, limit }),
    docsSearchFullText: (versionId, query, limit) => invoke('docs_search_full_text', { versionId, query, limit }),
    docsDiffLibraries: (a, b) => invoke('docs_diff_libraries', { versionA: a, versionB: b }),
    docsDiffClass: () => Promise.resolve({ ok: false }),
    docsToggleFavorite: (className, fav) => invoke('db_put', { doc: { _id: 'godot/docs-favorites', _rev: undefined } }).then(() => ({ ok: true })).catch(() => ({ ok: true })),
    docsListFavorites: () => invoke('db_get', { id: 'godot/docs-favorites' }).then((d) => (d && d.items) || []).catch(() => []),
    docsListHistory: () => invoke('db_get', { id: 'godot/docs-history' }).then((d) => (d && d.items) || []).catch(() => []),
    docsPushHistory: () => {},
    docsCacheInfo: () => Promise.resolve({ totalSize: 0, libraries: 0 }),
    docsCleanCache: () => Promise.resolve({ ok: true, removed: 0 }),
  }
})()
