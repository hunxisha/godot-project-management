# Godot 工坊

> 下载并管理 Godot 引擎版本与导出模板、隔离并快捷打开项目、浏览官方资产市场并安装插件与素材、
> 一键 headless 导出游戏、为项目做完整备份。

ZTools 插件。渲染层为 **Vue 3 + Vite + TypeScript**，Node 能力由 **preload 层**（CommonJS）注入，
两者之间只通过 `window.services`（预加载能力）与 `window.ztools`（宿主 API）两个全局对象通信。

支持平台：Windows / macOS / Linux。

> **另提供桌面版（Tauri 2）**：同一套渲染层换宿主（Rust 核心 + 系统 WebView），无需安装 ZTools
> 即可独立运行。构建与开发命令见下方「[桌面版](#桌面版tauri-2)」。

## 功能

界面分 9 个页面（7 个顶栏标签 + 齿轮按钮进入的设置页 + 主题切换按钮）：

| 页面 | 内容 |
|---|---|
| **概览** | 项目与引擎统计、收藏项目快捷入口、默认引擎 |
| **项目** | 添加/新建/删除项目（支持「从市场模板创建」与**新建时用 Git 管理**）、绑定引擎版本、拖入 `project.godot` 或项目文件夹、版本不匹配提醒、收藏、创建备份、**一键导出**（见下）、自定义启动参数、`.godot` 缓存清理 |
| **版本** | 引擎版本列表（官方归档 + 24h 缓存）、队列式下载安装（**断点续传 + 自动重试**）、解压前 zip 预检、导入本地引擎、删除已装版本、**导出模板下载/安装/卸载**（遵循 Godot 目录规则，含 `._sc_` 自包含模式） |
| **市场** | 官方 Asset Store：插件/素材浏览（全部/模板/推荐/新品/最近更新/收藏 + 标签筛选 + 服务端分页搜索翻页）、**内容嗅探安装**（插件进 `addons/`，纯素材按原结构入项目根）、安装确认预览（类型/冲突/wrapper 并入选项）、完整项目一键**另存为新项目**、仅下载 zip、资产详情（截图/许可/评分）、**全库更新巡检**、插件与素材**复制到其他项目** |
| **已安装** | 插件/素材分区展示、启用/禁用、卸载（Windows 移入回收站）、从历史版本替换、批量操作、检查更新 |
| **文档** | **引擎类参考离线浏览**：从已装引擎一键生成文档库（`--dump-extension-api-with-docs`，与引擎版本逐字节对应，约 1s）、**自动套用官方简体中文翻译**（显示覆盖率，未翻译条目保留英文）、类详情（继承链/派生/描述行内链接/信号/成员/方法/枚举常量/通知/运算符、**教程链接**、**继承树**、**复制签名**、**外开官方在线文档**、**返回上次浏览**、右侧本页目录）、`Ctrl+K` 全局搜索（类/方法/成员/信号/常量，可切换**含正文**）、侧栏过滤支持成员名、收藏与最近浏览（跨版本生效）、多版本库存与管理、**详情页切库**、**导入 API 文件建库**（无引擎也可用）、**跨版本 API 差异对比**、**项目脚本文档**（扫描 class_name 脚本）|
| **备份** | 全部项目备份的集中管理：统计、搜索、筛选、按项目分组 / 时间轴、批量删除、备注、完整性校验、保留策略清理、三步恢复向导 |
| **工具** | 单个项目的健康检查,16 项:体积与大文件分布、`.godot` 缓存、场景资源断链、`project.godot` 配置校验、UID(重复/孤儿边车/缺边车)、脚本(class_name 重复与继承成环)、场景(同名兄弟/load_steps 不符/节点脚本丢失)、输入映射(动作名未定义与大小写冲突)、本地化(翻译文件缺失与 csv 键重复)、导出预设(名字重复与点名的资源丢失)、版本控制卫生(`.godot` 是否被忽略/缺 `.editorconfig`/未被忽略的大文件)、敏感信息(写死的密钥/私钥,结论只给掩码)、未引用资源、addons 插件体检、`.import` 一致性、GDScript 文本卫生格式化。顶栏第 7 个标签,支持一键全量体检与**一键复制 Markdown 报告**(同时存进插件数据,每项目留最近一次);会动盘的修复一律**先列完整清单、逐条默认不勾选**,删除走回收站(非 Windows 明示永久删除),改写先落 `.gpm-bak-` 备份 |
| **设置** | 主题（5 色板 × 明暗）、引擎目录、网络代理、Asset Store 账号、默认打开动作、删除项目行为、备份默认项、**数据导出/导入**（换机迁移）、**文档库缓存统计与清理**、**网络诊断** |

### 一键导出

项目的 `export_presets.cfg` 会被解析成预设列表，选择后调用引擎 CLI
（`--headless --export-release / --export-pack`）完成导出：

- 导出前预检该引擎版本的**导出模板**是否就绪，缺模板可一键下载（进度走全局任务栏）；
- 引擎输出尾行实时展示，可取消，失败带诊断日志；
- 支持「导出全部预设」（串行队列）；导出历史落库（产物大小/路径/时间），可打开所在目录。

### 素材与插件怎么区分

商店 API 的类型字段把纯素材（模型/精灵等）也归在 Addon 下，不可信。安装时以 **zip 内容嗅探**
为唯一判据：含 `plugin.cfg` 走插件链路（进 `addons/` 并按设置启用）；否则视为纯素材，按包内
原结构写入项目根，并记录文件清单——卸载按清单精确回收（Windows 移入回收站），更新先清后装。

### 引擎文档库为什么不用 --doctool

官方编辑器二进制的 `--doctool` 导出的 XML **只有 API 结构、描述文本为空**（在 4.7.2 /
4.8-dev6 上实测）。插件改用 `--dump-extension-api-with-docs`：单个 `extension_api.json`
（约 12MB、~1s）带完整 BBCode 描述，`JSON.parse` 即得——覆盖 core 类、builtin 类
（Vector2 等）与 GDScript 全局函数，无需任何 XML 解析器。生成走暂存目录 + 原子接管，
失败/取消不影响旧库；文档库是可再生成产物，不进数据迁移包（只有收藏与浏览历史跟着走）。
设计与实测记录见 [docs/docs-browser-plan.md](docs/docs-browser-plan.md)。

中文翻译来自 godot 仓库的 [`doc/translations/zh_Hans.po`](https://github.com/godotengine/godot/tree/master/doc/translations)
（与编辑器内置中文帮助同源）：实测其 msgid 与 `extension_api.json` 的英文描述**逐字符一致**，
因此按原文查表替换即可（4.7.2 brief 全命中），无需对齐算法；翻译按来源 ref 磁盘缓存，
dev 版本走「tag → 小版本分支 → master」回退链，全部失败则降级英文库。

### 触发指令

| 指令 | 触发词 | 进入 |
|---|---|---|
| `godot` | `godot` / `Godot工坊` | 概览 |
| `projects` | `gp` / `godot项目` / `打开godot项目` | 项目 |
| `versions` | `gv` / `godot版本` / `下载godot` | 版本 |
| `plugins` | `godot插件` / `godot插件市场` | 市场 |
| `addProject` | 拖入项目文件夹或 `.godot` 文件 | 项目（自动添加） |

### 三处值得说明的设计

- **备份**：底层用「同步 fs + 分片让出事件循环」，因此长任务不会冻结界面，可实时看进度并随时取消；
  先写 `.gpm-tmp-*` 再原子改名，失败或取消不留任何残留文件或脏记录。
  恢复提供「恢复为新项目」与「覆盖原项目」两种模式，后者需输入项目名确认，且进入替换阶段后取消会被拒绝。
  细节见 [docs/backup-redesign-plan.md](docs/backup-redesign-plan.md)。
- **主题**：色板（5 套）× 明暗（浅/深/跟随宿主）共 10 种外观。语义色（危险/成功/警告）与项目头像渐变
  刻意不随色板变化——前者承载含义，后者用于区分项目。新增色板的步骤与对比度门槛见
  [docs/theme-system.md](docs/theme-system.md)。
- **数据存储**：全部状态存在 ZTools 的 db 中（无独立数据库文件），按文档 ID 前缀区分：
  `godot/settings`、`godot/version/*`、`godot/project/*`、`godot/asset/*`、`godot/backup/*`、
  `godot/templates/*`、`godot/export/*`、`godot/docs/*`（文档库元数据/收藏/历史）、`godot/cache/*`。
  换机迁移用「设置 → 数据导出/导入」：项目只登记本机存在的路径，收藏按 assetId 合并，
  文档收藏与浏览历史并集合并，设置只补缺失键。

## 目录结构

```
├── src/                          渲染层(Vue 3 + TypeScript)
│   ├── main.ts                   入口 + 环境守卫(缺少宿主 API 时给出可执行提示)
│   ├── App.vue                   标签路由、KeepAlive、全局任务栏(下载/备份/导出/文档)、Ctrl+K
│   ├── main.css                  设计令牌与 10 套主题
│   ├── views/                    9 个页面
│   ├── components/               通用组件、dialogs/ 下的对话框、docs/ 下的文档组件(BBCode 渲染/类详情/搜索面板)
│   ├── composables/              备份/主题/市场浏览·搜索·安装·巡检/导出/项目操作/文档库等组合式函数
│   ├── services/bridge.ts        宿主 API 统一出口
│   ├── types/godot.ts            领域模型与文档 ID 约定
│   ├── types/services.ts         window.services 契约(唯一权威,编译器强制两侧一致)
│   └── utils/                    共享工具(格式化/版本兼容/标签分组/头像渐变/BBCode 解析)
├── src-ztools/                   ZTools 插件目录
│   ├── plugin.json               插件清单(指令、preload、图标、平台)
│   ├── logo.png
│   ├── preload/
│   │   ├── services.js           window.services 门面
│   │   ├── sandbox.d.ts          手写精简沙箱声明(刻意不声明 setImmediate)
│   │   └── lib/                  领域模块:releases/install/templates/exporter/extract/
│   │                             godotExe/projects/launcher/assets/backup/datatransfer/
│   │                             diagnostics/docs + 基础设施 http/store/fsutil/taskqueue
│   └── dist/                     构建产物(git 忽略)
├── src-tauri/                    桌面版(Tauri 2 宿主:Rust 核心 + 系统 WebView)
│   ├── src/main.rs               命令面(#[tauri::command] 全量注册)与 AppState
│   ├── src/*.rs                  领域模块:store/projects/versions/releases/templates/
│   │                             assets/backup/docs/launcher/extract + 基础设施
│   │                             http/fsutil/taskqueue(与 preload/lib 同名域一一对应)
│   ├── tests/parity.rs           与 ZTools 能力层的行为对齐断言
│   ├── tauri.conf.json           bundler 配置(frontendDist = ../src-ztools/dist)
│   └── RELEASE_NOTES.md          桌面版发布说明(CI 建草稿 Release 时取用)
├── docs/                         设计文档(备份/主题/优化计划/GodotHub 集成策划/引擎文档浏览策划/Tauri 迁移策划/术语表)
└── */__tests__/                  回归测试(preload 与渲染层)
```

## 开发

```bash
npm install
npm run dev        # Vite 监听 127.0.0.1:5173,ZTools 自动加载开发版
npm run build      # vue-tsc 类型检查 + 构建到 src-ztools/dist/
```

调试：在 ZTools 中打开插件后，点击插件头像图标 → 「打开开发者工具」。
直接用浏览器访问 dev 地址会因缺少 ZTools API 而无法运行（入口有环境守卫，会显示原因而不是白屏）。

术语（分片让出、原子落盘、来源过户、保留策略…）见 [`docs/glossary.md`](docs/glossary.md)。

### 桌面版（Tauri 2）

桌面版是**同一套渲染层的第二个宿主**：Rust 核心 + 系统 WebView。`src-tauri/src/` 的领域模块与
`src-ztools/preload/lib/` 同名域一一对应，行为差异由 `src-tauri/tests/parity.rs` 钉住；渲染层靠
`window.ztools.isDesktop` 分流少数位置（如项目页内嵌搜索框，替代 ZTools 的子输入栏），
垫片在 `src/public/tauri-shim.js`。

```bash
npm run dev:tauri     # 开发:Vite + Tauri 窗口(渲染层热更新)
npm run build:tauri   # 打包当前平台安装包到 src-tauri/target/release/bundle/
npm run cargo:check   # 只编译 Rust 核心,不出包
```

桌面版数据存在应用数据目录的 `godot-workshop/db.json`，文档结构与 ZTools 宿主一致，
因此「设置 → 数据导出/导入」可跨两端迁移；1.x 桌面版（已退役的 Electron 宿主）用户
直接拷 `db.json` 过来即可，文件格式未变。版本号在 `src-tauri/Cargo.toml` 独立走线
（`desktop-v*` tag 触发 `.github/workflows/desktop-release.yml` 三平台打包并建草稿 Release，
发布说明取 `src-tauri/RELEASE_NOTES.md`），与插件 zpx 的发版节奏互不影响。
迁移设计与实测记录见 `docs/tauri-migration-plan.md`。

## 测试

```bash
npm run verify     # 类型检查 + 全部回归断言（提交前跑这一条）
npm test           # 全部断言（数量随版本增长,各套件实况见下）
```

| 命令 | 覆盖 |
|---|---|
| `npm run typecheck` | `vue-tsc` 渲染层 + `tsc` preload 双层类型检查 |
| `npm run test:theme` | 主题令牌完整性、设计约束、10 种组合的 WCAG 对比度 |
| `npm run test:preload` / `:sandbox` | 备份领域层全套（后者先删掉 `setImmediate` 模拟宿主沙箱） |
| `npm run test:preload:unit` | 版本解析、任务队列、文件工具、HTTP 下载与**断点续传**、引擎安装、**导出模板**、**一键导出**、启动参数拆分、**数据迁移/网络诊断**、**引擎文档库**、services 契约一致性、**文档存储 `_rev` 语义** |
| `npm run test:addons` | 插件/素材来源、安装分流、清单卸载、复制过户（默认 + 沙箱各一遍） |
| `npm run test:renderer` | 渲染层:市场搜索(分页/竞态守卫)/浏览/安装确认层、项目列表、已装操作、备份、文档数据层与 **BBCode 解析**、纯工具,**工具页十六项体检 + 修复管线**(引用索引、`project.godot`/`.import`/GDScript 解析、GDScript 顶层声明与场景 `[node]` 段解析、翻译 csv 首列、结论判定、按条勾选门;工具页目录内共 24 个 harness,性能基准 `perf.test.mjs` 刻意不挂链) |

提交与 PR 由 GitHub Actions 跑同一条命令（见 `.github/workflows/ci.yml`）。

渲染层测试一次性打包、共用同一份 vue chunk（`test:renderer` 先跑 `build-bundle.mjs`）：
脚本用 Node 直接运行，**不依赖测试框架**。也可以单独跑其中一条（`test:format` /
`test:taskdialog` / `test:composable` 会各自先打包，便于定位）。

> **`--no-immediate` 那一条务必保留**：preload 跑在渲染进程沙箱里，那里没有 `setImmediate`
> （Node 专有全局）。只跑默认路径会漏掉整整一类「本地能跑、宿主里报错」的问题。

> **回收站那一条默认跳过**：`test:preload` 里「删除 → 移入回收站」的真实链路会写系统回收站，
> 使 `npm test` 变成非幂等，因此默认跳过（结果行会打印 `SKIP`，不会静默少跑）。需要验证时用
> `GPM_TEST_TRASH=1 npm run test:preload` 显式开启。

## 环境要求

- Node.js ≥ 18（构建与测试）
- ZTools 宿主（运行插件）
- 网络：引擎与模板走 GitHub/官方 CDN，市场走 store.godotengine.org，均可通过设置中的 HTTP 代理转发
  （设置 → 网络诊断可一键探测三条链路）

桌面版无需 ZTools 宿主，用系统 WebView 渲染（Windows 10+ 依赖 WebView2，Win11 自带；
macOS 11+ 用系统 WKWebView；Linux 需 WebKitGTK）；
当前为**免签名构建**：Windows 首次运行会有 SmartScreen「未知发布者」提示（选「更多信息 → 仍要运行」），
macOS 需右键打开或到「隐私与安全性」放行。

## 许可

MIT
