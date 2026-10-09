/** 打开项目的动作:编辑器 / 运行 / 打开目录 */
export type OpenAction = 'editor' | 'run' | 'folder'

/** 平台标识 */
export type Platform = 'win64' | 'macos' | 'linux64'

/** 引擎变体:标准版 / C#(mono) 版 */
export type Variant = 'standard' | 'mono'

/** 界面主题色板 id(与 main.css 的 [data-theme='X'] 一一对应) */
export type ThemeId = 'steel' | 'graphite' | 'forest' | 'violet' | 'amber'

/** 明暗模式:auto = 跟随宿主/系统 */
export type ThemeMode = 'auto' | 'light' | 'dark'

/** 已安装的 Godot 引擎版本 */
export interface GodotVersion {
  id: string
  tag: string
  /** 展示名,如 "4.3 Stable" */
  name: string
  variant: Variant
  platform: Platform
  exePath: string
  /** 插件创建的安装目录(managed 时用于删除) */
  installDir?: string
  /** true=由插件下载并管理,false=用户本地导入 */
  managed: boolean
  /** 安装包来源(下载 URL 或 'local') */
  source?: string
  installedAt: number
  /** 字节 */
  size?: number
  /** --version 校验是否通过 */
  verified?: boolean
}

/** 管理的 Godot 项目 */
export interface GodotProject {
  id: string
  /** 项目根目录绝对路径 */
  path: string
  name: string
  /** project.godot 中 icon 的相对路径 */
  icon?: string
  /** project.godot 的 config_version(5=4.x,4=3.x) */
  configVersion: number
  /** config/features[0],如 "4.3" */
  engineVersion?: string
  /** 绑定的引擎版本 id */
  versionId?: string
  favorite: boolean
  lastOpenedAt?: number
  openCount: number
  addedAt: number
  /** 启动时追加的自定义命令行参数(如 --resolution 1280x720);引号内空白属于同一参数 */
  launchArgs?: string
}

/** 导出预设(export_presets.cfg 的顶层字段) */
export interface ExportPreset {
  index: number
  name: string
  platform: string
  /** 预设配置的导出输出路径(res:// 相对路径,如 builds/windows.exe) */
  exportPath: string
}

/** 导出任务(一键导出的生命周期) */
export interface ExportTask {
  id: string
  kind: 'export'
  projectId: string
  projectName: string
  presetName: string
  outputPath: string
  /** export-release 或 export-pack */
  mode: string
  exePath: string
  status: 'queued' | 'exporting' | 'done' | 'error' | 'canceled'
  /** 引擎输出尾部(失败诊断用) */
  log: string
  error?: string
}

/** 文档库生成任务(--dump-extension-api-with-docs 的生命周期) */
export interface DocsTask {
  id: string
  kind: 'docs'
  versionId: string
  tag: string
  versionName: string
  status: 'queued' | 'dumping' | 'translating' | 'parsing' | 'done' | 'error' | 'canceled'
  /** parsing 阶段进度:已解析/总类数 */
  done: number
  total: number
  /** 引擎输出尾部(失败诊断用) */
  log: string
  error?: string
}

/** 文档库状态(版本页/文档页的生成状态徽标) */
export interface DocLibraryStatus {
  status: 'ready' | 'building'
  versionId: string
  tag: string
  name?: string
  /** ready 时:类数与生成时间 */
  classCount?: number
  builtAt?: number
  /** 库语言:拿到官方中文翻译(可能覆盖不全)即视为 zh-CN,否则 en */
  lang?: 'zh-CN' | 'en'
  /** 中文描述命中条数(诊断翻译覆盖用) */
  translatedCount?: number
  /** 可翻译字符串总数:translatedCount/stringCount 即覆盖率 */
  stringCount?: number
  /** 库来源:engine=引擎 API / project=项目脚本扫描 */
  kind?: 'engine' | 'project'
  /** project 库对应的项目 id */
  sourceProject?: string
}

/** 索引条目:类列表与搜索共用的轻量摘要 */
export interface DocClassSummary {
  name: string
  inherits: string | null
  brief: string
  builtin: boolean
  isSingleton: boolean
  /** 方法/成员/信号/常量(含枚举值)/枚举 名单(来自 preload 紧凑索引) */
  m: string[]
  p: string[]
  s: string[]
  c: string[]
  e: string[]
}

export interface DocParam {
  name: string
  type: string
  defaultValue?: string
}

export interface DocMethod {
  name: string
  returnType: string
  params: DocParam[]
  qualifiers: string[]
  description: string
}

export interface DocMember {
  name: string
  type: string
  setter?: string
  getter?: string
  defaultValue?: string
  description: string
}

export interface DocSignal {
  name: string
  params: DocParam[]
  description: string
}

export interface DocConstant {
  name: string
  value: string
  /** 所属枚举名(散装常量无此字段) */
  enum?: string
  description: string
}

export interface DocEnum {
  name: string
  bitfield: boolean
  values: DocConstant[]
}

export interface DocOperator {
  name: string
  returnType: string
  params: DocParam[]
  description: string
}

/** 类正文(classes/<Name>.json 的内容) */
export interface DocClassDetail {
  name: string
  inherits: string | null
  brief: string
  description: string
  builtin: boolean
  isSingleton: boolean
  methods: DocMethod[]
  members: DocMember[]
  signals: DocSignal[]
  constants: DocConstant[]
  enums: DocEnum[]
  operators: DocOperator[]
  /** 项目脚本类:来源 .gd 文件绝对路径(引擎类无此字段) */
  sourceFile?: string
}

/** 跨版本差异:一组成员的新增/移除/签名变化 */
export interface DocDiffGroup {
  added: string[]
  removed: string[]
  changed: { name: string, from: string, to: string }[]
}

/** 单类的成员级差异 */
export interface DocClassDiff {
  className: string
  /** 继承变化(未变时为 null) */
  inherits: { from: string | null, to: string | null } | null
  methods: DocDiffGroup
  members: DocDiffGroup
  signals: DocDiffGroup
  constants: DocDiffGroup
  enums: DocDiffGroup
}

/** 库级差异汇总 */
export interface DocLibraryDiff {
  ok: boolean
  error?: string
  tagA?: string
  tagB?: string
  addedClasses?: string[]
  removedClasses?: string[]
  changedClasses?: { name: string, changes: number }[]
}

/** 类附加信息(教程链接;按需从官方 XML 补,离线时为 null) */
export interface DocClassExtras {
  tutorials: { title: string, url: string }[]
  fetchedAt?: number
  /** 命中的来源 ref(诊断用) */
  ref?: string
}

export type DocHitKind = 'class' | 'method' | 'member' | 'signal' | 'enum' | 'constant' | 'body'

export interface DocSearchHit {
  kind: DocHitKind
  className: string
  name: string
  brief: string
  score: number
  /** 正文命中时的上下文片段 */
  snippet?: string
}

export interface DocHistoryItem {
  name: string
  at: number
}

/** 文档库缓存统计(设置页清理用) */
export interface DocsCacheInfo {
  sizeBytes: number
  /** 宿主没统计时的原因(桌面版问不到库目录尺寸):面板据此说「不支持」而不是「0 B」 */
  error?: string
  libraries: {
    versionId: string
    tag: string
    classes: number
    builtAt: number
    sizeBytes: number
  }[]
}

/** 资产详情(详情弹层用;扩展字段缺失时为空) */
export interface AssetDetail {
  assetId: string
  title: string
  author: string
  versionString: string
  downloadUrl: string
  description: string
  tags: string[]
  media: string[]
  videoId: string
  licenseType: string
  licenseUrl: string
  reviewsScore: number
  storeUrl: string
  lastUpdated: string
}

/** 导出历史条目 */
export interface ExportHistoryEntry {
  id: string
  projectId: string
  projectName: string
  presetName: string
  outputPath: string
  mode: string
  size: number
  finishedAt: number
}

/** 网络诊断单项结果 */
export interface NetworkCheckResult {
  name: string
  url: string
  ok: boolean
  ms: number
  error?: string
}

/** 插件设置 */
export interface GodotSettings {
  /** 引擎安装根目录(首次下载时选择并保存) */
  versionsRoot?: string
  /** HTTP 代理地址,如 http://127.0.0.1:7890;留空直连 */
  proxy?: string
  /** Asset Store API Key(在 store.godotengine.org 登录后生成) */
  apiKey?: string
  /** API Key 验证通过的用户名(本地缓存显示用) */
  storeAccount?: string
  defaultVersionId?: string
  defaultOpenAction: OpenAction
  /** 安装插件后自动在 project.godot 中启用 */
  autoEnablePlugin: boolean
  /** 删除项目时如何处理项目文件:ask=弹窗询问,always=总是同时删除,never=仅移除记录 */
  deleteProjectFiles: 'ask' | 'always' | 'never'
  /** 项目备份默认目录 */
  backupRoot?: string
  /** 文档页上次浏览的文档库版本 id(引擎文档浏览功能) */
  docsVersionId?: string
  /** 默认备份方式:zip 打包 | copy 完整快照 */
  backupMode?: 'zip' | 'copy'
  /** 默认是否包含 .godot 编辑器缓存 */
  backupIncludeCache?: boolean
  /** zip 默认压缩级别:1 快速 | 6 标准 | 9 最大 */
  backupLevel?: 1 | 6 | 9
  /** 默认排除的目录名(如 .git / build) */
  backupExclude?: string[]
  /** 保留策略:每个项目最多保留份数(不设则不自动清理) */
  backupKeepPerProject?: number
  /** 保留策略:删除早于 N 天的备份 */
  backupKeepDays?: number
  /** 素材安装:按 slug 记忆「顶层目录并入项目根」的选择,确认层预填用 */
  assetStripTopDir?: Record<string, boolean>
  /** 界面主题色板 */
  theme?: ThemeId
  /** 明暗模式:auto 跟随宿主 */
  themeMode?: ThemeMode
}

/** 项目备份记录 */
export interface BackupRecord {
  _id: string
  projectId: string
  projectName: string
  /** zip=打包备份,copy=完整快照目录 */
  mode: 'zip' | 'copy'
  /** 备份文件(zip)或目录(快照)的绝对路径 */
  destPath: string
  /** 字节(zip 为压缩后估算) */
  size: number
  fileCount: number
  createdAt: number
  /** 备份文件已被外部删除(派生字段,由 listBackups 计算) */
  missing?: boolean

  // ---------- 以下为 schema 2 新增,全部可选以保证旧记录可读 ----------
  /** 用户备注名,如「发布前」;空则由 UI 以「项目名 + 时间」兜底 */
  label?: string
  /** 是否包含 .godot 缓存 */
  includeCache?: boolean
  /** zip 压缩级别 */
  level?: 1 | 6 | 9
  /** 备份时项目绑定的引擎版本 tag */
  engineVersion?: string
  /** 备份时 project.godot 的 config_version */
  configVersion?: number
  /** 本次备份实际排除的目录名 */
  excluded?: string[]
  /** 完整性校验结果(verifyBackup 写入) */
  verified?: boolean
  verifiedAt?: number
  verifyError?: string
  /** 备份耗时(毫秒) */
  durationMs?: number
  /** 记录结构版本:1=旧记录,2=当前 */
  schema?: number
}

/** 备份汇总统计(备份页统计头) */
export interface BackupStats {
  count: number
  totalSize: number
  missingCount: number
  /** 有备份且项目仍存在的项目数 */
  coveredProjects: number
  totalProjects: number
  byMode: { zip: number, copy: number }
}

/** 备份/恢复任务阶段 */
export type BackupPhase =
  | 'scanning' | 'packing' | 'copying' | 'finalizing'
  | 'unpacking' | 'replacing' | 'registering'
  | 'done' | 'error' | 'canceled'

/** 进行中的备份/恢复任务快照 */
export interface BackupTask {
  id: string
  kind: 'backup' | 'restore'
  projectId: string
  projectName: string
  label?: string
  mode: 'zip' | 'copy' | 'overwrite' | 'new'
  phase: BackupPhase
  done: number
  total: number
  bytes: number
  current: string
  startedAt: number
  finishedAt?: number
  error?: string
  /** 已请求取消(尚未落到终态) */
  cancelRequested?: boolean
  /** false 表示已进入不可回滚阶段,取消不再生效 */
  cancelable?: boolean
}

export const DEFAULT_SETTINGS: GodotSettings = {
  defaultOpenAction: 'editor',
  autoEnablePlugin: true,
  deleteProjectFiles: 'ask'
}

/** 引擎下载资产(官方 CDN 直链) */
export interface ReleaseAsset {
  name: string
  url: string
  /**
   * 备用直链(官方构建仓库同名资产)。CDN 的版本映射表会滞后于构建仓库:
   * 新 tag 发布当天点下载常见 `下载失败 HTTP 404`,回落到这里即可下到同一个包。
   */
  fallbackUrl?: string
  /** 归档页不提供大小;0 表示未知,下载开始后从响应 Content-Length 获取 */
  size?: number
}

/** 官方归档中的引擎版本(含稳定版与 dev/beta/rc 预发布版) */
export interface GodotRelease {
  tag: string
  name: string
  publishedAt: string
  prerelease: boolean
  assets: ReleaseAsset[]
}

/** 下载任务 */
export type DownloadStatus = 'queued' | 'downloading' | 'extracting' | 'verifying' | 'done' | 'error' | 'canceled'

export interface DownloadTask {
  id: string
  tag: string
  variant: Variant
  platform: Platform
  url: string
  /** 备用直链:主地址 404 时自动回落(见 ReleaseAsset.fallbackUrl) */
  fallbackUrl?: string
  fileName: string
  totalSize: number
  status: DownloadStatus
  /** 任务类别:缺省为引擎安装;templates=导出模板下载安装 */
  kind?: 'templates'
  /** 已接收字节 */
  received: number
  /** B/s */
  speed: number
  error?: string
  /** 未经翻译的原始失败原因(诊断用,界面展示 error) */
  errorDetail?: string
  /** 完成后对应的版本 id */
  versionId?: string
  /** 完成后对应的版本文档 */
  version?: GodotVersion
}

/** Asset Library 市场资产 */
export interface MarketAsset {
  /** Asset Store 标识:"{publisherSlug}/{assetSlug}" */
  assetId: string
  title: string
  author: string
  category: string
  /** 全部标签 slug(用于客户端标签筛选;旧收藏等历史数据可能缺失) */
  tagSlugs?: string[]
  /** 商店搜索结果不逐资产提供版本,安装时从 releases 端点实时获取 */
  versionString: string
  godotVersion: string
  /** 最新 release 兼容的 Godot 版本范围(列表页由 getReleaseInfos 补齐) */
  minGodot?: string
  maxGodot?: string
  /** 最新 release 发布日期(ISO 日期串,判断新品用) */
  releaseCreated?: string
  iconUrl?: string
  description?: string
  /** 商店页面链接 */
  storeUrl?: string
}

/** 本地收藏的市场资产(官方 API 暂未开放收藏,存于本地) */
export interface FavoriteAsset extends MarketAsset {
  addedAt: number
}

/** 冲突摘要:目标项目已存在的同路径文件 */
export interface ConflictInfo {
  count: number
  samples: string[]
}

/** 安装计划:previewAssetInstall 归纳的 zip 内容,确认层据此渲染 */
export interface InstallPlan {
  /** 内容嗅探结果:addon=插件,asset=纯素材,project=完整项目(不可装入现有项目) */
  kind: 'addon' | 'asset' | 'project'
  /** 顶层条目(素材展示用) */
  topEntries: { name: string, isDir: boolean, files: number }[]
  fileCount: number
  /** zip 包体积(字节,压缩后) */
  zipSize: number
  /** 唯一顶层目录名(存在时确认层才提供「并入项目根」选项) */
  singleTopDir: string
  /** 冲突:asIs=按原结构写入;stripped=剥离 wrapper 后写入(仅 singleTopDir 存在时提供) */
  conflicts: { asIs: ConflictInfo, stripped: ConflictInfo | null }
}

/** 项目已安装的插件(Addon) */
export interface InstalledAddon {
  id: string
  projectId: string
  assetId: number
  title: string
  versionString: string
  /** addons/ 下的目录名 */
  dirNames: string[]
  installedAt: number
}

/** 扫描项目 addons/ 得到的插件信息(纯素材条目由市场安装记录生成) */
export interface AddonInfo {
  dirName: string
  name: string
  version?: string
  author?: string
  hasCfg: boolean
  enabled: boolean
  fromMarket: boolean
  assetId?: string
  versionString?: string
  installedAt?: number
  /** 安装形态:插件(addons/)或纯素材(项目根);旧记录缺省按插件处理 */
  kind?: 'addon' | 'asset'
  /** 素材:相对项目根的安装文件清单(正斜杠),仅 kind=asset 时有值 */
  assetPaths?: string[]
  /** 商店页面地址(来自市场安装记录;无来源信息时为空) */
  storeUrl?: string
}

/** project.godot 解析结果 */
export interface ProjectInfo {
  name: string
  configVersion: number
  engineVersion?: string
  icon?: string
}

/** db 文档 id 约定 */
export const DOC_ID = {
  settings: 'godot/settings',
  releasesCache: 'godot/cache/releases',
  version: (tag: string, variant: Variant, platform: Platform) =>
    `godot/version/${tag}-${variant}-${platform}`,
  project: (id: string) => `godot/project/${id}`,
  backup: (id: string) => `godot/backup/${id}`,
  addon: (projectId: string, assetId: number) => `godot/asset/${projectId}/${assetId}`
} as const

export const DOC_PREFIX = {
  project: 'godot/project/',
  version: 'godot/version/',
  backup: 'godot/backup/',
  asset: 'godot/asset/'
} as const

// ---------- 工具页（项目体检）原语的返回类型 ----------
// 见 docs/tools-page-plan.md §5.4。rel 一律是「相对项目根、正斜杠」的路径。

/** scanProjectTree 的单条文件记录 */
export interface TreeEntry {
  /** 相对项目根,正斜杠。如 `scene/main.tscn` */
  rel: string
  /** 字节数 */
  size: number
  /** 最后修改时间(毫秒)。缓存体检靠它判断陈旧 */
  mtimeMs: number
  /** 小写扩展名,不含点。无扩展名时为空串 */
  ext: string
}

export interface ScanTreeResult {
  ok: boolean
  error?: string
  files?: TreeEntry[]
  /** 命中 maxEntries 时 true:调用方必须在结论里标注「基于部分文件」 */
  truncated?: boolean
}

export interface ReadTextResult {
  ok: boolean
  error?: string
  text?: string
  /** 文件字节数(截断/跳过时也会给) */
  bytes?: number
  /** 超过 maxBytes:未返回 text */
  truncated?: boolean
  /** 前 512 字节含 NUL:未返回 text */
  skippedBinary?: boolean
}

export interface WriteTextResult {
  ok: boolean
  error?: string
  /** 原文件的备份相对路径(未备份或原先无文件时为 undefined) */
  backupRel?: string
}

export interface TrashResult {
  ok: boolean
  error?: string
  moved?: number
  failed?: { rel: string; error: string }[]
}

/** 自编译导出模板任务(buildtools,kind='tplbuild') */
export interface TemplateBuildTask {
  id: string
  kind: 'tplbuild'
  tag: string
  srcDir: string
  jobs: number
  status: 'queued' | 'building' | 'done' | 'error' | 'canceled'
  /** 构建输出尾部(失败诊断用) */
  log: string
  error?: string
  /** 未经翻译的原始输出尾部(诊断用,界面展示 error) */
  errorDetail?: string
  /** 完成后:stage 根目录(内含 templates/ 顶层,交给 installExportTemplates 目录形态导入) */
  stageDir?: string
  /** 完成后:tag 派生的模板目录名 */
  versionDir?: string
  /** 完成后:stage 里的文件数 */
  files?: number
  /** 本次编译下发的 profile 文件路径(任务记录里仍在供回查;那个临时文件本身在构建终态就删了) */
  profilePath?: string
  /** 实际下发的 scons 变量名(profile 键与命令行 token **两条通道**都算,不含被跳过的与同源码默认的) */
  writtenFlags?: string[]
}

export interface HashPathsResult {
  ok: boolean
  error?: string
  /** 成功项:rel 与它的 SHA-256(hex 小写)。顺序与调用方点名的顺序一致(失败项除外) */
  hashes?: { rel: string; sha256: string }[]
  /** 失败项:rel + 原语中文原因(闸拒绝回调用方原样,其余归一);单个失败不中断其余 */
  failed?: { rel: string; error: string }[]
}

/** ---------- 导出模板自编译:探测层 / 面板 / 静态校验的返回值(策划书 §5.1 三层模型) ---------- */

/**
 * 裁剪模式:`default-on` = 模块默认开,取消的那项写 false;
 * `default-off` = 反向白名单(命令行发 `modules_enabled_by_default=no` 整体关掉,保留的模块显式点名 true)。
 * 与 `tplprofile.js:61` 的 `@typedef ProfileMode` 同名同形 —— 这里是渲染层可见的那一份,
 * 两处必须一起改:校验层的第 3 条硬拦只在 `default-off` 下才可能触发。
 */
export type TplProfileMode = 'default-on' | 'default-off'

/** 探测层输出:某个 scons 变量在这份源码里的存在性与默认值 */
export interface TplOptionInfo {
  exists: true
  default: boolean | string
}

/** 面板项 + 探测结果,渲染层直接渲染这一份 */
export interface FeatureWithProbe {
  id: string
  label: string
  group: string
  desc: string
  sizeImpact: 'large' | 'medium' | 'small' | 'tiny' | 'none'
  risk: 'safe' | 'notice' | 'danger'
  flags: string[]
  /** 任一 flag 探到即为 true;false → 面板禁用并标「此版本源码无对应开关」 */
  present: boolean
  /** 由源码默认值推出的初始勾选态 */
  defaultOn: boolean
  /** 被哪个伞项连带(仅当探测到该连带关系) */
  cascadedBy?: string
}

/** 一份源码树的探测结果(tplprobe.probeSource 原样透传,契约层不改写) */
export interface ProbeResult {
  ok: boolean
  error?: string
  sourceVersion: string
  tested: boolean
  options: Record<string, TplOptionInfo>
  cascades: Record<string, string[]>
  testedVersions: string[]
}

/** 编译前校验的一条判定。`skippable: false` = 硬拦,UI 不给「仍然继续」这条路 */
export interface TplIssue {
  itemId: string
  flag: string
  why: string
  action: string
  skippable: boolean
}
