// Tauri 宿主垫片:在 Vue 主包之前加载(index.html 同步脚本),构造与 ZTools
// 宿主同形的 window.ztools + window.services。命令与 src-tauri 一一对应;
// 未移植方法如实报错(而不是静默假成功)。
// 平台/主题是唯一保持同步的读取(来自 webview 自身能力,无需 IPC)。
;(function () {
  if (!window.__TAURI__) return // 非桌面宿主(ZTools/浏览器)直接让位
  const invoke = window.__TAURI__.core.invoke
  const listen = window.__TAURI__.event.listen

  const IS_WIN = navigator.userAgent.includes('Windows')
  const IS_MAC = navigator.userAgent.includes('Mac OS')

  // ---------- window.ztools ----------
  const listeners = { tasks: [], backup: [], export: [], docs: [], tplbuild: [] }
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
      // 桌面版启动即落在概览页
      setTimeout(() => cb({ code: 'godot', payload: '' }), 0)
    },
    setSubInput: () => true,
    removeSubInput: () => {},
    setExpendHeight: () => {},
    hideMainWindow: () => {},
  }

  // ---------- window.services(invoke 桥接的 services 映射 + 其余如实占位;watchX 走事件通道) ----------
  const ok = (data) => data
  // ---------- 工具页四原语的调用护栏(F-2 / F-3)----------
  // 契约:这四条映射**永不**把 IPC 的裸 rejection 交给渲染层,一律收敛成 { ok:false, error },
  // 且 error 取自 JS 原语的那批串(见 src-ztools/preload/lib/inspectfs.js),渲染层不必按宿主分支。
  // 三类失败各有归属:
  //   · 参数形态不对(空/非串 projectId、非串 rel、非串 text)→ 守卫在 **invoke 之前**就地返回,
  //     用的是原语同一句话;真 Tauri 侧这些形态会在边界反序列化阶段裸拒绝,所以必须在这里挡。
  //   · Tauri **反序列化阶段**的拒绝(invalid args / deserialize)→ '参数不合法'(垫片专属,
  //     不进 JS↔Rust 原语契约,Rust 侧无需镜像)。
  //   · 其余(命令没注册、IPC 通道断了、原语里 panic)→ 该操作自己的失败句,
  //     绝不冒充「参数不合法」;两类都会 console.warn 出真实原因,不把原因丢进 catch 的黑洞。
  const guarded = (label, failText) => (p) => p.catch((e) => {
    const why = String((e && e.message) || e || '')
    console.warn('[tauri-shim]', label, why)
    return { ok: false, error: /invalid args|deserial/i.test(why) ? '参数不合法' : failText }
  })
  // projectId 不是非空串 → JS 原语的 projectRoot() 拿不到根 → '项目不存在'
  const badProject = (id) => (typeof id !== 'string' || !id ? { ok: false, error: '项目不存在' } : null)
  // rel 不是非空串 → JS 的 resolveRel() 拒 → '非法路径'
  const badRel = (rel) => (typeof rel === 'string' && rel ? null : { ok: false, error: '非法路径' })
  // maxBytes 只把**正安全整数**传出去,其余(0 / 负数 / 小数 / 字符串 / undefined)一律折成 null,
  // 让命令层回落默认限额 —— 与 JS 原语 `o.maxBytes && o.maxBytes > 0 ? … : DEFAULT`
  // (inspectfs.js:118)同归一,而不是把它变成一次 IPC 边界的裸拒绝。
  const toMaxBytes = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null)
  // ---------- db_put / db_remove:失败是**返回值**,不是 rejection ----------
  // Rust 侧一律 `return err(name, message)`(src-tauri/src/store.rs:31-33 → {error:true,name,message}),
  // invoke 于是**正常 resolve**。所以 `.then(() => ({ ok: true }))` 和 `.catch(...)` 都接不到失败 ——
  // 原先 docsToggleFavorite 与 updateBackup 就是这么把 conflict 报成成功的,而且两个都没带 _rev
  // (对已存在的文档必 conflict,store.rs:98-101)。同一批坑在 ZTools 侧早踩过一遍:
  // 见 src-ztools/preload/lib/assets.js 的 putDocVerbose「写库失败必须抛出原因」。
  const writeFailed = (r) => !r || r.error === true || r.ok === false
  const writeReason = (r) => String((r && (r.message || r.name)) || '写入失败')
  /**
   * 带 _rev 的读-改-写:把 body **合并**进现有文档再落库。
   * 两件事必须一起做:不带 _rev 对已存在的文档必 conflict;整份替换则会抹掉没写进 body 的字段
   * (updateBackup 原先只送 {_id, label},改一次标签就把 projectId/size/createdAt 全丢了)。
   */
  const putMerged = (id, body, cur) => {
    const doc = { ...(cur || {}), ...body, _id: id }
    if (cur && cur._rev) doc._rev = cur._rev
    return invoke('db_put', { doc })
  }
  const readThenPut = (id, body) => invoke('db_get', { id }).then((cur) => putMerged(id, body, cur))
  const DOCS_FAV_ID = 'godot/docs-favorites'
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
    // ---------- 导出模板三映射 ----------
    // 渲染层(useExportTemplates)按 Services 契约传 **versionId**;JS 宿主的原语在 preload 里
    // 自己查库,这里没有 store,先 db_get 拿引擎文档(exePath/tag)再转发命令。
    // 旧签名(收 {exePath,tag} 对象)与契约对不上,三条在桌面端一直是坏的 —— 这次按契约修。
    // 文档查不到时与 JS 原语同形:状态返回全空对象,操作返回 '未找到该引擎'。
    exportTemplateStatus: async (versionId) => {
      const v = await window.ztools.db.get(versionId).catch(() => null)
      if (!v || !v.exePath || !v.tag) return { versionDir: '', installed: false, tracked: false, path: '' }
      return invoke('export_template_status', { exePath: v.exePath, tag: v.tag })
    },
    installExportTemplates: async (versionId, opts) => {
      const v = await window.ztools.db.get(versionId).catch(() => null)
      if (!v || !v.exePath || !v.tag) return { ok: false, error: '未找到该引擎' }
      const o = opts || {}
      return invoke('install_export_templates', {
        exePath: v.exePath,
        tag: v.tag,
        // srcPath 有值 = 本地导入(命令层不再下载),url 就不需要了
        url: o.srcPath ? null : '',
        srcPath: o.srcPath || null,
        versionDir: o.versionDir || null
      }).catch((e) => {
        console.warn('[tauri-shim] installExportTemplates', String((e && e.message) || e))
        return { ok: false, error: '安装失败' }
      })
    },
    uninstallExportTemplates: async (versionId) => {
      const v = await window.ztools.db.get(versionId).catch(() => null)
      if (!v || !v.exePath || !v.tag) return { ok: false, error: '未找到该引擎' }
      return invoke('uninstall_export_templates', { exePath: v.exePath, tag: v.tag }).catch((e) => {
        console.warn('[tauri-shim] uninstallExportTemplates', String((e && e.message) || e))
        return { ok: false, error: '卸载失败' }
      })
    },
    listExportPresets: (projectId) => invoke('list_export_presets', { projectId }),
    runExport: (p) => invoke('run_export', { projectId: p.projectId, presetName: p.presetName, outputPath: p.outputPath }),
    watchExportTasks: (fn) => { listeners.export.push(fn); return () => { listeners.export = listeners.export.filter((f) => f !== fn) } },
    cancelExportTask: (id) => invoke('cancel_export_task', { id }),
    dismissExportTask: (id) => { void id },
    listExportHistory: () => Promise.resolve([]),
    // 导出历史在桌面版没有后端(命令表里既没有 list_export_history 也没有 remove_...),
    // 所以列表恒空、删除也不可达。这里仍如实报而不是 {ok:true}:哪天列表接上了,
    // 「删除成功」不能靠一条没做事的桩。
    removeExportHistoryEntry: () => Promise.resolve({ ok: false, error: '桌面版暂不支持导出历史,请使用 ZTools 插件版。' }),
    exportPluginData: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    importPluginData: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    runNetworkDiagnostics: () => invoke('run_network_diagnostics', { proxy: null }),
    // 桌面版没有缓存统计命令,也**不回 exists** —— 给了就等于替用户回答「这个项目没有缓存」。
    // 项目页缓存弹窗据此显示「不支持」而不是「还没有 .godot 缓存」(ProjectsView.vue 的第三态)。
    getProjectCacheInfo: () => Promise.resolve({ ok: false, error: '桌面版暂不支持缓存统计,请使用 ZTools 插件版。' }),
    cleanProjectCache: () => Promise.resolve({ ok: false, error: '桌面版暂不支持清理 .godot 缓存,请使用 ZTools 插件版。' }),
    // ---------- 导出模板自编译(裁剪向导) ----------
    // 桌面版(Tauri)暂未实现构建管线(需要 vcvars/子进程/产物整理),如实告知而不是假成功;
    // 渲染层对 ok:false + problems 的展示路径与缺工具链同一条。ZTools 插件宿主提供真实现。
    // 这一组占位同一条规矩:Rust 侧命令注册之前不给任何真通道 —— 缺能力是状态不是假成功;
    // 而返回形状必须与契约对齐(字段齐、类型对),否则渲染层对 undefined 取属性就是 TypeError。
    probeTemplateSource: () => Promise.resolve({ ok: false, error: '桌面版暂不支持源码探测,请使用 ZTools 插件版。', sourceVersion: '', tested: false, options: {}, cascades: {}, testedVersions: [] }),
    listTemplateFeatures: () => Promise.resolve({ ok: false, error: '桌面版暂不支持自编译模板,请使用 ZTools 插件版。', items: [] }),
    validateTemplateConfig: () => Promise.resolve({ ok: false, issues: [], suppressed: [], hardBlocks: [{ itemId: 'source', flag: '', why: '桌面版暂不支持自编译模板', action: '请使用 ZTools 插件版', skippable: false }] }),
    applyTemplatePreset: () => Promise.resolve({ ok: false, error: '桌面版暂不支持自编译模板,请使用 ZTools 插件版。' }),
    checkTemplateBuildTools: () => Promise.resolve({
      ok: false, pythonVersion: '', pythonPath: '', sconsVersion: '', sconsPath: '', vcvarsPath: '', tarPath: '',
      d3d12SdkInstalled: false, accesskitSdkInstalled: false,
      cpuCount: navigator.hardwareConcurrency || 0,
      problems: ['桌面版暂不支持自编译模板构建,请使用 ZTools 插件版。']
    }),
    downloadTemplateSource: () => Promise.resolve({ ok: false, error: '桌面版暂不支持代下载源码,请使用 ZTools 插件版。' }),
    cancelTemplateSourceDownload: () => { /* 桌面版没有在途任务,取消是空操作 */ },
    listTemplatePacks: () => Promise.resolve({ ok: false, error: '桌面版暂不支持模板库,请使用 ZTools 插件版。' }),
    activateTemplatePack: () => Promise.resolve({ ok: false, error: '桌面版暂不支持模板库,请使用 ZTools 插件版。' }),
    deleteTemplatePack: () => Promise.resolve({ ok: false, error: '桌面版暂不支持模板库,请使用 ZTools 插件版。' }),
    adoptTemplatePack: () => Promise.resolve({ ok: false, error: '桌面版暂不支持模板库,请使用 ZTools 插件版。' }),
    buildTemplatePack: () => Promise.resolve({ ok: false, error: '桌面版暂不支持自编译模板构建,请使用 ZTools 插件版。' }),
    watchTemplateBuildTasks: (fn) => { listeners.tplbuild.push(fn); return () => { listeners.tplbuild = listeners.tplbuild.filter((f) => f !== fn) } },
    cancelTemplateBuildTask: (id) => { void id },
    dismissTemplateBuildTask: (id) => { void id },
    // ---------- 工具页原语(spec §5.4;rel 一律正斜杠相对路径) ----------
    // 参数名必须用**驼峰**传进 invoke(maxBytes / skipDirs / maxEntries):写成下划线会被
    // Tauri 静默反序列化成 None,限额直接失效(命令层拿不到就等于用户没设限)。
    // 这条不靠注释自觉:src-tauri/tests/inspectfs_parity.rs 的 shim 段会 eval 本文件、
    // 逐键钉住四条映射实际发出的命令名与 payload 键名,键名一改测试就红。
    scanProjectTree: (projectId, opts) => {
      const bad = badProject(projectId)
      if (bad) return Promise.resolve(bad)
      return guarded('scanProjectTree', '遍历失败')(invoke('scan_project_tree', { projectId, opts: opts || null }))
    },
    readProjectText: (projectId, rel, opts) => {
      const bad = badProject(projectId) || badRel(rel)
      if (bad) return Promise.resolve(bad)
      return guarded('readProjectText', '读取失败')(invoke('read_project_text', { projectId, rel, maxBytes: toMaxBytes(opts && opts.maxBytes) }))
    },
    writeProjectText: (projectId, rel, text, opts) => {
      // 判定顺序与原语一致:先看根、再看 rel、最后才看内容(项目不存在优先于内容不是文本)
      const bad = badProject(projectId) || badRel(rel)
      if (bad) return Promise.resolve(bad)
      if (typeof text !== 'string') return Promise.resolve({ ok: false, error: '内容不是文本' })
      return guarded('writeProjectText', '写入失败')(invoke('write_project_text', {
        projectId, rel, text,
        backup: !opts || opts.backup !== false
      }))
    },
    // rels 必须归成**真数组**再传:Rust 侧签名是 `rels: Vec<String>`,非数组入参在 Tauri
    // **反序列化阶段**就被拒(promise rejection),而 JS 原语把非数组当空清单回
    // { ok:true, moved:0 }(见 inspectfs.js:319) —— 两端形态必须一致,所以这里先过滤成字符串数组。
    // 兜底句 '移入回收站失败' 取自 JS↔Rust 契约里已有的那条(复核阶段的失败串);
    // '参数不合法' 只留给**反序列化拒绝**,见上面 guarded() 的三类归属。
    movePathsToTrash: (projectId, rels) => {
      const bad = badProject(projectId)
      if (bad) return Promise.resolve(bad)
      return guarded('movePathsToTrash', '移入回收站失败')(invoke('move_paths_to_trash', {
        projectId,
        rels: Array.isArray(rels) ? rels.filter((r) => typeof r === 'string') : []
      }))
    },
    // 与 movePathsToTrash 同一条归一理由:Rust 的 rels: Vec<String> 在反序列化阶段拒非数组,
    // 而 JS 原语把它当空清单回 { ok:true, hashes:[] } —— 垫片先归一,两端形态才一致。
    // 兜底句 '读取失败' 取自 JS↔Rust 契约里哈希通道已有的那条;详见 inspectfs.js 的 hashPaths。
    hashPaths: (projectId, rels) => {
      const bad = badProject(projectId)
      if (bad) return Promise.resolve(bad)
      return guarded('hashPaths', '读取失败')(invoke('hash_paths', {
        projectId,
        rels: Array.isArray(rels) ? rels.filter((r) => typeof r === 'string') : []
      }))
    },
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
    updateBackup: (id, patch) => readThenPut(id, { label: patch.label })
      .then((r) => (writeFailed(r) ? { ok: false, error: writeReason(r) } : { ok: true }))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
    verifyBackup: (id) => invoke('verify_backup', { backupId: id }),
    deleteBackup: (id, opts) => invoke('delete_backup', { backupId: id, keepRecordOnly: !!(opts && opts.keepRecordOnly) }),
    // failed 必须从每条结果里数出来。原先硬编码 `failed: []`,于是「批量 5 条只删成 2 条」
    // 也照样报 ok:true 且没有一条失败可看。delete_backup 返回的是 Value 而不是 Result
    // (main.rs:394),失败同样是**正常 resolve 的一个值**(记录不存在时按幂等回 ok:true),
    // 所以 resolve 分支与 rejection 分支都要接住。
    deleteBackups: (ids, opts) => {
      const list = Array.isArray(ids) ? ids : []
      return Promise.all(list.map((id) => invoke('delete_backup', { backupId: id, keepRecordOnly: !!(opts && opts.keepRecordOnly) })
        .then((r) => (r && r.ok === false ? { id, error: String(r.error || '删除失败') } : null))
        .catch((e) => ({ id, error: String((e && e.message) || e) }))
      )).then((errs) => {
        const failed = errs.filter(Boolean)
        return { ok: failed.length === 0, removed: list.length - failed.length, failed }
      })
    },
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
    // 这里必须**同步抛**:渲染层的 useMarketFavorites.toggleFav 用的是同步 try/catch 且不 await
    // (契约的同步面是 services.ts:306,preload 侧见 lib/assets.js)。注意「垫片一律不许返回 Promise」
    // 是误读 —— AsyncServices(services.ts:424-443)就是把每个数据方法包成 Promise 的渲染层视图,
    // 像 docsToggleFavorite 那样 await 的调用点返回 Promise 完全正确。这条只针对不 await 的本调用点。
    // 原先写成 () => Promise.resolve(true):既不写库又报成功,reload 后读到空列表,必然长红「收藏未生效」。
    toggleFavorite: () => { throw new Error('桌面版暂不支持收藏,请使用 ZTools 插件版。') },
    isFavorite: () => false,
    getReleaseInfos: () => Promise.resolve({}),
    listAssetReleases: () => Promise.resolve([]),
    // 桌面版没有账号校验通道,但也不能只回 {authenticated:false}:设置页读的是成功分支,
    // 没有 error 就变成「点验证转一下,什么都不发生」(和最初那条「点收藏没反应」同一个症状)。
    verifyApiKey: () => Promise.resolve({ authenticated: false, error: '桌面版暂不支持 Asset Store 账号校验,请使用 ZTools 插件版。' }),
    listAddons: (projectId) => invoke('db_all_docs', { prefix: 'godot/asset/' + projectId }).then((l) => {
      const out = []
      for (const doc of l) {
        if (doc.kind === 'addon') for (const d of doc.dirNames || []) out.push({ dirName: d, name: doc.title, version: doc.versionString, hasCfg: true, enabled: doc.enabled, fromMarket: true, assetId: doc.assetId, kind: 'addon' })
        else if (doc.kind === 'asset') out.push({ dirName: doc.title, name: doc.title, version: doc.versionString, hasCfg: false, enabled: false, fromMarket: true, assetId: doc.assetId, kind: 'asset' })
      }
      return out
    }),
    // 商店详情要读资产页的媒体/许可/评分等扩展字段,桌面版没有对应的抓取命令。
    // 原先回 {ok:false}:AssetDetailDialog 拿到后直接读 detail.media[0],于是弹层里显示的是
    // 「加载失败:Cannot read properties of undefined (reading '0')」——把 JS 内部错误给了用户。
    // 回 null 让调用点能区分「没有详情」,原因由弹层按宿主说。
    getAssetDetail: () => Promise.resolve(null),
    previewAssetInstall: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    // 预览与暂存在桌面版都没有命令(previewAssetInstall 就是同一句不支持),
    // 所以「取消」无事可做 —— 报成功等于凭空造一次没发生的清理。
    cancelAssetPreview: () => Promise.resolve({ ok: false, error: '桌面版暂不支持安装预览,请使用 ZTools 插件版。' }),
    cancelStagedAsset: () => Promise.resolve({ ok: false, error: '桌面版暂不支持安装暂存,请使用 ZTools 插件版。' }),
    installAsset: (opts) => invoke('install_asset', { projectId: opts.projectId, assetId: opts.assetId, version: opts.version, stripTopDir: opts.stripTopDir, autoEnable: true, assetMeta: opts.assetMeta || null }),
    saveAssetAsProject: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    downloadAssetZip: () => Promise.resolve({ ok: false, error: 'Tauri 版即将支持' }),
    // 旧写法是 `invoke('install_asset', {})`:两个必填参数全丢,必在 Tauri 反序列化阶段被拒,
    // 于是 catch 把**任何**错误都改写成「即将支持」——真网络断了也是那句话。而且覆盖安装还要沿用
    // 首次安装时的 stripTopDir 选择,垫片拿不到那条安装记录,拼不出正确的 payload。
    // 所以这里如实占位并给出可操作的替代(市场页重装),不再假装调了一次命令。
    updateAsset: () => Promise.resolve({ ok: false, error: '桌面版暂不支持单独更新插件,请在市场页重新安装。' }),
    // 没有 check_addon_update 命令(Rust 侧 generate_handler 里就没有),所以如实回「没查」并带原因。
    // 契约里 `error?: string` 就是为这种情况留的:渲染层(useAddonActions / useUpdateScan)读它,
    // 不能把这条回值并进「所有插件均为最新版本」那句结论 —— 原先只给 hasUpdate:false,就是这么谎报的。
    checkAddonUpdate: () => Promise.resolve({ hasUpdate: false, error: '桌面版暂不支持检查插件更新,请使用 ZTools 插件版。' }),
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
    docsDiffClass: () => Promise.resolve({ ok: false, error: '桌面版暂不支持单类差异对比,请使用 ZTools 插件版。' }),
    // 文档收藏**真实现**(照 preload/lib/docs.js:162-169:Set 增删 → 排序写回),不是占位:
    // db_get/db_put 在 Rust 侧是注册了的命令,这条没有「后端不存在」的借口。
    // 旧写法把 className/fav 两个入参整个丢掉,写的文档连 items 都没有,还把 .catch 收敛成
    // {ok:true} —— 点收藏永远没反应却报成功,和 2026-10-09 修的市场收藏是同一个形状。
    docsToggleFavorite: (className, fav) => invoke('db_get', { id: DOCS_FAV_ID })
      .then((cur) => {
        const set = new Set((cur && cur.items) || [])
        if (fav) set.add(className)
        else set.delete(className)
        return putMerged(DOCS_FAV_ID, { items: [...set].sort() }, cur)
      })
      .then((r) => (writeFailed(r) ? { ok: false, error: writeReason(r) } : { ok: true }))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
    docsListFavorites: () => invoke('db_get', { id: DOCS_FAV_ID }).then((d) => (d && d.items) || []).catch(() => []),
    docsListHistory: () => invoke('db_get', { id: 'godot/docs-history' }).then((d) => (d && d.items) || []).catch(() => []),
    // 浏览历史**真实现**,照 preload/lib/docs.js:182-186:去重置顶、上限 30 条。
    // 原先是 `() => {}` —— 不报错也不记录,文档页的「最近浏览」在桌面版永远空着。
    docsPushHistory: (className) => {
      const id = 'godot/docs-history'
      return invoke('db_get', { id })
        .then((cur) => {
          const rest = ((cur && cur.items) || []).filter((x) => x && x.name !== className)
          return putMerged(id, { items: [{ name: className, at: Date.now() }, ...rest].slice(0, 30) }, cur)
        })
        .catch((e) => {
          const why = String((e && e.message) || e)
          console.warn('[tauri-shim] docsPushHistory', why)
          return { ok: false, error: why }
        })
    },
    // 形状要对得上 JS 侧的 DocsCacheInfo({ sizeBytes, libraries[] })。
    // 原先回 { totalSize, libraries: 0 }:设置页读 sizeBytes → undefined → fmtSize 显示「0 B」,
    // 而清理按钮的判据 `libraries.length` 在数字 0 上是 undefined,于是永远禁用 —— 看着像「没有缓存」。
    // 库文件尺寸在 Rust 侧没有命令可问,所以整条如实回不支持。
    docsCacheInfo: () => Promise.resolve({
      sizeBytes: 0,
      libraries: [],
      error: '桌面版暂不支持文档库缓存统计,请使用 ZTools 插件版。'
    }),
    // 如实占位:原先回 {ok:true, removed:0},设置页于是提示「已清理 0 个文档库」——
    // 什么都没删却说删好了。逐库删除本身有命令(docs_delete_library),但「清哪些、能省多少」要按库目录
    // 算尺寸,Rust 侧没这个口子,所以和 docsCacheInfo 一起如实。
    docsCleanCache: () => Promise.resolve({ ok: false, error: '桌面版暂不支持清理文档库缓存,请使用 ZTools 插件版。' }),
  }
})()
