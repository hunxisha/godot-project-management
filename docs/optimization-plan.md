# 项目优化建议

> 分析日期：2026-09-24 · 基线：`1.0.0`
> 方法：graphify 知识图谱（`graphify-out/graph.json`，1,085 节点 / 1,739 边 / 65 社区）
> + 全量行数与调用关系核对。所有结论均带「文件:行号」依据，可逐条复核。

## 0. 数据口径（先声明，避免后续误读）

- **行数 = 文件总行数（含空行）**。注意 PowerShell 的 `Measure-Object -Line` 不计空行，
  用它统计会低约 10%，本文件的数字都不是那个口径。
- 统计范围：`src/` 与 `src-ztools/` 下的 `.vue/.ts/.js/.mjs`，排除 `node_modules` 与 `dist`。
- 图谱指标来自当时快照；代码改动后需 `graphify --update` 再复核。

## 1. 现状量化

| 分区 | 行数 | 文件数 |
|---|---:|---:|
| `src/views`（页面） | 5,419 | 7 |
| `src/components`（组件） | 2,986 | 10 |
| `src/composables`（组合式） | 1,016 | 5 |
| `src/types` | 298 | 1 |
| `src/services` | 81 | 1 |
| `src/utils` | 45 | 1 |
| `src` 根（App / main / env） | 572 | 3 |
| `src/__tests__`（渲染层测试） | 221 | 1 |
| `src-ztools/preload/lib`（领域层） | 3,661 | 13 |
| `src-ztools/preload` 根（services） | 105 | 1 |
| **合计** | **14,404** | **43** |

- 生产代码 **13,059 行 / 38 文件**；测试代码 **1,345 行 / 5 文件**（占比 **9.3%**）。
- `src/views` 一个目录就占 **37.6%**；**12 个生产文件超过 400 行，合计 8,337 行 = 全项目 57.9%**。
- 最大单文件 `src/views/MarketplaceView.vue` **1,147 行**（占全项目 8.0%）。

图谱侧的关键结构信号：

| 指标 | 值 | 说明 |
|---|---|---|
| 节点 / 边 | 1,085 / 1,739 | 65 个社区 |
| 边置信度 | EXTRACTED 1,563 · INFERRED 176 | 10.1% 是模型推断，需人工复核 |
| 度数 ≤1 的节点 | **604** | 弱连接：要么缺文档，要么死代码 |
| 连通分量 | 8 | 主体 1 个 + 7 个孤立文档/配置 |
| 内聚最低社区 | Preload API Surface **0.042**、Marketplace Browse State **0.043**、Projects & Backup State **0.048**、Theme & Picker Components **0.060** | 图谱主动提示「是否该拆」 |
| 跨社区耦合最高对 | Backup Module Core ↔ Backup Task Lifecycle **15 条边** | 唯一超过 10 的一对 |

God Node（连接度最高的抽象）：`Services` 48（`src/env.d.ts:29`）、`useBackups()` 17
（`src/composables/useBackups.ts:39`）、`fmtSize()` 17（`src/utils/format.ts:2`）、
`notify()` 16（`src/services/bridge.ts:55`）、`backupProject()` 15（`backup.js:178`）、
`restoreBackup()` 14（`backup.js:514`）；此外 `getSettings()` 13（`bridge.ts:35`）与
`saveSettings()` 13（`bridge.ts:42`）——**`bridge.ts` 一家占了前十里的三个**。

---

## 2. 问题清单

### P0-1 · 类型检查实际上是关闭的

**证据**
- `tsconfig.json:14` `"strict": false`、`:15` `"noImplicitAny": false`
- `tsconfig.json:18` `"include": ["src"]` —— `src-ztools/preload/`（**3,661 + 105 = 3,766 行 / 14 文件**）
  完全不在检查范围内

**影响**
preload 层是全部文件系统、网络、子进程操作的所在地 —— 恰恰是风险最高的一层，
却既没有 `strict`，也没有 `checkJs`。渲染层开了 47 个服务方法却只有手写签名（见 P0-2），
两层之间没有任何编译期契约。

**建议**
1. 新增 `tsconfig.preload.json`：`extends` 主配置，`allowJs: true` + `checkJs: true` +
   `module: "CommonJS"` + `moduleResolution: "node"`，`include: ["src-ztools/preload"]`。
2. `package.json` 加 `"typecheck": "vue-tsc --noEmit && tsc -p tsconfig.preload.json"`，
   并让 `build` 依赖它。
3. **分三步开闸，不要一次全开**：`noImplicitAny` → `strictNullChecks` → `strict`。
   先做 `noImplicitAny`：暴露的多是缺 JSDoc 的形参，改动机械、风险低。

### P0-2 · `Services` 类型面手工双写（当前 47 : 47，但无护栏）

**证据**
- `src-ztools/preload/services.js`（105 行）导出 **47** 个键，每个都是
  `(args) => domain.fn(args)` 形式的透传。
- `src/env.d.ts:29`–`:210` 手写 `interface Services`，**47** 个方法签名，
  每条都带中文注释与 `import('./types/godot')` 内联类型。
- 两边**当前完全一致**（47 / 47）—— 这不是现存 bug，而是**没有任何机制阻止它漂移**。
- 而 `Services` 是整个图谱连接度最高的节点（48 条边），一旦漂移，
  影响面覆盖全部 7 个页面与 10 个组件。

**建议（两步走）**
1. **低成本先做**：新增 `src-ztools/preload/lib/__tests__/services.test.js`，
   `require('../services.js')` 取键集合，与一份显式维护的清单比对。
   这把「两处手写」变成「一处代码 + 一份清单 + 一个断言」——
   故意删/加一个键，测试立刻失败。改动量约 60 行。
2. **彻底方案（可选）**：给 `services.js` 补 JSDoc `@typedef`，用
   `tsc --allowJs --declaration --emitDeclarationOnly` 生成 `services.d.ts`，
   渲染层引用生成物，删除 `env.d.ts` 中手写的 47 条。
   代价：要给 47 个方法补 JSDoc，并处理 CommonJS → ESM 的声明产物引用。

### P0-3 · 重复实现（两处，性质不同）

**(a) 逐字重复：`displayName(tag)`**

`src-ztools/preload/lib/releases.js:18` 与 `src-ztools/preload/lib/install.js:43`
的函数体逐字相同（已做逐行比对，忽略缩进后完全一致）：

```js
function displayName(tag) {
  const idx = tag.indexOf('-')
  if (idx < 0) return tag
  const ver = tag.slice(0, idx)
  const channel = tag.slice(idx + 1)
  return `${ver} ${channel.charAt(0).toUpperCase()}${channel.slice(1)}`
}
```

**建议**：放进 `src-ztools/preload/lib/godotExe.js` —— 它已经有
`parseVersionOutput` 与 `parseTagFromFileName`，同属「版本字符串处理」域，
零新文件；两处改为 require 引用。

**(b) 语义漂移的重复：版本归一化** ⚠️ 比 (a) 更值得处理

```js
// src/components/dialogs/VersionPickerDialog.vue:44
function norm(v?: string) { return String(v || '').trim().replace(/^v/i, '') }

// src/views/MarketplaceView.vue:417
function fmtVer(v?: string): string { return (v || '').replace(/^v+/i, '') }
```

两者**行为不同**：一个做 `trim` 一个不做；一个只剥一个前导 `v`（`/^v/i`），
一个剥连续的多个 `v`（`/^v+/i`）。同一个「显示版本号」语义有两份不一致实现 ——
输入 `" V4.3"` 时结果不同。这是潜在的不一致，不只是冗余。

**建议**：统一到 `src/utils/format.ts`（已有 `fmtSize` / `formatTime` /
`formatRelative` / `fmtDuration`，是本项目既定的格式化层；`fmtSize` 早前已用同样方式
统一过一次，有先例）。同时补一条断言把行为锁死，例如
`normVersion(' v4.3') === '4.3'`、`normVersion('vv4.3') === '4.3'` ——
先定行为，再改调用点。

### P1-1 · 视图层过肥，单文件承载多个互不相干的领域

**证据**
- `src/views` 5,419 行 = 全项目 37.6%；7 个页面中 6 个超过 500 行。
- `src/views/MarketplaceView.vue` **1,147 行**，图谱度数 **81（全图最高）**，
  挂 **45 个弱连接节点**。展开后是四套独立状态挤在一个文件里：

  | 领域 | 主要成员（行号） |
  |---|---|
  | 搜索 | `query` / `results` / `searching` / `hasSearched` / `search()`(421) / `onSearchEnter()` |
  | 浏览与分页池 | `mode` / `all` / `featured` / `fresh` / `recent` / `pageNum` / `poolFetched` / `loadBrowse()`(223) / `fillPool()`(183) / `resetPool()` / `changePage()` |
  | 兼容判定 | `verNum()`(62) / `compatOf()`(70) / `godotRange()` / `inGroup()` |
  | 安装 | `target` / `install()`(456) / `installFromPicker()` / `percent()` / `reloadAddons()` |

**建议**
抽三个组合式函数：`useMarketBrowse.ts`、`useMarketSearch.ts`、`useMarketInstall.ts`，
`.vue` 只保留模板与装配。**项目已有现成范式**（`useBackups.ts`、`useTheme.ts`、
`useProjectActions.ts`），照搬即可，不需要新架构。目标 `MarketplaceView.vue < 450 行`。
同法依次处理 `AddonsView.vue` 875、`BackupsView.vue` 828、`ProjectsView.vue` 792。

### P1-2 · preload 层有两套一模一样的任务生命周期

**证据** —— 同一形态被实现了两遍：

| 职责 | `install.js`（下载队列） | `backup.js`（备份/恢复） |
|---|---|---|
| 任务注册表 | `registry = new Map()` :11 | `tasks = new Map()` :40 |
| 监听器集合 | `listeners = new Set()` :12 | `listeners = new Set()` :43 |
| 快照广播 | `emit()` :14 | `emit()` :55 |
| 写入 / 更新 | `setTask(id, patch)` :19 | `newTask()` :76 / `patchTask()` :93 / `finishTask()` :98 |
| 取消 | `cancelTask()` :155 | `cancelBackupTask()` :109 |
| 关闭 | `dismissTask()` :167 | `dismissBackupTask()` :122 |
| 订阅 | `watchTasks()` :173 | `watchBackupTasks()` :68 |
| 各自特有 | 串行队列 `queue` :27 / `running` :28 / `pump()` :30 | 终态集合 `TERMINAL` :35 / 取消令牌 `cancelTokens` :42 |

这正是图谱里跨社区耦合最高的一对（**15 条边**）。两个 API 集合在
`services.js` 里还分别暴露成 `cancelTask/dismissTask/watchTasks` 与
`cancelBackupTask/dismissBackupTask/watchBackupTasks` —— 六个近义方法名。

**建议**
新增 `src-ztools/preload/lib/taskqueue.js`，导出
`createTaskRegistry({ serial: boolean })`，提供
`add / patch / finish / list / watch / cancel / dismiss` 与取消令牌；
`install.js` 传 `serial: true`（保留现有队列语义），`backup.js` 传 `false`。

**收益**：`backup.js` 前 130 行非领域代码搬走（644 → 约 510 行），
取消 / 订阅 / 终态语义只维护一份，六个近义方法名收敛成三个。

### P1-3 · 三个对话框共用同一骨架

**证据**：`BackupCreateDialog.vue` 621 + `RestoreDialog.vue` 654 + `PruneDialog.vue` 336
= **1,611 行**；三者都含「订阅任务快照 → 显示进度 → 取消 → 关闭」骨架，
`BackupCreateDialog` 与 `RestoreDialog` 还各自实现了同一套目标项目选择
（图谱里 `ProjectRow` 同名类型出现在 3 个文件中）。

**建议**：抽 `src/composables/useTaskDialog.ts`（订阅 + 进度 + 取消 + 关闭）
与 `src/components/dialogs/ProjectTargetPicker.vue`。

### P2-1 · 测试覆盖有明确盲区

**证据**：测试 1,345 行 / 5 文件（占 9.3%）。逐文件核对 `require` 列表后，
被测试真正加载的 preload 模块只有 `assets.js`、`projects.js`、`backup.js`、
`extract.js`（仅 `readZipEntries`）、`store.js`（仅 `listDocs`）。

**完全没有任何测试触达**：

| 模块 | 行数 | 内容 |
|---|---:|---|
| `http.js` | 200 | 代理选择、重试、TLS 环境变量 |
| `install.js` | 237 | 下载队列、取消、导入本地 exe |
| `releases.js` | 122 | Godot 官方 release feed 解析 |
| `godotExe.js` | 106 | 版本号解析、可执行文件校验 |
| `launcher.js` | 38 | 启动项目 |

`fsutil.js`（287 行，取消令牌 + 分片让出 + 原子写入）仅经 `backup.js` 间接覆盖。

**建议（按性价比排序）**
1. `godotExe.js` 的 `parseVersionOutput` / `parseTagFromFileName` 是纯函数 ——
   最容易补，且直接锁住版本解析行为（改错这里会让所有已装版本识别失效）。
2. `http.js` 的代理选择与重试 —— 风险最高、最难排查，用注入假 https 模块的方式测。
3. `fsutil.js` 的 `yieldToLoop` 降级链已有 `--no-immediate` 沙箱开关，
   可以复用同一机制补直接断言。

### P2-2 · 没有 CI，也没有 lint

**证据**：仓库无 `.github`；无 ESLint / Prettier 配置。README 记录的 508 项断言，
目前**只能靠手动 `npm test` 守着** —— 提交前忘记跑，回归就静默进仓库。

**建议**
1. 最小 CI：node 20，`npm ci && npm run typecheck && npm run build && npm test`。
2. 若暂不上 CI，至少加 `"verify": "npm run typecheck && npm test"`，
   让「验证」变成一条命令而不是五条。

### P2-3 · 文档术语漂移（图谱直接抽出来的）

图谱识别出 5 组「同一机制、两种表述」的语义相似边，全部跨
`CHANGELOG.md` / `README.md` / `docs/backup-redesign-plan.md`：

| 机制 | 表述 A | 表述 B |
|---|---|---|
| 恢复向导 | 三步恢复向导 | 三步恢复向导（选择方式 → 确认影响 → 执行） |
| 来源过户 | 来源记录过户到目标项目 | 复制插件到其他项目时保留市场来源 |
| 分片让出 | 长任务不冻结界面：分片让出事件循环 | 同步 fs + 分片让出事件循环 |
| 原子落盘 | 原子落盘：先写临时产物再改名 | 先写 `.gpm-tmp-*` 再原子改名 |
| 保留策略 | 保留策略清理（最近 N 份 / 早于 M 天） | 保留策略（每项目保留最近 N 份 / 删除早于 M 天） |

**建议**：在 README 立一节术语表（或新建 `docs/glossary.md`），
每组定一个正名，其余位置统一引用。成本极低，收益是检索与沟通成本。

### P2-4 · 两处「文档已自认、但代码与测试都没管」的既有取舍

**(a) 主按钮对比度** —— `docs/theme-system.md:73-77` 自承
`.btn.primary` 白字压在 `--brand-grad` 渐变上，亮端对比度只有 **2.82**（最低 2.65），
低于文档自定的门槛，**连修法都写好了**（各色板亮端压深约 8%）。

现状是「文档写了、测试没管、代码没改」的三不管状态 —— 下次还会被人当成新 bug 重新发现。
二选一：**要么修**（改一行色板值 + 重跑 `test:theme`）；
**要么把该例外显式写进 `theme.test.mjs` 的豁免清单**并在文档标注「有意保留」。

**(b) 回归测试污染用户回收站** —— `src-ztools/preload/lib/__tests__/README.md:66-70`
记录：`backup.test.js` 有一条断言会验证「删除备份 → 移入回收站」真实链路，
因此**每次运行都在 Windows 回收站留下一个临时文件**（位于 `os.tmpdir()` 下的
`gpm-backup-test-*`，不污染仓库）。

**建议**：给该断言加环境开关（默认跳过，`GPM_TEST_TRASH=1` 时开启），
让 `npm test` 恢复幂等。

---

## 3. 分阶段实施

**排序原则**：先做「不改行为、且能被测试锁住」的收敛，再做结构性抽取；
类型闸门放最后，因为它会一次性暴露大量既有问题，需要有测试护栏才推得动。

### 阶段 1 · 半天，零行为变更

- P0-3(a) 统一 `displayName()` 到 `godotExe.js`
- P0-3(b) 统一版本归一化到 `utils/format.ts`，先补行为断言再改调用点
- P0-2 第一步：新增 services 键比对断言测试
- P2-4(b) 给回收站断言加开关，恢复测试幂等
- P2-2 第二步：`package.json` 加 `verify` 脚本
- 验收：`npm run verify` 通过，断言数不减少

### 阶段 2 · 1–2 天，结构性抽取

- P1-2 抽 `taskqueue.js`（**先确认 backup.test.js 对任务 API 的断言覆盖面**，
  把它当重构护栏）
- P1-3 抽 `useTaskDialog.ts` + `ProjectTargetPicker.vue`
- 验收：`npm test` 全绿，`services.js` 对外 API 不变

### 阶段 3 · 2–3 天，视图拆分

- P1-1 先拆 `MarketplaceView.vue`（1,147 → 目标 < 450）
- 同法推进 `AddonsView.vue` / `BackupsView.vue` / `ProjectsView.vue`
- 验收：无生产文件超过 700 行；页面功能与交互零变化（人工过一遍 7 个页面）

### 阶段 4 · 持续

- P0-1 类型闸门分步开启（`noImplicitAny` → `strictNullChecks` → `strict`）
- P2-1 测试补口（`godotExe.js` → `http.js` → `fsutil.js`）
- P2-2 第一步：接入最小 CI
- P0-2 第二步（可选）：由 JSDoc 生成 `services.d.ts`
- P2-3 术语表

---

## 4. 验收清单

- [ ] `npm run verify` 一条命令跑通 typecheck + test
- [ ] services 键比对断言就位：**故意从 `services.js` 删一个键会失败**
- [ ] `displayName` 全仓只剩一份定义；版本归一化只剩一份且行为有断言锁定
- [ ] `tsconfig.json` 的 `strict: false` 至少推进到 `noImplicitAny: true`，且 preload 纳入检查
- [ ] `install.js` 与 `backup.js` 的「取消 / 关闭 / 订阅」由同一模块提供
- [ ] `MarketplaceView.vue` < 450 行；无生产文件超过 700 行
- [ ] `npm test` 不再写用户回收站
- [ ] CI 在每次提交上跑 `build` + `test`
- [ ] 5 组术语各只有一个正名

## 5. 明确不做（避免范围蔓延）

- **不引入测试框架**。项目刻意保持「零依赖 + Node 直接跑」，现有断言足够；
  除非上 CI 后确实需要并行与进程隔离。
- **不引入状态管理库**。三个组合式函数已覆盖现有需求，拆分视图用组合式函数即可。
- **不动备份数据模型与 `SCHEMA = 2` 的向后兼容约定**。
  `docs/backup-redesign-plan.md` 第 10 节已把「不做破坏性迁移」定为原则。
- **不为拆而拆**。`src/types/godot.ts`（298 行）、`src/services/bridge.ts`（81 行）
  虽然连接度高，但它们是**刻意设计的单一出口**，职责清晰，不应拆分。

## 6. 分析可复现性

```bash
# 1) 图谱查询（先按图的真实词表对齐，再遍历）
graphify query "orphan isolated uncovered cycle dependencies modules cache yield sandbox services strict test"

# 2) 图谱结构指标（度数、内聚、跨社区耦合、INFERRED 集中度）
graphify reflect --if-stale
cat graphify-out/reflections/LESSONS.md

# 3) 行数统计 —— 按真实总行数
#    推荐：Python 读文件数行（\n 切分后去掉末尾空段）
#    避免: PowerShell 的 (Get-Content f | Measure-Object -Line).Lines  ← 不计空行，会低约 10%
python -c "
from pathlib import Path
for p in sorted(Path('src').rglob('*')) + sorted(Path('src-ztools').rglob('*')):
    if p.suffix in {'.vue','.ts','.js','.mjs'} and 'node_modules' not in str(p):
        t = p.read_text(encoding='utf-8').split('\n')
        print(len(t) - (1 if t and t[-1] == '' else 0), p)
"
```

图谱产物位于 `graphify-out/`（已 gitignore）：`graph.html` 可交互浏览，
`GRAPH_REPORT.md` 是审计报告，`graph.json` 是原始数据。
代码改动后跑 `graphify --update` 增量刷新，本文件的数字需同步复核。

## 7. 实施进度

_（每完成一项在阶段小节内标注 commit，与 `docs/backup-redesign-plan.md` 第 14 节同样的记录方式。）_

| 阶段 | 状态 |
|---|---|
| 阶段 1 · 收敛与护栏 | ⬜ 未开始 |
| 阶段 2 · 结构性抽取 | ⬜ 未开始 |
| 阶段 3 · 视图拆分 | ⬜ 未开始 |
| 阶段 4 · 类型闸门 / 测试 / CI | ⬜ 未开始 |
