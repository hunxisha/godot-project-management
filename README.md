# Godot 项目管理

> 下载并管理 Godot 引擎版本与导出模板、隔离并快捷打开项目、浏览官方资产市场并安装插件与素材、
> 一键 headless 导出游戏、为项目做完整备份。

ZTools 插件。渲染层为 **Vue 3 + Vite + TypeScript**，Node 能力由 **preload 层**（CommonJS）注入，
两者之间只通过 `window.services`（预加载能力）与 `window.ztools`（宿主 API）两个全局对象通信。

支持平台：Windows / macOS / Linux。

## 功能

界面分 7 个页面（顶栏标签 + 主题切换按钮）：

| 页面 | 内容 |
|---|---|
| **概览** | 项目与引擎统计、收藏项目快捷入口、默认引擎 |
| **项目** | 添加/新建/删除项目（支持「从市场模板创建」）、绑定引擎版本、拖入 `project.godot` 或项目文件夹、版本不匹配提醒、收藏、创建备份、**一键导出**（见下）、自定义启动参数、`.godot` 缓存清理 |
| **版本** | 引擎版本列表（官方归档 + 24h 缓存）、队列式下载安装（**断点续传 + 自动重试**）、解压前 zip 预检、导入本地引擎、删除已装版本、**导出模板下载/安装/卸载**（遵循 Godot 目录规则，含 `._sc_` 自包含模式） |
| **市场** | 官方 Asset Store：插件/素材浏览（全部/模板/推荐/新品/最近更新/收藏 + 标签筛选 + 服务端分页搜索翻页）、**内容嗅探安装**（插件进 `addons/`，纯素材按原结构入项目根）、安装确认预览（类型/冲突/wrapper 并入选项）、完整项目一键**另存为新项目**、仅下载 zip、资产详情（截图/许可/评分）、**全库更新巡检**、插件与素材**复制到其他项目** |
| **已安装** | 插件/素材分区展示、启用/禁用、卸载（Windows 移入回收站）、从历史版本替换、批量操作、检查更新 |
| **备份** | 全部项目备份的集中管理：统计、搜索、筛选、按项目分组 / 时间轴、批量删除、备注、完整性校验、保留策略清理、三步恢复向导 |
| **设置** | 主题（5 色板 × 明暗）、引擎目录、网络代理、Asset Store 账号、默认打开动作、删除项目行为、备份默认项、**数据导出/导入**（换机迁移）、**网络诊断** |

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

### 触发指令

| 指令 | 触发词 | 进入 |
|---|---|---|
| `godot` | `godot` / `Godot管理` | 概览 |
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
  `godot/templates/*`、`godot/export/*`、`godot/cache/*`。
  换机迁移用「设置 → 数据导出/导入」：项目只登记本机存在的路径，收藏按 assetId 合并，设置只补缺失键。

## 目录结构

```
├── src/                          渲染层(Vue 3 + TypeScript)
│   ├── main.ts                   入口 + 环境守卫(缺少宿主 API 时给出可执行提示)
│   ├── App.vue                   标签路由、KeepAlive、全局任务栏(下载/备份/导出)
│   ├── main.css                  设计令牌与 10 套主题
│   ├── views/                    7 个页面
│   ├── components/               通用组件与 dialogs/ 下的对话框
│   ├── composables/              备份/主题/市场浏览·搜索·安装·巡检/导出/项目操作等组合式函数
│   ├── services/bridge.ts        宿主 API 统一出口
│   ├── types/godot.ts            领域模型与文档 ID 约定
│   ├── types/services.ts         window.services 契约(唯一权威,编译器强制两侧一致)
│   └── utils/                    共享工具(格式化/版本兼容/标签分组/头像渐变)
├── src-ztools/                   ZTools 插件目录
│   ├── plugin.json               插件清单(指令、preload、图标、平台)
│   ├── logo.png
│   ├── preload/
│   │   ├── services.js           window.services 门面
│   │   ├── sandbox.d.ts          手写精简沙箱声明(刻意不声明 setImmediate)
│   │   └── lib/                  领域模块:releases/install/templates/exporter/extract/
│   │                             godotExe/projects/launcher/assets/backup/datatransfer/
│   │                             diagnostics + 基础设施 http/store/fsutil/taskqueue
│   └── dist/                     构建产物(git 忽略)
├── docs/                         设计文档(备份/主题/优化计划/GodotHub 集成策划/术语表)
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
| `npm run test:preload:unit` | 版本解析、任务队列、文件工具、HTTP 下载与**断点续传**、引擎安装、**导出模板**、**一键导出**、启动参数拆分、**数据迁移/网络诊断**、services 契约一致性 |
| `npm run test:addons` | 插件/素材来源、安装分流、清单卸载、复制过户（默认 + 沙箱各一遍） |
| `npm run test:renderer` | 渲染层:市场搜索(分页/竞态守卫)/浏览/安装确认层、项目列表、已装操作、备份、纯工具 |

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

## 许可

MIT
