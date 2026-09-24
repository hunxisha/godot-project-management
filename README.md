# Godot 项目管理

> 下载并管理 Godot 引擎版本、隔离并快捷打开不同版本的项目、浏览安装 Godot 插件、为项目做完整备份。

ZTools 插件。渲染层为 **Vue 3 + Vite + TypeScript**，Node 能力由 **preload 层**（CommonJS）注入，
两者之间只通过 `window.services`（预加载能力）与 `window.ztools`（宿主 API）两个全局对象通信。

支持平台：Windows / macOS / Linux。

## 功能

界面分 7 个页面（顶栏标签 + 主题切换按钮）：

| 页面 | 内容 |
|---|---|
| **概览** | 项目与引擎统计、收藏项目快捷入口、默认引擎 |
| **项目** | 添加/新建/删除项目、绑定引擎版本、拖入 `project.godot` 或项目文件夹、版本不匹配提醒、收藏、**创建备份** |
| **版本** | 从 GitHub 拉取引擎版本列表（24h 缓存）、队列式下载安装、解压校验、导入本地引擎、删除已装版本 |
| **市场** | 官方 Asset Store 浏览（热门/推荐/新品/最近更新/收藏 + 标签筛选 + 分页）、按版本安装、支持安装任意历史 release |
| **已安装** | 列出项目 `addons/` 下的插件、启用/禁用、卸载、从历史版本替换、插件名跳转资产库、批量操作、复制到其他项目（**保留市场来源**） |
| **备份** | 全部项目备份的集中管理：统计、搜索、筛选、按项目分组 / 时间轴、批量删除、备注、完整性校验、保留策略清理、三步恢复向导 |
| **设置** | 主题（5 色板 × 明暗）、引擎目录、网络代理、Asset Store 账号、默认打开动作、删除项目行为、备份默认项 |

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
  `godot/settings`、`godot/version/*`、`godot/project/*`、`godot/asset/*`、`godot/backup/*`。

## 目录结构

```
├── src/                          渲染层(Vue 3 + TypeScript)
│   ├── main.ts                   入口 + 环境守卫(缺少宿主 API 时给出可执行提示)
│   ├── App.vue                   标签路由、KeepAlive、全局任务栏
│   ├── main.css                  设计令牌与 10 套主题
│   ├── views/                    7 个页面
│   ├── components/               通用组件与 dialogs/ 下的 4 个对话框
│   ├── composables/              useBackups(备份状态) / useTheme(主题) / useProjectActions
│   ├── services/bridge.ts        宿主 API 统一出口
│   ├── types/godot.ts            领域模型与文档 ID 约定
│   └── utils/format.ts           共享格式化
├── src-ztools/                   ZTools 插件目录
│   ├── plugin.json               插件清单(指令、preload、图标、平台)
│   ├── logo.png
│   ├── preload/
│   │   ├── services.js           window.services 门面
│   │   └── lib/                  领域模块:releases/install/extract/godotExe/projects/
│   │                             launcher/assets/backup + 基础设施 http/store/fsutil
│   └── dist/                     构建产物(git 忽略)
├── src-ztools/preload/lib/__tests__/   preload 回归测试
├── src/composables/__tests__/          组合式函数回归测试 + .ts 打包脚本
├── src/__tests__/                      主题与格式化回归测试
│   ├── backup-redesign-plan.md    备份功能的设计与实施计划
│   ├── theme-system.md            主题（色板 × 明暗）系统说明
│   └── glossary.md                术语表（正名 + 实现入口）
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
npm test           # 全部 1235 项断言（其中 2 项默认跳过，见下）
```

| 命令 | 覆盖 | 断言 |
|---|---|---|
| `npm run typecheck` | `vue-tsc --noEmit` 类型检查 | — |
| `npm run test:theme` | 主题令牌完整性、设计约束、10 种组合的 WCAG 对比度 | 134 |
| `npm run test:preload` | 备份领域层：创建/查询/校验/恢复/取消/清理/删除 | 101（+1 跳过） |
| `npm run test:preload:sandbox` | 同上，但先删掉 `setImmediate` 以模拟宿主沙箱 | 101（+1 跳过） |
| `npm run test:preload:unit` | 版本串解析/展示名/平台标识、任务队列语义、文件系统工具与分片让出降级链、HTTP 下载与代理、下载安装编排、`window.services` 与类型契约的逐项一致性 | 230 |
| `npm run test:addons` | 插件来源解析与复制过户（默认 + 沙箱各一遍） | 40 ×2 |
| `npm run test:renderer` | 渲染层:纯工具(版本兼容/标签分组/头像渐变/格式化)、备份与恢复对话框骨架、市场搜索/浏览/安装、项目列表与新建删除、插件多选/批量/更新/切版本、备份页删除确认与批量备份 | 589 |

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
- 网络：版本列表走 GitHub，插件市场走 store.godotengine.org，均可通过设置中的 HTTP 代理转发

## 许可

MIT
