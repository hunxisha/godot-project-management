# GodotHub 集成策划书与计划书

> 对象站点：[godothub.com](https://godothub.com/zh)（GodotHub，国内 Godot 社区）
> 目标插件：本项目（ZTools 插件「Godot 项目管理」）
> 状态：**策划 + 计划（未开工）**。文中所有站点信息均来自 2026-09-25 的实际抓取；所有插件侧
> 结论均带 `file:line` 证据。**待确认项在第 9 节单列**，不要当成已知条件。

---

# 第一部分 · 策划书

## 0. 结论先行

GodotHub 有**三个**可集成面，价值、成本、前置条件差别很大。建议的顺序**不是**按价值排序，而是按
「是否需要站方授权」排序 —— 因为它的后端是 PocketBase，`robots.txt` 明确 `Disallow: /api/`：

| # | 集成面 | 价值 | 是否需要站方授权 | 建议 |
|---|---|---|---|---|
| A | **引擎下载镜像**（`/zh/download`） | 高（直击国内下载慢/失败） | 抽象层不需要；**具体镜像 URL 规则需要** | 阶段 1 先做抽象层 + 可选哈希校验 |
| B | **开源项目精选**（`/zh/oss`） | 中（社区孵化的插件/框架） | 抓取需要（内容版权）；外链跳转不需要 | 阶段 2，先外链后内嵌 |
| C | **作品中心**（`/zh/center`，含「插件/模板/素材」分类） | 高（官方商店之外的中文资源） | **需要**（纯 API 数据） | 阶段 3，等授权 |

一句话：**能自己做的先做（A 的抽象层 + 哈希校验），需要喝咖啡的先发邮件（contact@godothub.com）**。

## 1. 站点侦察结果

### 1.1 已核实（本次实际抓取）

- **性质**：国内 Godot 社区平台，自 2023 年起办 GodotHub Festival；Godot 基金会为其出具过名称
  合规使用证明，且出现在官方社区列表中（`/zh/about` 自述，非本仓库可独立验证的事项，按「站方自述」看待）。
- **合作入口**：`contact@godothub.com`（`/zh/about` 明示「寻求合作请发邮件或加微信」）——**这是阶段 0 的关键抓手**。
- **后端**：PocketBase（`robots.txt` 的注释写着 `# PocketBase API and administration`，并提到 `/swagger/`）。
- **`robots.txt` 明确 Disallow**：`/api/`、`/_/`、`/swagger/`、`/login`、`/oauth2/`、`/user`、
  `/center/upload`、`/settings/` 等；并声明了两个 sitemap。
  → **结论：不得把 `/api/collections/...` 当公开接口抓。** 任何走 PocketBase 数据的集成，
  都必须先拿到站方授权（或由站方提供一个面向第三方的只读接口）。
- **作品中心**（`/zh/center`）：分类为 全部 / 游戏 / 软件 / **插件** / 模板 / 素材 / 其他。
  列表页 SSR 输出中**没有任何条目**，只有容器 → 数据是客户端请求的（即走 `/api/…`）。
- **引擎下载**（`/zh/download`、`/zh/download/stable`、`/zh/download/unstable`）：
  提供 Windows x86_64 / macOS Universal / Linux x86_64 的「高速下载」，另有导出模板、
  导出模板 C#/.NET、Android 编辑器版本；`/zh/download/stable` 页面上写着 **「SHA-256 校验已开启」**，
  版本列表同样是客户端加载（「正在加载版本资源…」）。
- **开源项目**（`/zh/oss`）：这一页是**服务端渲染**的，能直接读到项目名、分类、简介与跳转链接，
  例如 `Godot 微信小游戏` → `github.com/godothub/godot-minigame`、`TapTap SDK` →
  `github.com/godothub/godot-taptap`、`Compute Flow`、`Godot ECS`、`GMUI`、`Gode`、`Konado`，
  以及站内详情页 `/oss/<slug>/`。
- **公开 URL 空间**（`sitemaps/index.xml`）：`works-zh`、`catalog-zh`、`communities-zh`、`topics-zh`、
  `news-zh`、`users-zh` 等分片 → 说明「作品」与「目录」是两类实体，且对外暴露的是**页面**而非接口。

### 1.2 待确认（必须由站方或实测回答，见第 9 节）

- 镜像下载的 **URL 规则**（能否用固定前缀拼出「版本 + 平台 + 变体」的直链），以及是否允许第三方客户端直连。
- 作品中心是否有**面向第三方的只读接口 / API Key**，字段模型（id、标题、作者、分类、Godot 版本区间、
  文件、校验和、许可协议、下载计数）。
- 速率限制、是否需要 User-Agent 标识与回链、是否要求展示数据来源。
- 上传作品的**许可证字段**是否存在（决定我们能否在插件内展示/一键安装）。

## 2. 插件现状盘点（可插入点）

### 2.1 引擎下载链路

- `src-ztools/preload/lib/releases.js:6` `ARCHIVE_URL = 'https://godotengine.org/download/archive/'`，
  `:7` `CDN = 'https://downloads.godotengine.org/'`，`:8` 缓存文档 `godot/cache/releases`、`:9` TTL 24h。
- `releases.js:85` `fetchReleases(force)` **抓的是官方 archive 页面的 HTML**（`:91`），
  `:36` `buildAssets(tag)` 按当前平台拼出 CDN 直链。
- `src-ztools/preload/lib/install.js:34` `downloadAndInstall(params, opts)`，`:35` `params.url` 就是
  最终下载地址；`:91` 装完只做 `verifyExecutable`（跑 `--version`）。
- `src/types/services.ts:52` `downloadAndInstall(...)` 的入参即 `DownloadParams`
  （`tag / variant / platform / url / fileName / totalSize?`）。
- **结论**：**下载源是一个干净的插入点** —— 换源只需要换 `url`（外加新字段 `sha256`），
  `install.js` 的任务队列、进度、取消、原子落盘都不用动。
- **现状缺口**：全链路**没有任何哈希校验**（`sha` 在 `releases.js` / `install.js` 中零命中），
  「下到半个文件」只能靠 `--version` 事后发现。

### 2.2 插件市场链路（作品中心要对齐的就是这一套）

- 数据源只有一个：`src-ztools/preload/lib/assets.js:11`
  `API_BASE = 'https://store.godotengine.org/api/v1'`；入口函数
  `:87 listFeatured` / `:100 listAllAssets` / `:122 listNewAssets` / `:145 listRecentlyUpdated` /
  `:170 searchAssets` / `:197 getAssetDetail` / `:640 getReleaseInfos` / `:677 listAssetReleases`，
  `:68 mapAsset` 做统一映射。
- 类型模型：`src/types/godot.ts:219 MarketAsset`，注释写明 `assetId` 的语义是
  **官方商店的 `"{publisherSlug}/{assetSlug}"`**；`:242 FavoriteAsset`；`:247 InstalledAddon`
  （注意这里 `assetId: number`，与 `MarketAsset.assetId: string` **本来就不一致**）。
- 浏览层：`src/composables/useMarketBrowse.ts:18 MODE_META` 五种模式
  （全部/推荐/新品/最近更新/收藏）、`:16 POOL_PAGE = 20`、`:73 aggregating`
  （仅「服务端分页模式 + 已选标签」时启用客户端聚合池）。
- 标签体系：`src/utils/marketTags.ts:9-19` 把界面上的 9 个中文分类映射到商店的**自由标签 slug**
  （`2d/3d/ui/ai/tool/template/material/shader/editor`）——这是**官方商店的词汇表**，第二数据源几乎不可能
  直接复用。
- 安装与来源：`src/composables/useMarketInstall.ts:34` 传 `{projectId, assetId, version, assetMeta}`
  给 `installAsset`（`services.ts:202`）；preload 侧落库文档 id 形如
  `godot/asset/<projectId>/<assetId>`，`assets.js:346` 靠 `listDocs('godot/asset/<projectId>/')`
  反查「这个 addons 目录来自哪个市场资产」。
- 更新检查：`assets.js:491` / `:651` / `:679` 全部打官方 releases 端点 → **换源后必须同步换版本来源，
  否则「检查更新」会误报**。
- 收藏：`assets.js:542 FAVORITES_ID = 'godot/market/favorites'`，单一文档存全部收藏
  （`:581` 写库，`src/composables/useMarketFavorites.ts` 负责跨层传参与诊断）。

## 3. 集成面评估

### A. 引擎下载镜像（推荐先做）

- **要解决的问题**：国内直连 `downloads.godotengine.org` 慢/断流；`fetchReleases` 还要抓
  `godotengine.org` 的 HTML，同样受网络影响。
- **做法**：把「下载源」抽成插件设置项，`releases.js` 负责产出 `{url, sha256, source}`，
  `VersionsView` 选择源后把 `url`/`sha256` 交给 `downloadAndInstall`。
- **为什么先做**：不依赖站方的私有 API —— 抽象层本身对**任何**镜像（含用户自建、校内镜像）都有用；
  GodotHub 只是内置预设之一。
- **风险**：镜像的完整性与时效性由镜像方负责；**必须**做哈希校验，否则「加速」会变成「加速装错」。

### B. 开源项目精选（第二步）

- **要解决的问题**：官方商店收录偏「上架资产」，GodotHub 孵化的一批框架/工具（ECS、GMUI、Konado、
  godot-minigame）不在其中。
- **做法**：分两级 —— ①「外链级」：在插件里给一个「社区项目」入口，点击用系统浏览器打开
  `/zh/oss`（零拷贝、零合规风险）；②「内嵌级」：把项目清单渲染成卡片并支持一键装（从对应 GitHub
  仓库的 Release 拉 zip）。
- **注意**：`/zh/oss` 上列的东西**并不都是 addons 形态**（`Gode` 是 TypeScript 工具链、
  `Konado` 是框架、`SiameseChess` 是游戏），内嵌级必须逐个判定「能不能作为 addons 装进项目」，
  不能整页照搬。

### C. 作品中心的「插件」分类（待授权）

- **要解决的问题**：中文插件/模板的发现渠道，官方商店没有。
- **前置**：站方授权 + 字段模型确认。**在拿到授权前不写任何抓取代码**（见第 8 节）。
- **代价提示**：这一面一旦接入，插件的「市场」就从单源变成多源，牵动类型模型、标签体系、
  分页语义、收藏、更新检查、安装来源记录 —— 也就是第 4 节的五条设计决策全部要落地。

## 4. 关键设计决策

### 4.1 多源模型：加 `source`，不要改 `assetId` 语义

`MarketAsset.assetId` 现在被注释写死为官方商店的 `pub/slug`（`godot.ts:220`）。第二数据源进来后：

- **方案（采纳）**：`MarketAsset` 增 `source: 'asset-store' | 'godothub'`（缺省视为 `asset-store`，
  历史收藏与已装记录**无需迁移**），各源的 `assetId` 各自保持原样，身份 = `(source, assetId)`。
- **不采纳**：把 `assetId` 改写成分命名空间前缀（如 `gh:123`）。理由是它会**污染落库文档 id**
  （`godot/asset/<projectId>/<assetId>`，`assets.js:346` 的反查依赖它），一旦改名，老项目的
  「已安装来源」全部失联，需要数据迁移。
- **顺带修一个既存不一致**：`InstalledAddon.assetId: number`（`godot.ts:250`）与
  `MarketAsset.assetId: string` 语义冲突（收藏功能为此刻意做过数字/字符串归一化）。
  多源之前应先把这条统一（统一为字符串，或明确「`InstalledAddon.assetId` 是商店数字 id，
  与 `MarketAsset.assetId` 不是同一个东西」并改名）。

### 4.2 源切换，而不是跨源混排

`useMarketBrowse` 的分页/聚合逻辑（`:73` 仅分页模式+标签时聚合）是**围绕单一服务端的分页语义**
设计的。两个源混排会让「总页数、排序、聚合池、去重」全部失去定义。因此：

- UI 用**源切换器**（全部显示时只切换当前源，不做混合列表），标签体系按源切换
  （官方用 `marketTags.ts` 的 slug 词汇，GodotHub 用它自己的分类）。
- **明确不做**跨源合并列表与跨源去重（同一插件同时存在于两处时，各自独立显示并标注来源徽标）。

### 4.3 下载源抽象 + 强制哈希校验

- `DownloadParams` 增 `sha256?: string`（`services.ts:52`）；`install.js` 在解压前校验，
  不匹配则**拒绝安装、清理临时文件、任务标失败**，并在通知里写明期望/实际哈希。
- 设置页新增「引擎下载源」：`官方 CDN（默认）| GodotHub 镜像 | 自定义前缀`；
  失败自动回退官方并在通知里说明（回退要留痕，不能静默变慢）。
- 官方 CDN 目前拿不到哈希 → `sha256` 保持可选，**缺失即明确标注「未校验」**，
  而不是假装校验过（这是本仓库一贯的口径要求）。

### 4.4 更新检查必须跟着源走

`assets.js:491/651/679` 全打官方 releases 端点。多源后：官方资产走官方端点；GodotHub 资产走
它自己的版本来源（授权后确认；未授权则**不提供该源的更新检查**，而不是拿官方端点去猜）。

### 4.5 合规：能外链就不内嵌，能直连就不代理

- 不抓 `robots.txt` 里 Disallow 的路径（`/api/`、`/_/`、`/swagger/`、`/user`、`/center/upload`）。
- 不缓存/不再分发用户上传的作品文件与封面：**下载直连站方地址**，插件只传链接。
- UA 标识：现有 `http.js` 已统一带 `User-Agent: ztools-godot-plugin`；接入后应升级为
  带版本号与联系方式的 UA，便于站方定位流量来源。
- 站方要求回链/署名 → 在卡片上保留「数据来源：GodotHub」与「在 GodotHub 打开」入口。

## 5. 明确不做

- **不做爬虫式全量索引**：不遍历 sitemap 抓作品条目，不绕过 `/api/` 的 Disallow。
- **不镜像、不转存**站方的引擎包与用户作品文件（只做 URL 转发 + 校验和比对）。
- **不做账号互通**（不接 `/zh/user`、不做 GodotHub 登录/OAuth）。
- **不做跨源混排/去重/统一标签**（见 4.2）。
- **不把 `/zh/oss` 整页照搬**：只做「精选 + 可安装性判定」。
- **不碰论坛、活动、社区地图、更新日志**（与插件职责无关）。

## 6. 数据模型草案（供评审，不是最终形态）

```ts
// src/types/godot.ts
export type MarketSource = 'asset-store' | 'godothub'

export interface MarketAsset {
  /** 数据源;缺省视为 'asset-store'(历史数据兼容) */
  source?: MarketSource
  /** 源内标识:官方为 "pub/slug",GodotHub 为其记录 id */
  assetId: string
  // ...既有字段不变
  /** 该资产的版本列表来源(用于「检查更新」按源分流) */
  versionSource?: MarketSource
}

export interface DownloadParams {
  tag: string
  variant: Variant
  platform: Platform
  url: string
  fileName: string
  totalSize?: number
  /** 官方 CDN 暂不提供;镜像源提供时必须校验 */
  sha256?: string
  /** 下载源标识,用于通知与失败回退留痕 */
  source?: 'official-cdn' | 'godothub' | 'custom'
}
```

---

# 第二部分 · 计划书

## 7. 分阶段实施

每个阶段都是「可单独交付、可单独回退」的闭环；每阶段结束跑 `npm run verify` 并提交（本仓库既有约定）。

### 阶段 0 · 授权与事实确认（0.5–1 天，不写产品代码）

| 项 | 内容 |
|---|---|
| 动作 | 发邮件到 `contact@godothub.com`：说明插件是什么、想集成哪些面、请求（a）作品中心只读接口或授权（b）镜像 URL 规则与直连许可（c）速率限制与署重要求 |
| 交付物 | `docs/godothub-integration-answers.md`（把第 9 节的问答逐条记录，含「未获回复」也如实记） |
| 并行 | 本地验证镜像可达性：手动下 1 个版本，比对 SHA-256（**这是阶段 1 的前置事实**） |
| 退出条件 | 拿到 A 面 URL 规则 → 进阶段 1；拿到 C 面授权 → 阶段 3 可开工；两者都没拿到 → 阶段 1 只做抽象层（自定义前缀） |

### 阶段 1 · 引擎下载源抽象 + 哈希校验（2–3 天）

| 项 | 内容 |
|---|---|
| 交付物 | 设置项「引擎下载源」；`DownloadParams.sha256`；下载后校验与失败处理；官方源缺失哈希时的「未校验」标注；失败自动回退官方 |
| 涉及文件 | `src-ztools/preload/lib/releases.js`（产出 `{url, sha256, source}`）、`src-ztools/preload/lib/install.js`（校验 + 失败清理）、`src-ztools/preload/lib/fsutil.js`（流式 sha256，**不要整文件读进内存**）、`src/types/services.ts`、`src/types/godot.ts`、`src/views/VersionsView.vue`、`src/views/SettingsView.vue` |
| 验收 | ① 官方源回归：现有下载链路全绿（`test:preload:unit` 的 install/http 断言）② 故意给错哈希 → 安装失败、无残留文件、任务标失败 ③ 自定义前缀可用（用本地 file:// 或测试桩）④ 回退路径有通知且不改默认设置 |
| 回退 | 设置项默认「官方 CDN」，校验字段可选 → 关掉设置即回到当前行为 |
| 关键约束 | `setImmediate` 沙箱护栏（`sandbox.d.ts` 未声明 + `sandbox.test.js` 计数）不许被打破；新增 node API 必须先在 `sandbox.d.ts` 声明 |

### 阶段 2 · 社区项目（`/zh/oss`）外链级 → 内嵌级（2–4 天）

| 项 | 内容 |
|---|---|
| 2a 外链级 | 市场页加「社区项目」入口，点击用 `openExternal` 打开 `https://godothub.com/zh/oss`；零拷贝，可**立即上线** |
| 2b 内嵌级 | 仅对**确认可作 addons 安装**的项目（先在阶段 0 逐个人工判定）做卡片 + 一键装：从对应 GitHub 仓库 Release 拉 zip → 复用 `installAsset` 的下载/解压/落库管线；来源记为 `source: 'godothub'` |
| 涉及文件 | `src/composables/useMarketBrowse.ts`（源切换）、`src/views/MarketplaceView.vue`、`src/utils/marketTags.ts`（源内标签）、可能新增 `src-ztools/preload/lib/community.js`（精选清单的取数与缓存） |
| 验收 | ① 外链不引入任何网络请求（可断网点击）② 内嵌级：清单可缓存/可刷新、单项目安装成功且 `listAddons` 能识别来源、卸载正常 ③ 清单失效（仓库改名/删库）时给出明确错误而不是静默空白 |
| 回退 | 清单改为「空清单」即退回 2a；外链级无状态 |

### 阶段 3 · 作品中心「插件/模板」源（授权后，3–5 天）

| 项 | 内容 |
|---|---|
| 前置 | 站方授权 + 字段模型 + 速率限制确认（第 9 节必备项全部有答案） |
| 交付物 | `MarketSource = 'godothub'` 落地：独立取数、独立标签、独立分页；卡片带来源徽标；收藏兼容（无 `source` 的历史条目视为官方）；更新检查按源分流（未提供更新接口的源**不显示「检查更新」**） |
| 涉及文件 | `src-ztools/preload/lib/assets.js`（或新增 `godothub.js` 保持单文件职责）、`src/types/godot.ts`、`src/types/services.ts`、`src/composables/useMarketBrowse.ts`/`useMarketSearch.ts`/`useMarketInstall.ts`/`useMarketFavorites.ts`、`src/views/MarketplaceView.vue`、`src/components/dialogs/VersionPickerDialog.vue` |
| 验收 | ① 两个源来回切换：列表/分页/标签/收藏/已安装标记互不串台 ② 官方源回归零变化（既有 14 个渲染层测试套件全绿）③ 同一插件在两源各有一条记录时，安装互不覆盖（文档 id 不冲突）④ 接口失败/限流时该源降级为空列表 + 明确提示，不影响官方源 |
| 回退 | 源切换器的 GodotHub 项可整项隐藏（一个常量开关），官方源路径不受影响 |

## 8. 风险与合规

| 风险 | 等级 | 处置 |
|---|---|---|
| 抓 `/api/` 违反站方明确意愿（robots） | **高** | 阶段 3 前必须有书面授权；代码里不出现未授权的 `/api/` 调用 |
| 再分发用户上传内容引发版权争议 | **高** | 只直连站方下载地址，不转存、不缓存文件；卡片保留来源与跳转 |
| 镜像包被投毒/不完整 | 中 | 强制 SHA-256；无哈希的源标注「未校验」；校验失败拒绝安装 |
| 站点结构变更导致集成失效 | 中 | 取数集中在单一模块、失败降级为空列表 + 提示；不做逐页抓取 |
| 多源把市场层复杂度推高 | 中 | 源切换而非混排（4.2）；先统一 `assetId` 语义（4.1） |
| 镜像限速/封禁影响体验 | 低 | UA 标识 + 回退官方 + 失败留痕；不并发轰炸（沿用现有串行下载队列） |
| 维护成本：精选清单会过期 | 低 | 清单可远程刷新、带「最后更新时间」；失效条目给出明确错误 |

## 9. 需要你或站方回答的问题（阶段 0 清单）

1. 作品中心的**只读接口**能否提供给第三方客户端？字段模型与分页方式？是否签发 API Key？
2. 镜像下载的 **URL 规则**是什么？是否允许第三方客户端直连（含 UA 与频率限制）？
3. 是否有 **SHA-256（或其他校验和）** 可供客户端校验？官方 CDN 那侧我们拿不到，是否由贵站提供？
4. 作品的**许可证字段**是否存在？我们能否在插件内展示标题/作者/简介/封面并一键安装？
5. 是否需要**回链与署名**？希望以什么文案呈现（如「数据来源：GodotHub」）？
6. 有没有**速率上限**与**推荐缓存时长**？（我们现状：引擎版本列表有 24h 磁盘缓存
   `releases.js:8-9`，而市场请求**没有磁盘缓存**、只有 release 信息的内存缓存
   `assets.js` 的 `versionCache`；引擎下载是串行队列，不并发轰炸）
7. 若暂不开放接口，**外链级集成**是否可接受？（我们希望至少提供一个「在 GodotHub 查看」的入口）

## 10. 验收清单（可勾选）

- [ ] 阶段 0：授权与事实问答归档（`docs/godothub-integration-answers.md`）
- [ ] 阶段 0：镜像可达性与 SHA-256 手工比对有记录
- [ ] 阶段 1：`DownloadParams.sha256` 落地，校验失败不落盘、不留残留
- [ ] 阶段 1：下载源设置（官方 / GodotHub / 自定义前缀）+ 失败自动回退且有通知
- [ ] 阶段 1：官方源行为零回归（`npm run verify` 全绿）
- [ ] 阶段 2a：社区项目外链入口（无网络请求）
- [ ] 阶段 2b：可安装项目的一键装 + 来源识别 + 卸载
- [ ] 阶段 3：双源切换互不串台，官方源回归零变化
- [ ] 阶段 3：未授权/限流下的降级路径被断言覆盖
- [ ] 合规：插件内不出现未授权的 `/api/` 调用；卡片带来源标识；文件全部直连

## 11. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-25 | 首版：站点侦察（robots/各板块/校验和声明）+ 插件现状盘点 + 三面评估 + 五条设计决策 + 四阶段计划 |
