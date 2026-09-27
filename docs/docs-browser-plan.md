# 引擎文档浏览功能策划书与计划书

> 目标：在 ZTools 插件「Godot 项目管理」内提供 Godot 引擎类参考（Class Reference）浏览，
> 对标 Godot 编辑器内置帮助的阅读体验，并增加多版本、全局搜索、收藏等增强。
> 状态：**策划 + 计划（未开工）**。文中插件侧结论均带 `file:line` 证据；`--doctool` 的实际行为
> 属**待实测项**，在第 9 节单列，不要当成已知条件。

---

# 第一部分 · 策划书

## 0. 结论先行

把「引擎类参考」装进插件，**数据从用户已装的引擎里来**：用 `exe --headless --doctool <dir>`
把编译进引擎二进制的类文档导出为 XML（与编辑器内置帮助同源），解析成结构化 JSON 后建索引。
零网络依赖、与已装版本逐字节对应；GitHub 源仅作「未装引擎」时的兜底。

MVP 只做四件事：**生成、浏览、搜索、收藏**。分期如下：

| 期 | 内容 | 一句话 |
|---|---|---|
| P0 | 文档库生成 + 类浏览页 + Ctrl+K 搜索 + 收藏/历史 | 能生成、能看、能搜、能钉住 |
| P1 | 继承图谱、多版本切换、项目联动跳转、GitHub 兜底、复制/外开在线文档 | 从「能用」到「好用」 |
| P2 | 全文搜索、跨版本 API 差异对比、C#(.NET) 文档、自定义类文档 | 探索项，逐个立项 |

三个数据源方案的对比（决策依据见第 2 节）：

| 方案 | 版本精确性 | 网络依赖 | 成本 | 结论 |
|---|---|---|---|---|
| A. `--doctool` 从已装引擎导出 | 与引擎二进制**完全一致** | 无 | 复用现有 spawn 引擎模式 | **主源（P0）** |
| B. GitHub `doc/classes/*.xml` 下载 | 按 tag 对应 | 有（需代理） | 断点续传/重试已有 | 兜底（P1） |
| C. 抓 docs.godotengine.org HTML | 版本对应但页面会改版 | 有 | 解析脆弱、体积大 | **排除** |

## 1. 需求背景与用户场景

- **对标对象**：Godot 编辑器内置帮助（截图即 `Node` 类页）：类/继承/派生、带行内链接的描述、
  教程链接、信号/成员/方法/枚举/主题属性分节。我们要在 ZTools 里提供同等体验。
- 用户场景：
  1. **写代码时查 API**——不想切出当前工具窗口；国内访问 docs.godotengine.org 慢且不稳。
  2. **离线环境**——插件的价值主张包含本地化，文档也不该依赖网络。
  3. **多版本差异**——用户同时装 4.2 / 4.4 / 4.5，想知道「这个方法在 4.3 有没有」；
     文档按版本生成天然支持。
  4. **常用类钉住**——`Node`、`Node2D`、`Tween` 反复查，要一眼直达。

## 2. 数据源决策

### 2.1 方案 A（主源）：`--doctool` 从已装引擎导出

- 官方编辑器二进制内置完整类参考，`godot --headless --doctool <dir>` 可将其导出为
  `doc/classes/*.xml`（Godot 3/4 均支持该 CLI 参数；**具体输出结构、耗时、是否需要
  `--no-docbase` 见第 9 节实测项**）。
- 插件侧全部前置能力已就绪：
  - spawn 引擎 CLI 的完整模式：`src-ztools/preload/lib/exporter.js:17`（独立串行
    `createTaskQueue`）、`:34`（`LOG_TAIL` 尾部日志留作失败诊断）；`launcher.js:13`
    `splitLaunchArgs` 处理引号参数。
  - 引擎可执行文件定位与校验：`godotExe.js:40 findExecutable` / `:76 verifyExecutable`。
  - 每个已装版本都有 `exePath`：`src/types/godot.ts:17 GodotVersion`，落库于 `godot/version/`。
- 版本精确性是编辑器抓网页给不了的：文档与引擎二进制同源编译，绝不出现「文档比引擎新」。

### 2.2 方案 B（兜底）：GitHub `doc/classes` 下载

- 未装引擎（或导入的本地引擎不含文档）时，可按 `tag` 从
  `github.com/godotengine/godot` 拉 `doc/classes/`。问题：单仓库 zip 太大（百 MB 级）、
  按文件拉 700+ 个会打爆未认证速率限制。
- `http.js` 已有代理（`GodotSettings.proxy`，`godot.ts:130`）、断点续传与重试，
  但**体积与速率是硬伤**，只作 P1 兜底，且倾向「按需拉取单个类的 XML」而非全量。

### 2.3 方案 C（排除）：抓官方文档站

- HTML 会随文档主题改版而失效，无版本一致性保证，体积大。不做。

## 3. 功能清单

### 3.1 P0 —— 第一期（MVP）

**F1 文档库生成与管理**

- 「文档」标签页内按已装版本列出文档库状态：未生成 / 生成中 / 已生成（类数 + 生成时间）。
- 一键「生成文档库」：入队后台任务（`kind='docs'`），进度分阶段
  （导出 XML → 解析 → 建索引），可取消，失败保留引擎输出尾部。
- 生成完成后版本卡片显示徽标；删除版本时（`install.js:213 deleteVersion`）提示是否一并删除文档库。
- 设置页缓存清理区新增「文档库缓存」条目（对齐 `cleanProjectCache` 先例）。

**F2 类浏览页（新「文档」标签）**

- 布局：左侧类列表（240px，可折叠）+ 右侧详情面板；列表支持框内过滤、
  按「继承根分组 / 字母序」切换。
- 详情面板对齐编辑器帮助结构：
  - 类名 + **继承链**（`Node ← Object` 面包屑，逐级可点）；
  - **派生列表**（直接子类，带引擎风格小图标，可点跳转）；
  - 简述与**描述**——BBCode 渲染为富文本（见 5.2），描述中的
    `[method _enter_tree]`、`[constant NOTIFICATION_READY]`、`[SceneTree]` 等
    行内符号渲染为可点击链接（截图中的蓝色链接效果）；
  - **教程链接**（`<tutorials>`，外开浏览器）；
  - 分节：**信号**（含参数表）、**成员变量**（名称/类型/默认值/可写性）、
    **方法**（签名 + 参数默认值 + 返回类型，点击签名内符号跳转）、
    **枚举与常量**、**主题属性**（有则显示）、**通知**（`NOTIFICATION_*`）。

**F3 搜索（Ctrl+K 全局 + 页内过滤）**

- 任意标签页按 `Ctrl+K` 呼出命令面板式浮层：类名 / 方法 / 成员 / 信号 / 常量
  分组匹配，键盘上下选择、回车跳转。
- 搜索走生成期建立的索引（见 5.3），本地即时返回，无网络。

**F4 收藏与历史**

- 详情面板一键收藏/取消；类列表顶部「收藏」分组置顶。
- 最近浏览（默认 30 条）入「最近查看」分组。
- 收藏与历史**全局存**（按类名，不按版本）：查 `Node` 的习惯不因版本库切换而丢；
  渲染时按当前版本的文档库解析内容。

### 3.2 P1 —— 第二期

**F5 继承图谱**：详情面板新增「继承树」视图——祖先链向上 + 直接派生向下的树形图，节点可点。

**F6 多版本文档库与切换**：每版本独立文档库并存；详情页顶部版本切换器（对齐
`VersionPickerDialog` 的交互习惯）；切换时保持当前类名，未收录则提示。

**F7 与项目联动**：项目卡片/版本页的「打开文档」入口直达当前项目引擎版本对应的文档库；
Dashboard 的 `@navigate`（`App.vue:214` 路由已支持跨标签跳转事件）。

**F8 GitHub 兜底源**：未装引擎时按需拉取单个类的 XML（非全量），走代理，带版本徽标
「在线兜底」与本地库区分。

**F9 复制与外开**：复制类/方法签名为 Markdown；「在官方文档中打开」直达
`docs.godotengine.org/en/<tag>/<Class>.html`。

### 3.3 P2 —— 第三期（探索，逐个立项）

**F10 全文搜索**：描述正文检索 + 「该符号被哪些类提及」反查（需倒排索引）。

**F11 跨版本 API 差异**：选两个版本对比某类的新增/移除成员与签名变化（依赖 F6 多库并存）。

**F12 C#(.NET) API 文档**：GodotSharp 的 API 与 GDScript 命名不一致（PascalCase），
数据源独立（doxygen 产物），单独立项评估。

**F13 自定义类文档**：扫描项目内 `class_name` 脚本生成简易文档页。价值待用户反馈，
暂不承诺。

## 4. 插件现状盘点（可插入点）

- **spawn 引擎 CLI 先例**：`exporter.js:17` 独立串行任务队列（phase:
  queued/exporting/done/error/canceled）、`:34` 任务上保留 40 行引擎输出尾部；文档生成
  照此办理。
- **任务进度 UI 全套现成**：任务快照订阅 `watchTasks`（`services.js:33`）、全局任务栏
  （`App.vue:256` `barTasks`）、任务对话框组合函数（`useTaskDialog.ts:37` 按 `kind`
  过滤）→ 新增 `kind='docs'` 即接入。
- **让出事件循环**：`fsutil.js:356` 导出 `yieldToLoop / forEachSliced / createCancelToken`，
  解析 700+ XML 用 `forEachSliced` 分片，避免长任务冻结界面。
- **原子落盘**：`fsutil.js` `tempPath`/`stamp` 先写后改名的既有约定（README「原子落盘」），
  索引与正文 JSON 全部走这条路径，失败不留残留。
- **缓存清理先例**：`projects.js` `cleanProjectCache`（services.js 暴露为
  `getProjectCacheInfo`/`cleanProjectCache`）→ 文档库照抄一组
  `docsCacheInfo`/`cleanDocsCache`。
- **缓存根目录**：`GodotSettings.versionsRoot`（`godot.ts:128`）是现成的插件管辖目录，
  文档缓存默认放 `<versionsRoot>/gpm-docs/<versionId>/`。
- **页面注册**：`TabBar.vue:5` `tabs` 数组加第 8 项；`App.vue:214` v-if 路由 +
  `KeepAlive`；窄窗收缩规则已有（`TabBar.vue:113` 注释：980px 收内边距 → 900px 隐藏副标题
  → 800px 只留图标）。
- **类型契约闸门**：`services.js:6` `@type` 注释声明「必须不多不少实现 Services 的
  N 个方法」——新增 docs 方法必须同步双写 `src/types/services.ts`，编译器兜底。
- **测试范式**：`src-ztools/preload/lib/__tests__/*.test.js` 自带
  `main()/ok()/section()` 无框架断言；渲染层 `*.test.mjs` 同风格。

## 5. 关键设计与取舍

### 5.1 生成流水线与存储分层

```
exe --headless --doctool <tmp>
  → XML 落盘 <versionsRoot>/gpm-docs/<versionId>/xml/*.xml   （原始缓存，可重解析）
  → 分片解析（forEachSliced + 取消令牌）
      → classes/<Class>.json     每类结构化正文（描述/信号/成员/方法/枚举/主题属性）
      → index.json               全库索引（见 5.3）
  → db 记录 godot/docs/<versionId>   生成状态、类数、耗时、版本 tag、生成时间
```

- **db 只存索引摘要与元数据，正文不进 db**：类正文 JSON 走文件缓存按需读，
  db 体积不受 10MB 级正文拖累；db 中的 `godot/docs/favorites`、`godot/docs/history`
  存收藏与历史。
- `xml/` 原始文件保留：换解析器/升级功能时**免重新跑引擎**，只需重解析。

### 5.2 BBCode 渲染规则

Godot 类文档描述是 BBCode，不是 HTML。渲染器把描述解析为 **token 序列**（纯数据），
Vue 按 token 类型渲染组件，全程文本插值转义，**不使用 `v-html`**（与插件安全基线一致）：

| BBCode | 渲染 |
|---|---|
| `[ClassName]` / `[method X]` / `[member X]` / `[constant X]` / `[signal X]` / `[enum X]` | 行内链接，点击站内跳转；目标类不在当前库时显示占位样式 |
| `[code]…[/code]` | 行内代码样式 |
| `[codeblock]…[/codeblock]` | 代码块（P0 纯等宽着色，语法高亮 P1+） |
| `[b] [i] [u] [s] [center] [url=x]…[/url]` | 对应富文本样式/外链 |
| 未知标签 | **原样降级**为纯文本，绝不吞内容 |

各版本标签集合略有差异（如 `annotations` 节、`theme_items` 是否出现），解析器按
「认识的节 + 容错未知节」处理，未知节丢弃但计数，报告在生成结果里可见。

### 5.3 搜索索引

- `index.json` 每类一条：`{ name, inherits, brief, methods[], members[], signals[],
  constants[], enums[] }`（仅名称），单库约 0.5–1MB，**一次懒加载进内存常驻**。
- 匹配策略：类名前缀 > 类名包含 > 成员精确 > 成员前缀 > 成员包含，加权排序，默认返回 30 条。
- Ctrl+K 浮层与页内过滤共用同一个索引与打分函数（渲染层纯函数，可断言）。

### 5.4 服务面契约（P0 新增方法草稿）

```
docsGenerate(versionId): string                    // 入队,返回任务 id
docsCancelTask(id): void
docsLibraryStatus(versionId): DocLibraryStatus|null // 未生成返回 null
docsDeleteLibrary(versionId): void
docsListClasses(versionId): DocClassSummary[]       // 来自索引
docsGetClass(versionId, className): DocClassDetail|null
docsSearch(versionId, query, limit?): DocSearchHit[]
docsToggleFavorite(className, fav): void
docsListFavorites(): string[]
docsListHistory(): DocHistoryItem[]
docsPushHistory(className): void
docsCacheInfo(): { sizeBytes: number, libraries: { versionId, classes, updatedAt }[] }
docsCleanCache(versionIds?: string[]): void
```

共 13 个方法，`Services` 契约 47 → 60 个；`sandbox.d.ts` 无需新增全局
（仍走 `window.services` 门面）。

### 5.5 任务模型

- **独立串行队列**（不与 export/templates 共用）：文档生成也是 spawn 引擎，但耗时是
  秒~分钟级；独立队列保证导出长任务不被穿插阻塞，`kind='docs'` 使全局任务栏与
  `useTaskDialog` 天然区分。
- 阶段：`queued → dumping(引擎导出) → parsing(解析 XML) → done | error | canceled`，
  parsing 阶段进度按已解析类数/总类数上报。

### 5.6 数据导出/导入边界与卸载联动

- 文档库是**可再生成产物**：不进 `datatransfer.js` 迁移包；收藏/历史体量小，随迁移走。
- `deleteVersion`（`install.js:213`）增加「同时删除该版本文档库」的确认项；
  导入的本地引擎（`managed=false`）同样可有文档库，删除时按 `versionId` 清理。

### 5.7 UI 与窄窗

- 第 8 个标签「文档」（icon: `book`，`Icon.vue` 需补一枚线性图标）。
- 左列表 240px 可折叠；<900px 时列表与详情二选一（返回键返回列表）。
- 详情面板复用现有视觉令牌（`--surface/--border/--text-*`）与 `EmptyState`/`Icon`
  组件；空状态引导「选择一个已装版本生成文档库」。

## 6. 风险

1. **`--doctool` 行为未实测**（P0 前置闸门，见第 9 节）：输出目录结构、是否含全部
   基类文档、耗时、无显示环境下是否稳定。若实测不通过，P0 数据源降级为方案 B
   （按需单类拉取），功能面不变。
2. **XML 解析器选型**：preload 是 CommonJS 且受沙箱约束（无 `setImmediate`，
   `sandbox.d.ts` 有护栏测试）。类文档 XML 结构简单规整，倾向**手写轻量解析**
   （状态机 + 正则），零依赖、可控分片；不引入 DOM 解析库。
3. **体积与内存**：单版本磁盘 ~10–15MB、索引内存 ~1MB，量级可控；但用户装 N 个版本
   就有 N 份——缓存清理入口必须显眼。
4. **跨库链接悬空**：描述可能链接到编辑器专属类或当前库未收录类，点击给占位提示，
   不许白屏。
5. **第 8 个标签的宽度**：`TabBar.vue:113` 已有三级收缩规则，800px 以下只剩图标，
   影响有限；品牌区副标题 900px 隐藏。

## 7. 验收标准（P0）

- [ ] 对任一已装版本可一键生成文档库，全程后台任务：进度可见、可取消、失败可诊断
      （任务尾部保留引擎输出）。
- [ ] 类详情面板呈现：继承链、派生列表、描述（含可点行内链接）、教程、
      信号/成员/方法/枚举常量/主题属性/通知分节，与编辑器帮助信息结构一致。
- [ ] `Ctrl+K` 全局呼出搜索：类名/方法/成员/信号/常量分组命中、键盘可完整操作；
      断言覆盖打分函数。
- [ ] 收藏/历史跨版本生效；最近浏览默认 30 条。
- [ ] `npm test` 新增断言组全绿：XML 解析（真实样例 fixture）、BBCode token 化
      （含未知标签降级）、索引搜索打分、生成状态机、缓存清理无残留；
      `npm run verify` 双层类型检查通过（Services 契约 47 → 60 双写一致）。

---

# 第二部分 · 计划书（P0 任务拆解）

## 新增文件

| 文件 | 内容 |
|---|---|
| `src-ztools/preload/lib/docs.js` | 生成流水线（doctool → 解析 → 索引）、独立任务队列、收藏/历史、缓存清理 |
| `src-ztools/preload/lib/__tests__/docs.test.js` | 上述全部断言（无框架 `main()/ok()/section()` 风格） |
| `src/composables/useDocs.ts` | 文档库状态、类列表/详情加载、搜索、收藏历史的跨层封装 |
| `src/composables/__tests__/useDocs.test.mjs` | 渲染层断言 |
| `src/views/DocsView.vue` | 文档标签页（库状态 + 列表/详情布局） |
| `src/components/docs/DocClassPanel.vue` | 详情面板（继承链/派生/分节渲染） |
| `src/components/docs/DocSearchPalette.vue` | Ctrl+K 浮层 |
| `src/utils/bbcode.ts` | BBCode → token 序列的纯函数（可独立断言） |

## 修改文件

| 文件 | 改动 |
|---|---|
| `src-ztools/preload/services.js` + `src/types/services.ts` | 契约双写 13 个 docs 方法 |
| `src/types/godot.ts` | `DocLibraryStatus / DocClassSummary / DocClassDetail / DocSearchHit / DocHistoryItem` |
| `src/App.vue` | 第 8 标签路由 + `Ctrl+K` 全局监听 + 任务栏 `kind='docs'` 文案 |
| `src/components/TabBar.vue` / `Icon.vue` | 新标签与 book 图标 |
| `src/views/SettingsView.vue` | 文档库缓存清理条目 |
| `src-ztools/preload/lib/install.js` | `deleteVersion` 联动删除文档库（带确认） |
| `src-ztools/preload/lib/datatransfer.js` | 迁移包排除文档库（收藏/历史保留） |
| `README.md` / `CHANGELOG.md` | 功能说明与发布记录（发布四件套惯例） |

## 里程碑

1. **M1 实测闸门**：`--doctool` 实测（多版本矩阵）+ 手写 XML 解析器 PoC → 决定主源是否成立。
2. **M2 preload 完成**：docs.js + 测试全绿（生成/解析/索引/收藏/缓存）。
3. **M3 渲染层完成**：DocsView + 详情面板 + Ctrl+K + 收藏历史；`npm run verify` 通过。
4. **M4 收尾**：设置页清理条目、卸载联动、README/CHANGELOG、发布。

---

## 9. 待确认清单（实测/讨论后才能定，不要当成已知条件）

1. **`--doctool` 实测矩阵**（M1）：4.2 / 4.3 / 4.4 / 4.5（stable 与 .NET 变体）各自的
   输出目录结构、是否含引擎全部基类、耗时、退出码；导出模板二进制是否含文档（预期不含，
   仅编辑器可用）；`--no-docbase` 之类开关在 4.x 是否仍存在。
2. **文档缓存默认目录**：`<versionsRoot>/gpm-docs/`（本方案默认）是否合适，
   还是需要独立设置项（与 backupRoot 平级）。
3. **db 体积敏感性**：索引摘要进 db（本方案）还是全部留文件缓存、db 只存状态——
   需确认 ZTools db 对单文档/总量有没有实际上限。
4. **C# 文档数据源**（P2/F12）：GodotSharp 的 doxygen 产物获取方式待调研。
5. **自定义类文档**（P2/F13）：是否值得做，等 P0 上线后由用户反馈决定。
