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
- 同类缺陷一并收敛：`currentPlatform()`（`releases.js`）与 `platformOfProcess()`（`install.js`）
  是同一段平台映射的两份实现，同时统一到 `godotExe.js`
- P0-2 第一步：新增 services 键比对断言测试
- P2-4(b) 给回收站断言加开关，恢复测试幂等
- P2-2 第二步：`package.json` 加 `verify` 脚本
- 验收：`npm run verify` 通过，断言数不减少

### 阶段 2 · 1–2 天，结构性抽取

- P1-2 抽 `taskqueue.js`（**先确认 backup.test.js 对任务 API 的断言覆盖面**，
  把它当重构护栏）
- P1-3 抽 `useTaskDialog.ts` + `ProjectTargetPicker.vue`
- 验收：`npm test` 全绿，`services.js` 对外 API 不变

> **实施时对计划的两处更正**（读代码后发现原判断不准确，已按代码实际结构调整）：
>
> 1. **`ProjectTargetPicker.vue` 不抽**。原判断来自图谱里 `ProjectRow` 同名类型出现在 3 个文件中，
>    但读代码后确认：项目 `<select>` 只存在于 `BackupCreateDialog.vue:257`，
>    `RestoreDialog.vue` 只声明了 `ProjectRow` 类型、并没有实现选择器（它通过 `project` / `record`
>    prop 拿到目标）。**只有一个消费者**，抽组件属于过度设计，故不做。
> 2. **`PruneDialog.vue` 不参与抽取**。它**没有任务订阅**（无 `watchBackupTasks` / `activeTask` /
>    `canCancel`），只共用 `emit('close')` / `emit('done')` 两行样板，抽出来收益为负。
>    实际参与骨架抽取的是 `BackupCreateDialog.vue` 与 `RestoreDialog.vue` 两个对话框。
>
> 这两条也说明：图谱的「同名类型 / 同社区」信号适合**定位**重复，但落手前必须回代码确认消费者数量。

### 阶段 3 · 2–3 天，视图拆分

- P1-1 先拆 `MarketplaceView.vue`（1,147 → 目标 < 450）
- 同法推进 `AddonsView.vue` / `BackupsView.vue` / `ProjectsView.vue`
- 验收：无生产文件超过 700 行；页面功能与交互零变化（人工过一遍 7 个页面）

> **实施时对验收口径的更正**：原写「`MarketplaceView.vue` < 450 行」是按**整个 SFC** 定的，
> 但这个文件的 431 行是 `scoped` 样式 —— 拆脚本不会减少样式行数，该目标不可达。
> Vue 单文件组件的样式块本来就应该随组件走，所以**改用脚本行数作为口径**：
> `MarketplaceView` 脚本 506 → 172 行（总行数 1,142 → 808）。

### 阶段 4 · 持续

- P0-1 类型闸门分步开启（`noImplicitAny` → `strictNullChecks` → `strict`）
- P2-1 测试补口（`godotExe.js` → `http.js` → `fsutil.js`）
- P2-2 第一步：接入最小 CI
- P0-2 第二步（可选）：由 JSDoc 生成 `services.d.ts`
- P2-3 术语表

> **P0-1 的起点已量化**（新增 `tsconfig.preload.json`，**目标态，故意未接入 `verify`**）。
> 实测 `npx tsc -p tsconfig.preload.json` 报 **390 个错误**：
>
> | 错误码 | 数量 | 含义 | 处理方式 |
> |---|---:|---|---|
> | TS7006 | 233 | 参数缺类型注解 | 补 JSDoc，逐模块推进 |
> | TS2307 | 28 | `Cannot find module 'node:*'` | 需要 node 模块声明 |
> | TS2339 | 24 | 属性不在推断类型上 | 多为 JSDoc 补全后可解 |
> | TS7005 | 22 | 变量隐式 `any[]` | 同上 |
> | TS7031 | 19 | 解构参数隐式 any | 同上 |
> | TS2580 | 18 | `Cannot find name 'process'` | 需要 node 类型 |
> | TS7034 | 14 | 变量隐式 any | 同上 |
> | TS7053 | 12 | 字符串索引隐式 any | 同上 |
> | TS2304 | 2 | `Cannot find name 'setImmediate'` | **故意保留**（见下） |
> | TS7008/2322/7011/7023/1064/2345/2353 | 18 | 结构性错误 | 逐个人工确认 |
>
> **关键发现（已写进 `tsconfig.preload.json` 的注释）：不要直接 `npm i -D @types/node` 了事。**
> `@types/node` 会把 `setImmediate` 声明为合法全局，而 ZTools 沙箱里**没有**它 ——
> 这正是 `docs/backup-redesign-plan.md` §15 记录过、并已用 `--no-immediate` 测试守住的那个坑。
> 引入 node 类型会让类型检查**不再能提醒**这件事，等于把那条教训撤销。
> 因此推进顺序定为：先修「不引入 node 类型也能修」的 300 余项（纯补 JSDoc），
> 再单独决策 node 类型的引入方式；`fsutil.js` 里那 2 处 `setImmediate` 应当用
> `@ts-expect-error Node 专有全局,沙箱内不保证存在` 显式标注，而不是让它变「合法」。

---

## 4. 验收清单

- [x] `npm run verify` 一条命令跑通 typecheck + test
- [x] services 键比对断言就位：**故意从 `services.js` 删一个键会失败**（已用探针验证）
- [x] `displayName` 全仓只剩一份定义；版本归一化只剩一份且行为有断言锁定
- [ ] `tsconfig.json` 的 `strict: false` 至少推进到 `noImplicitAny: true`，且 preload 纳入检查
- [x] `install.js` 与 `backup.js` 的「取消 / 关闭 / 订阅」由同一模块提供（`taskqueue.js`）
- [x] 无生产文件脚本超过 300 行；`MarketplaceView.vue` 脚本 172 行（口径已按 SFC 样式块实际占比更正）
- [x] `npm test` 不再写用户回收站（默认跳过，`GPM_TEST_TRASH=1` 可显式开启）
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
| 阶段 1 · 收敛与护栏 | ✅ 已完成（commit `dfb1af1`，记录 `e04335d`） |
| 阶段 2 · 结构性抽取 | ✅ 已完成（commit `0a0d6ce`，记录 `964c0d8`） |
| 阶段 3 · 视图拆分 | ✅ 已完成（第一批：`MarketplaceView`，commit `14587b6`；第二批：其余三个视图） |
| 阶段 4 · 类型闸门 / 测试 / CI | ⬜ 未开始 |

### 阶段 1 实施记录（commit `dfb1af1`）

| 计划项 | 实际做法 |
|---|---|
| P0-3(a) 统一 `displayName()` | 移入 `lib/godotExe.js`；`install.js` 与 `releases.js` 改为 require。`install.js` 保留对外导出（作为再导出），模块对外 API 未变 |
| P0-3(b) 统一版本归一化 | 新增 `normVersion()` 于 `src/utils/format.ts`，语义取**两者行为的并集**（trim + 去掉连续多个前缀 `v`）；`VersionPickerDialog.vue` 与 `MarketplaceView.vue` 改为引用共享实现 |
| 额外收敛（同类缺陷） | `currentPlatform()` / `platformOfProcess()` —— 同一段 3 分支平台映射的两份实现 —— 一并统一到 `godotExe.js`；`releases.js` 保留再导出以维持 `services.js` 不变 |
| P0-2 第一步 | 新增 `lib/__tests__/services.test.js`：解析 `env.d.ts` 的 `interface Services`，与 `window.services` 做**双向**集合比对。未采用「手写第三份清单」的方案，因此不需要额外维护 |
| P2-4(b) 测试幂等 | `backup.test.js` 的批量删除改走 `keepRecordOnly`（只移除记录）；「删除 → 移入回收站」这一条默认跳过并打印 `SKIP`，用 `GPM_TEST_TRASH=1` 显式开启 |
| P2-2 第二步 | `package.json` 新增 `typecheck` 与 `verify`（`verify = typecheck && test`） |
| 顺带补口 | 新增 `lib/__tests__/godotExe.test.js`：该模块此前零测试，而本次正是往它里面搬东西 —— 补上版本串解析的行为断言后搬运才可验证（原计划排在阶段 4） |

**验收结果**

| 指标 | 阶段 1 前 | 阶段 1 后 |
|---|---|---|
| `npm run verify` | 不存在 | ✅ exit 0 |
| 断言总数 | 508 PASS | **557 PASS** + 2 SKIP |
| `src/views` / `install.js` / `releases.js` 中的重复实现 | `displayName` ×2、版本归一化 ×2、平台映射 ×2 | 各 1 处，且有测试守卫 |
| `npm test` 是否写用户回收站 | 是（每次 1 个临时文件） | 否（默认跳过） |

- 2 项 SKIP = `test:preload` 与 `test:preload:sandbox` 各跳过 1 项回收站断言；已用 `GPM_TEST_TRASH=1` 验证该链路仍能通过（102 PASS / 0 SKIP），覆盖度没有丢失。
- 去重护栏已验证会**真的失败**：探针 1 从 `services.js` 删一个键 → 2 项 FAIL；探针 2 往 `env.d.ts` 加一个未实现的方法 → 2 项 FAIL（两次均从备份还原，无残留）。

### 阶段 2 实施记录（commit `0a0d6ce`）

| 计划项 | 实际做法 |
|---|---|
| P1-2 抽 `taskqueue.js` | 新增 189 行的 `createTaskQueue(opts)`。两套实现的行为差异被显式化成选项，而不是靠复制粘贴保持：`idPrefix` / `makeId`（install 保留 `dl-<毫秒>-<随机>` 形状）、`sortBy`、`terminalPhases`（backup 有终态、install 无）、`phaseField`、`serial`（install 串行、backup 并发）。`backup.js` 644 → 613 行，`install.js` 227 → 202 行 |
| 统一掉的隐性差异 | 合并时顺带修正三处「两份实现各写各的」：① 快照改为**一律浅拷贝**（install 原先直接暴露内部对象，订阅者能改到内部状态）；② 监听器异常**逐個隔离**（install 原先一个监听器抛错会中断其余监听器）；③ `dismiss` 一并清理取消令牌（原先会留悬挂引用） |
| P1-3 抽 `useTaskDialog.ts` | 150 行组合式函数，覆盖任务订阅、`activeTask`/`canCancel`、`phrase`/`percent`、`begin`/`end`/`report` 生命周期、取消失败提示。阶段文案表合并为一张（两个对话框各自只用其中一部分）。`BackupCreateDialog.vue` 621 → 599 行，`RestoreDialog.vue` 654 → 623 行，`busy` 统一改名 `running` |
| 组件卸载清理 | `onBeforeUnmount(stopWatching)` 移入组合式函数（用 `getCurrentInstance()` 守卫，组件外调用跳过），避免调用方漏写导致订阅泄漏 |
| 补测试（原计划排在阶段 4） | `taskqueue.test.js`（41 项）、`install.test.js`（34 项，`http`/`extract`/`store` 打桩，此前该模块零覆盖）、`useTaskDialog.test.mjs`（51 项，沿用 `build-bundle.mjs` + Node 断言，不引入测试框架） |

**验收结果**

| 指标 | 阶段 2 前 | 阶段 2 后 |
|---|---|---|
| `npm run verify` | ✅ exit 0 | ✅ exit 0 |
| 断言总数 | 557 PASS + 2 SKIP | **683 PASS** + 2 SKIP |
| 任务生命周期实现份数 | 2 套（`install.js` / `backup.js`） | 1 套（`taskqueue.js`） |
| 对话框骨架实现份数 | 2 套（各约 27 行） | 1 套（`useTaskDialog.ts`） |
| `services.js` 对外 API | 47 个方法 | 47 个方法（契约测试通过） |

- 抽取过程被备份测试当场抓住一个真 bug：`finish()` 最初把阶段**值**当成字段**名**写入（`phaseField` 与取值混用同一个访问器），表现为 11 项取消/终态断言失败。这正是 `backup.test.js` 作为重构护栏的价值 —— 若没有它，这个 bug 只会在用户点「取消备份」时暴露。已在 `taskqueue.test.js` 第 5 节加断言锁住该类错误。
- 两个对话框属于**渲染层改动**：`test:taskdialog` 覆盖了抽出去的那部分逻辑，但模板绑定（`:disabled="running"` 等）只有 `vue-tsc` 把关，仍需人工过一遍「新建备份」「恢复向导」两个流程（见「阶段 3 的人工验收」）。

### 阶段 3 实施记录 · 第一批（`MarketplaceView.vue`）

按「哪个接缝是真的」拆，而不是按行数切 —— 拆出 5 个模块 + 2 个纯工具：

| 新模块 | 内容 | 为什么是独立接缝 |
|---|---|---|
| `src/utils/godotVersion.ts` | `verNum` / `projectGodotVersion` / `compatOf` / `godotRange` | 纯函数、零 Vue 依赖；版本换算的边界（`4.10 > 4.4`、未知版本返回 `null` 而非 `false`）最需要断言 |
| `src/utils/marketTags.ts` | `MARKET_TAG_GROUPS` / `tagSlugsOf` / `inGroup` | 同一份标签映射被「聚合拉取」与「展示过滤」共用，放在视图里两边各引一次容易漂移 |
| `src/composables/useAssetHydration.ts` | `hydrateVersions` | 携带一条关键约束：**只请求尚未补齐的资产**（聚合翻屏靠它避免重复请求） |
| `src/composables/useMarketSearch.ts` | 关键词防抖、请求状态、结果 | 自带 ref，无需注入；补全能力由调用方注入以与浏览共用 |
| `src/composables/useMarketBrowse.ts` | 五种模式取数 + 分页 + 标签聚合池 + 展示过滤 | 视图脚本里最大的一块；搜索状态通过参数注入，保持接缝清晰 |
| `src/composables/useMarketInstall.ts` | 安装进度、已装集合、版本选择器 | 唯一会写目标项目目录的操作；进度必须按 `assetId` 配对 |

**验收结果**

| 指标 | 阶段 3 前 | 阶段 3 第一批后 |
|---|---|---|
| `MarketplaceView.vue` 总行数 | 1,142 | **808** |
| `MarketplaceView.vue` **脚本**行数 | 506 | **172** |
| 断言总数 | 683 PASS + 2 SKIP | **850 PASS** + 2 SKIP |
| `npm run verify` | ✅ exit 0 | ✅ exit 0 |

- 测试基建顺带收敛：渲染层测试原本 3 条脚本各自起一次 vite，改为 `test:renderer` **一次打包、7 个测试文件共用**（Rollup 会把 vue 提成共享 chunk，于是新增的 `__tests__/vue-shim.mjs` 能让测试拿到同一份 vue 去创建 ref 并触发 `watch`）。单条脚本（`test:format` / `test:taskdialog` / `test:composable`）保留，便于定位。
- 仍待做：`AddonsView.vue`（脚本 290）/ `BackupsView.vue`（脚本 210）/ `ProjectsView.vue`（脚本 327）用同一套做法拆分。
- **渲染层仍需人工验收**（自动化只覆盖抽出的逻辑，模板绑定由 `vue-tsc` 把关）：插件的**搜索**（输入防抖、回车立即搜、清空回到浏览）、**五种浏览模式**切换、**标签筛选 + 翻页**（聚合池行为）、**兼容开关**、**收藏/取消收藏**、**安装进度**与**版本选择器安装**。

### 阶段 3 实施记录 · 第二批（其余三个视图）

| 视图 | 脚本行数 | 新模块 |
|---|---|---|
| `ProjectsView.vue` | 327 → **241** | `useProjectList`(75) / `useProjectCreate`(105) / `useProjectDelete`(63) |
| `AddonsView.vue` | 290 → **125** | `useAddonSelection`(89) / `useAddonActions`(242) / `useInstallProgress`(65) |
| `BackupsView.vue` | 210 → **163** | `useBackupPageActions`(119) |

七个视图的脚本行数：`ProjectsView` 241 · `VersionsView` 229 · `MarketplaceView` 172 · `BackupsView` 163 · `AddonsView` 125 · `SettingsView` 97 · `Dashboard` 49（**全部 < 300**）。

**过程中又发现并收敛的两处重复**（与阶段 1 同类缺陷）：

1. **`gradOf()`**（项目名 → 头像渐变组）在 `ProjectsView.vue` 与 `Dashboard.vue` 里逐字相同 → 合入 `src/utils/avatar.ts`，并用固定输入的断言钉住哈希（改了会让所有项目头像换色）。
2. **安装进度映射**（`percent` 换算 + 进度回调 → 阶段文案）在**三处**各写一遍（市场安装 / 更新 / 切换版本）→ 合入 `src/composables/useInstallProgress.ts`，`useMarketInstall` 也改为使用它（107 → 86 行）。

**对计划的一处更正**：`BackupsView.vue` 其实**早已按预期拆过** —— 它的列表/筛选/分组/多选/巡检逻辑都在 `useBackups` 里（正是那 90 项断言的来源）。剩下能抽且有判断逻辑的只有「删除确认文案」与「批量备份」两块，按此实施；其余是各对话框的开关状态，抽出来属于churn。

**验收结果**

| 指标 | 阶段 3 前 | 阶段 3 完成后 |
|---|---|---|
| 断言总数 | 683 PASS + 2 SKIP | **1112 PASS** + 2 SKIP |
| 七个视图的脚本行数合计 | 1,714 | **1,076**（−37%） |
| 最大的视图脚本 | `MarketplaceView` 506 | `ProjectsView` 241 |
| `npm run verify` | ✅ exit 0 | ✅ exit 0 |
| 测试文件数 | 12 | 23 |

**渲染层人工验收清单**（自动化覆盖不到的部分，模板绑定只有 `vue-tsc` 把关）：

- 项目页：搜索过滤 / 收藏筛选 / 排序（收藏→最近打开→名称）、新建项目（预填父目录与引擎）、删除确认（`ask`/`always`/`never` 三种设置的默认勾选）、拖拽添加、键盘上下+回车打开
- 插件页：多选与全选、批量启用/禁用、批量卸载（**点两次**）、单个卸载（点两次）、检查更新、更新、切换历史版本、复制到其他项目、商店链接
- 备份页：删除确认文案（文件还在 vs 已丢失）、批量备份未备份项目、恢复向导、备注编辑、巡检
- 市场页：搜索防抖/回车、五种浏览模式、标签筛选后翻页（聚合池）、兼容开关、收藏、安装与版本选择器
- 备份/恢复对话框：进度、取消、替换阶段取消应被拒绝
