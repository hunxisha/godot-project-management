# 备份功能重设计与实施计划

> 目标：把「项目页里的一个备份弹窗」重构为**独立的备份管理体系** —— 新增备份管理页面，
> 重新设计备份创建流程与恢复流程，补齐取消、进度、批量、校验、清理、备注等能力。
>
> 本文档为实施前的评审稿，**尚未改动任何代码**。

---

## 1. 现状诊断

### 1.1 现有实现清单

| 位置 | 内容 |
|---|---|
| `src/views/ProjectsView.vue` L230–357 | 备份全部渲染层逻辑：`openBackup` / `confirmBackup` / `doRestore` / `doDeleteBackup` / `refreshLastBackups` / `fmtSize` / `formatTime` |
| `src/views/ProjectsView.vue` L664–781 | 备份模态框模板：备份设置 + 进度 + 备份历史 + 恢复模式 + 删除 |
| `src/views/ProjectsView.vue` L794–893 | 备份模态框样式 |
| `src/views/ProjectsView.vue` L496–499, 524–530 | 项目行的「最近备份」摘要与备份按钮 |
| `src-ztools/preload/lib/projects.js` L301–489 | `sanitizeName` / `stamp` / `trashPath` / `copyTree` / `backupProject` / `listBackups` / `restoreBackup` / `deleteBackup` |
| `src-ztools/preload/lib/extract.js` L153–238 | `createZip`（同步 deflate，支持 `exclude` 与 `onProgress`） |
| `src-ztools/preload/services.js` L36–43 | 暴露 4 个备份方法 |
| `src/env.d.ts` L65–79 | 4 个备份方法的类型声明 |
| `src/types/godot.ts` L73–87 | `BackupRecord`（8 个字段） |
| `src/views/SettingsView.vue` L23–29, 175–196 | 只暴露一个 `backupRoot`（备份目录） |
| `src/components/TabBar.vue` L4–11 | 6 个标签，**无备份入口** |

### 1.2 问题清单（按严重度）

**P0 · 同步 fs 阻塞整个渲染进程**

`createZip`（L167–237）与 `copyTree`（L349–359）全程使用同步 API（`readFileSync` / `writeSync` /
`copyFileSync`），而 preload 与渲染层同线程 —— 打包期间**事件循环被独占**。后果：

- `onProgress` 每文件都在调用，但 Vue 无法重绘，用户看到的是「点击 → 界面卡死 → 突然跳到完成」，
  **现有进度条在真实项目上等于不可用**。
- 备份进行中渲染进程无法处理任何事件，因此**当前不可能实现取消**（`cancelBackup()` 根本排不进事件循环）。
- 数 GB 项目会让宿主窗口「无响应」。

**P0 · 失败会留下孤儿半成品文件**

`backupProject`（L367–402）直接写入最终路径：
- `createZip` 中途抛错 → `destDir` 里留下一个截断的 `.zip`，且**没有对应记录**，用户既看不到也删不掉。
- `copyTree` 中途抛错 → 留下一个不完整的快照目录，同理。
- `restoreBackup` 的 `overwrite` 分支有回滚（L456–467），但 `new` 分支失败时留下的 `_restore_` 目录不会清理。

**P1 · 模态框职责过载**

一个 480px 宽、`max-height: calc(100vh - 64px)` 的弹窗同时承担：备份参数配置、进度展示、
本项目备份历史、恢复模式选择、逐条恢复/删除。历史列表被压到 `max-height: 210px` 的二级滚动区（L844–850），
备份一多就只能在弹窗里翻小格子。

**P1 · 没有全局备份管理**

`listBackups()` 本身支持不传 `projectId` 返回全部（projects.js L405–410），但 UI 从未这样用 ——
只把全量结果折叠成「每个项目最近一份」（L250–257）。用户无法回答：
「我一共占了多少备份空间？」「哪些备份的文件已经丢了？」「哪个项目还没有备份？」

**P1 · 破坏性操作用「两击确认」，状态易残留**

`doRestore`（L303–329）覆盖恢复靠 `pendingRestore` 二次点击确认，`doDeleteBackup`（L331–345）同理。
两个 `ref` 在切换项目、切换恢复模式、关闭弹窗时清理路径不完整（只在 `openBackup` 与模式切换时清），
存在「点了删除、误点别处、回来再点一次就真删了」的窗口。覆盖整个项目目录是最高危操作，
需要**独立确认弹窗 + 明确列出将被替换的路径**，而不是按钮文案变化。

**P2 · 备份只增不减**

没有任何容量统计、批量删除、保留策略。`deleteBackup` 只能一条一条删（L477–489）。

**P2 · 记录信息太贫瘠**

`BackupRecord` 只有 `mode / destPath / size / fileCount / createdAt / missing`。
- 无**备注/名称** —— 无法标记「发布前」「v1.0 通过审核」。
- 无**来源快照** —— 不知道备份时项目绑定的引擎版本、`config_version`。
- 无**有效性** —— `missing` 只判断路径是否存在，不判断内容是否可用（zip 是否完整、是否含 `project.godot`）。
- **备份名不可控** —— 强制 `{项目名}_{YYYYMMDD_HHmm}.zip`（L379），同分钟二次备份会**直接覆盖同名文件**。

**P2 · `listBackups` 每条都 `existsSync`**

L409 对每条记录做一次同步磁盘探测。`ProjectsView` 挂载时（L53）无条件调用一次全量。
备份记录上百后，每次进项目页都会同步卡一下。

**P2 · 恢复没有进度**

`restoreBackup` 调用 `copyTree(srcDir, target, true)`（L444 / L459）时**没有传 `onProgress`** ——
而 `copyTree` 支持。加上同步阻塞，覆盖恢复大项目同样是「假死」。

**P3 · 设置项太少**

只有 `backupRoot`。默认模式、是否含 `.godot` 缓存、压缩级别、保留策略都只能在每次备份时手选。
`sessionBackupDir`（L242）是模块级 `let`，重启即丢，且备份弹窗里改选的目录**不写回设置**。

**P3 · 格式化函数重复**

`fmtSize` / `formatTime` / `formatLastOpened` 都私有在 `ProjectsView.vue` 内（L347–387），
新页面要用就得复制一份。

---

## 2. 设计目标与原则

1. **备份是一等公民**：与「项目」「版本」「插件」并列，拥有独立标签页与完整生命周期管理。
2. **创建与恢复/管理分离**：项目页只负责「给这个项目做一次备份」；历史、恢复、清理全部归备份页。
3. **长任务必须可见、可取消、不冻界面**：这是本次改造的地基，先修 P0 再谈 UI。
4. **破坏性操作分级**：覆盖恢复 > 批量删除 > 单条删除，各自匹配不同强度的确认，不用「两击」这种弱确认。
5. **向后兼容**：老备份记录（无新字段）必须能正常列出、恢复、删除，不做破坏性迁移。
6. **失败不留痕**：任何中断/失败的备份都不产生孤儿文件，也不产生脏记录。

---

## 3. 信息架构

```
TabBar:  概览 · 项目 · 版本 · 市场 · 已安装 · [备份] · 设置      ← 新增第 7 个标签

项目页 (ProjectsView)                       备份页 (BackupsView · 新增)
├─ 行内 [备份] 按钮 ──→ 新建备份对话框        ├─ 统计头：N 份 · 占用 X · 缺失 M
├─ 行内「备份于 X 前」──→ 备份页(筛选该项目)   ├─ 工具行：搜索 / 筛选 / 排序 / 视图切换 / 批量
└─ 页头 [备份管理] ──→ 备份页                 ├─ 分组视图（按项目折叠）
                                             ├─ 时间轴视图（按日期）
新建备份对话框 (BackupCreateDialog)           └─ 空状态（列出尚无备份的项目）
└─ 项目 / 备注 / 模式 / 级别 / 位置 / 高级 / 预估 / 进度 / 取消

恢复向导 (RestoreDialog)                    确认弹窗 (ConfirmDialog · 通用)
└─ 步骤1 选择方式 → 步骤2 确认影响 → 步骤3 执行  └─ 单条删除 / 批量删除 / 清理策略
```

---

## 4. 交互流程设计

### 4.1 新建备份流程

```
[项目页行内「备份」]  或  [备份页「新建备份」]
        │
        ├─ 项目页进入：项目已锁定，不可切换
        └─ 备份页进入：下拉选择项目（含「全部项目」批量备份 ← 可选，见阶段 4）
        │
   ① 基本信息
      · 备注名  [默认: {项目名} {YYYY-MM-DD HH:mm}]   可空
      · 模式    ( ) zip 打包   ( ) 完整快照           卡片二选一，带说明
      · 压缩级别（仅 zip） 快速 L1 / 标准 L6 / 最大 L9  显示预估耗时
   ② 保存位置
      · 目录输入 + [浏览]；标注来源（来自设置 / 本次临时）
      · [ ] 设为默认备份目录（写回 settings.backupRoot）
   ③ 高级选项（折叠）
      · [ ] 包含 .godot 编辑器缓存
      · [ ] 排除 .git 目录
      · [ ] 排除 export/ 与 build/ 产物目录
      · 预估：源目录 ≈ 1.2 GB / 4,318 文件（新增 estimateBackup）
   ④ 执行
      · 进度：阶段(扫描 → 打包/复制 → 写入记录) + 百分比 + 已处理/总数 + 字节 + 当前文件
      · [取消]  ← 立即可用（阶段 0 的地基保证）
   ⑤ 结果
      · 成功：大小 / 文件数 / 耗时 / 最终路径 + [打开所在位置] [查看备份]
      · 失败：错误原因 + 自动清理说明（「未保留任何不完整文件」）
      · 取消：明确提示「已取消，未产生文件或记录」
```

### 4.2 恢复流程（三步向导）

```
步骤 1 · 选择恢复方式
  (•) 恢复为新项目（推荐，安全）
      · 新项目名   [默认: {原名}_restore_{YYYYMMDD_HHmm}]
      · 保存位置   [默认: 原项目同级目录] + [浏览]
  ( ) 覆盖原项目（危险）
      · 原项目路径：E:\Godot项目\测试
      · 警告卡：该目录将被替换；原目录会先移入回收站（Windows 可恢复，其他平台永久删除）
      · 确认输入：请输入项目名「测试」以继续   ← 替代两击确认

步骤 2 · 确认摘要
  · 备份：{备注名} / {时间} / {模式} / {大小} / {文件数}
  · 来源项目：{projectName}（若该项目已被删除则标红）
  · 备份文件：{destPath}（若缺失则此步直接拦截并说明原因）
  · 目标：{新项目路径 或 原项目路径}
  · [上一步]  [开始恢复]

步骤 3 · 执行
  · 进度：解包(zip 时) → 复制到目标 → 注册项目
  · 覆盖模式额外阶段：原目录移入回收站
  · [取消]（仅在复制阶段可取消；一旦进入「替换原目录」则不可逆，需禁用并说明）
  · 结果：成功 → [打开项目] [查看项目列表]；失败 → 已自动回滚（现有 L456–467 逻辑保留）
```

**取消语义要明确**：覆盖恢复一旦执行过 `renameSync(project.path, oldDir)` 就进入不可撤销区，
计划在此之后禁用取消按钮并给出文案，避免「取消到一半」的中间态。

### 4.3 删除流程

| 场景 | 确认强度 |
|---|---|
| 单条删除 | 通用确认弹窗：显示备注名、时间、大小、路径；说明「Windows 移入回收站，其他平台永久删除」 |
| 批量删除 | 确认弹窗列出 N 份 + 总大小 + 路径清单（可折叠展开，超过 8 条折叠）；需勾选「我了解这些备份文件将被移除」 |
| 缺失记录的清理 | 弱确认：这些文件已不存在，删的只是记录；提供「一键清理全部缺失记录」 |

### 4.4 清理策略（阶段 4，可选）

设置页提供三档，或备份页提供「清理」入口：
- 不自动清理（默认）
- 每个项目保留最近 N 份（N 可填，默认 5）
- 删除早于 M 天的备份

执行前**必须预览**：「将被删除：12 份 · 3.4 GB」+ 清单，确认后才执行。

---

## 5. 页面详细设计

### 5.1 备份页 `BackupsView.vue`（新增）

```
┌ 备份  [14]                      总占用 3.4 GB · 缺失 2 · 项目 5/7        [新建备份] [清理]
├ ─────────────────────────────────────────────────────────────────────────────────
│ [🔍 搜索项目名 / 备注 / 路径]     [全部 14] [zip 9] [快照 5] [缺失 2] [未备份项目 2]
│                                    排序: 时间▾   视图: 分组 | 时间轴   [批量管理]
├ ─────────────────────────────────────────────────────────────────────────────────
│ ▾ 测试                        4 份 · 1.2 GB · 最近 3 小时前
│   ● 发布前测试          zip    2026-09-24 09:12   128 MB · 431 文件   4.8 Dev6  ✓有效
│     E:\Backups\测试_发布前_20260924_0912.zip            [恢复] [位置] [备注] [⋯]
│   ● 自动备份            zip    2026-09-23 21:04    96 MB · 402 文件   4.8 Dev6  ✓有效
│   ⚠ 旧快照              快照   2026-09-20 10:11   410 MB · 1,203 文件  —         ✗缺失
│     E:\Backups\测试_20260920_1011（文件已不存在）        [移除记录]
│ ▸ My Game                     3 份 · 820 MB · 最近 昨天
│ ▸ (已移除的项目)               2 份 · 210 MB   ← projectId 指向的项目已删除，仍可恢复为新项目
└ ─────────────────────────────────────────────────────────────────────────────────
```

要点：
- **统计头**为本页视觉焦点（大号占用空间），不是每个备份一条一块的卡片墙。
- **按项目分组**为默认视图：备份天然属于项目，分组头给出「份数 · 占用 · 最近时间」。
- **时间轴视图**：按「今天 / 昨天 / 本周 / 更早」平铺，适合「我昨天备份了什么」这类检索。
- **孤立备份**（项目已删除）单独成组，不能「覆盖恢复」，只能「恢复为新项目」。
- **缺失态**：整行降透明度、显示 `✗缺失`、禁用恢复、只留「移除记录」。
- 批量管理切换后：每行出现勾选框 + 底部操作条（已选 N 份 · X GB / [批量校验] [批量删除]）。
- 空状态：`EmptyState` 引导创建首份备份，并列出**从未备份过的项目**作为快捷入口。

### 5.2 新建备份对话框 `BackupCreateDialog.vue`（新增）

- 复用现有 `.modal-mask` / `.card.modal` / `.field` / `.f-label` / `.dir-row` / `.seg` / `.open-row` 样式（main.css + ProjectsView 现有写法）。
- 模式选择由 `seg` 升级为**两张可点卡片**（各自带说明与「预估体积/耗时」），因为这是最常见的误选点。
- 进度区复用 main.css 的 `.bar` / `.fill`（L474–526），并启用 `.fill.active` 的斜纹动画。
- 高级选项默认折叠，避免弹窗过高。

### 5.3 恢复向导 `RestoreDialog.vue`（新增）

- 用 `steps` 式三段结构（可复用 `.seg` 做步骤指示，或简单三行标题 + 内容切换）。
- 覆盖模式的确认输入框比对 `project.name`，不匹配则禁用「开始恢复」。
- 备份文件缺失、备份内容无效（zip 无法读出 `project.godot`）在此阶段直接拦截。

### 5.4 项目页改动 `ProjectsView.vue`

| 改动 | 说明 |
|---|---|
| 删除备份模态框（L664–781） | 整体移除 |
| 删除备份样式（L794–893） | 整体移除 |
| 删除脚本（L230–357 的大部分） | 保留的只有 `refreshLastBackups` 的替代（改用新的 `listLatestBackups`） |
| 行内备份按钮（L524–530） | 改为 `emit('backup-project', p._id)` → 打开新建备份对话框 |
| 「备份于 X 前」（L496–499） | 加 `cursor:pointer`，点击 `emit('open-backups', p._id)` 跳备份页并筛选 |
| 页头（L434–445） | 新增 ghost 按钮 `[备份管理]` → `emit('open-backups')` |
| 新增 emit | `(e:'backup-project', id:string)`、`(e:'open-backups', id?:string)` |

预计净减少约 200 行（模板 118 行 + 样式 100 行 + 脚本约 60 行，新增约 40 行）。

### 5.5 设置页改动 `SettingsView.vue`

把「项目备份目录」区（L175–196）扩展为「备份与恢复」区：

| 项 | 控件 | 落库字段 |
|---|---|---|
| 默认备份目录 | 目录选择（现有） | `backupRoot` |
| 默认备份方式 | seg：zip / 快照 | `backupMode` |
| 包含 .godot 缓存 | switch | `backupIncludeCache` |
| zip 压缩级别 | seg：快速 / 标准 / 最大 | `backupLevel` |
| 备份保留策略 | seg：不清理 / 保留最近 N 份 / 早于 M 天 | `backupKeepPerProject` / `backupKeepDays` |
| 删除备份时 | seg：确认弹窗 / 直接（缺省确认弹窗） | `backupDeleteConfirm` |

### 5.6 TabBar 改动 `TabBar.vue`

```ts
{ key: 'backups', label: '备份', icon: 'box' }   // 插在 'addons' 与 'settings' 之间
```

**需实测的风险**：当前 6 个标签 + 品牌区在 922px 宽度下已接近占满（见截图）。
第 7 个标签约需 70px。对策（按优先级）：
1. 优先：给 `.tabs` 加 `overflow-x: auto` + 隐藏滚动条，保证任何宽度下不换行不溢出。
2. 备选：`.tab` 的 `padding` 由 `5px 13px` 收到 `5px 10px`，`gap` 由 5px 收到 4px。
3. 兜底：宿主窗口宽度 < 880px 时隐藏 `.titles` 的品牌副标题（`.sub`）。

**实施第一步就要在真实的 ZTools 宿主窗口里验证**，而不是只看浏览器。

---

## 6. 数据模型变更 `src/types/godot.ts`

```ts
/** 备份记录 schema 版本：1=旧记录（无下列可选字段），2=当前 */
export interface BackupRecord {
  _id: string
  projectId: string
  projectName: string
  mode: 'zip' | 'copy'
  destPath: string
  size: number
  fileCount: number
  createdAt: number
  /** 只读派生：备份文件是否仍存在（listBackups 时计算，不落库） */
  missing?: boolean

  // ---------- 新增（全部可选，保证老记录可读）----------
  /** 用户备注名，如「发布前」；空则 UI 用 `{projectName} {时间}` 兜底 */
  label?: string
  /** 是否包含 .godot 缓存（老记录未知，UI 显示「—」） */
  includeCache?: boolean
  /** zip 压缩级别 1|6|9 */
  level?: 1 | 6 | 9
  /** 备份时项目绑定的引擎版本 tag，如 4.8-dev6 */
  engineVersion?: string
  /** 备份时 project.godot 的 config_version */
  configVersion?: number
  /** 本次备份实际排除的目录名（用于事后解释体积差异） */
  excluded?: string[]
  /** 完整性校验结果（verifyBackup 写入） */
  verified?: boolean
  verifiedAt?: number
  verifyError?: string
  /** 备份耗时（毫秒），用于展示与预估校准 */
  durationMs?: number
  /** 记录结构版本 */
  schema?: number
}

/** 备份汇总，供备份页统计头（preload 侧聚合，避免把全量记录传给渲染层） */
export interface BackupStats {
  count: number
  totalSize: number
  missingCount: number
  /** 有备份的项目数 */
  coveredProjects: number
  totalProjects: number
  byMode: { zip: number, copy: number }
}

/** 进行中的备份任务快照（用于跨页面进度与取消） */
export interface BackupTask {
  id: string
  projectId: string
  projectName: string
  label?: string
  mode: 'zip' | 'copy'
  phase: 'scanning' | 'packing' | 'copying' | 'finalizing' | 'done' | 'error' | 'canceled'
  done: number
  total: number
  bytes: number
  current: string
  startedAt: number
  error?: string
}
```

`GodotSettings` 追加（全部可选）：
```ts
backupMode?: 'zip' | 'copy'
backupIncludeCache?: boolean
backupLevel?: 1 | 6 | 9
backupKeepPerProject?: number
backupKeepDays?: number
backupExcludeGit?: boolean
backupExcludeBuild?: boolean
```

`DOC_ID` 追加：
```ts
backup: (id: string) => `godot/backup/${id}`,
```

**已确认的现存 bug 顺带修复**：`stamp()` 只到分钟（projects.js L311–315），
同一分钟对同一项目重复备份会生成**完全相同的目标路径**（L379）而静默覆盖上一份。
新方案用「临时文件 + 最终名含秒/序号 + 冲突时追加 `_2`」解决。

---

## 7. Preload API 设计

### 7.1 模块拆分

`projects.js` 已 504 行、在图谱中是 god node（38 度），备份逻辑占了近 200 行。本次拆分：

```
src-ztools/preload/lib/
├── fsutil.js      （新增）trashPath / sanitizeName / stamp / uniquePath / copyTree / yieldToLoop / walkDir
├── backup.js      （新增）备份领域：创建 / 列表 / 统计 / 校验 / 备注 / 删除 / 恢复 / 预估 / 任务
├── projects.js    （瘦身）项目 CRUD；removeProject 改用 fsutil.trashPath；不再包含备份
├── extract.js     （改造）createZip 支持 level + 分片让出 + 取消；新增 readZipEntries（校验用）
└── services.js    （改造）组装并暴露新 API
```

依赖方向（**无环**）：
```
services.js → backup.js → projects.js → fsutil.js
                        → extract.js
                        → store.js
```
`projects.js` **不** require `backup.js`；`restoreBackup(mode:'new')` 需要 `addProject`，
由 `backup.js` 单向 require `projects.js` 解决。

### 7.2 新增 / 改造的 API 签名

```ts
// ---------- 创建 ----------
backupProject(
  projectId: string,
  opts: {
    mode: 'zip' | 'copy'
    destDir: string
    includeCache?: boolean
    level?: 1 | 6 | 9          // 新增
    label?: string             // 新增
    exclude?: string[]         // 新增：目录名黑名单，如 ['.git','build']
  },
  onProgress?: (p: {
    phase: 'scanning' | 'packing' | 'copying' | 'finalizing'
    done: number, total: number, current: string, bytes: number
  }) => void
): Promise<BackupRecord>        // 签名兼容，额外字段可选

// ---------- 查询 ----------
listBackups(query?: { projectId?: string, withStatus?: boolean }): BackupRecord[]
listLatestBackups(): Record<string, BackupRecord>   // 新增：每项目最近一份（替代渲染层 fold）
backupStats(): BackupStats                          // 新增：统计头
getBackup(backupId: string): BackupRecord | null    // 新增

// ---------- 修改 ----------
updateBackup(backupId: string, patch: { label?: string }): { ok: boolean, error?: string }   // 新增
verifyBackup(backupId: string): Promise<{ ok: boolean, valid: boolean, error?: string }>     // 新增

// ---------- 删除 ----------
deleteBackup(backupId: string, opts?: { keepRecordOnly?: boolean }): { ok: boolean, error?: string }
deleteBackups(backupIds: string[], opts?: { keepRecordOnly?: boolean }): { ok: boolean, removed: number, failed: { id: string, error: string }[] }   // 新增：批量
pruneBackups(opts: { keepPerProject?: number, olderThanDays?: number, dryRun?: boolean }):
  { ok: boolean, targets: BackupRecord[], totalSize: number }   // 新增：清理（dryRun 预览）

// ---------- 恢复 ----------
restoreBackup(
  backupId: string,
  opts: { mode: 'overwrite' | 'new', destDir?: string, newName?: string },
  onProgress?: (p: { phase: 'unpacking' | 'copying' | 'replacing' | 'registering', done: number, total: number, current: string }) => void
): Promise<{ ok: boolean, error?: string, newProjectName?: string, newProjectId?: string }>

// ---------- 预估与任务 ----------
estimateBackup(projectId: string, opts?: { includeCache?: boolean, exclude?: string[] }):
  Promise<{ fileCount: number, bytes: number }>      // 新增
listBackupTasks(): BackupTask[]                     // 新增
watchBackupTasks(fn: (tasks: BackupTask[]) => void): () => void   // 新增
cancelBackupTask(taskId: string): void              // 新增
```

### 7.3 关键技术改造（阶段 0 的地基）

**(a) 分片让出事件循环** —— 解决 P0 冻结

```js
// preload 无完整的 fs.promises，仍用同步 fs，但每处理 N 个文件让出一次事件循环
const yieldToLoop = () => new Promise((r) => setImmediate(r))
const SLICE = 24            // 每 24 个文件或每 ~30ms 让出一次（取先到者）

for (let i = 0; i < files.length; i++) {
  …同步处理单个文件…
  if (onProgress) onProgress({ ... })
  if (i % SLICE === SLICE - 1 || Date.now() - sliceStart > 30) {
    await yieldToLoop()      // ← 让 Vue 重绘、让取消请求排进事件循环
    if (isCanceled(taskId)) throw new CanceledError()
    sliceStart = Date.now()
  }
}
```
`createZip` 与 `copyTree` 都要改。

**(b) 取消通道**：模块级 `Map<taskId, { canceled: boolean }>`；
`cancelBackupTask(id)` 置位；循环内检查后抛 `CanceledError`，被 `backupProject` 捕获并转成
`phase:'canceled'` 的任务终态。

**(c) 原子落盘** —— 解决 P0 孤儿文件

```
1. 先写临时路径：{destDir}/.gpm-tmp-{taskId}.zip   （或 .gpm-tmp-{taskId}/ 目录）
2. 成功 → 计算最终名（含秒 + 冲突去重）→ fs.renameSync(tmp, final)
3. 失败/取消 → finally 中 fs.rmSync(tmp, {recursive:true, force:true})，不写记录
4. 记录只在 rename 成功后才 putDoc
```
恢复流程同样：先解包到 `.godot-restore-*` 临时目录（现有 L426 已有此模式），
失败时清理（现在 `new` 分支失败不清理，需补）。

**(d) 备份任务表 + 订阅**：`backup.js` 内维护 `tasks: Map<id, BackupTask>`，
`emit()` 在每次进度更新时推给订阅者（与 `install.js` L14–17 / L173–181 的 `watchTasks` 同构）。
这样备份可以跨页面继续、可取消、可通知 —— 阶段 3 可顺带接入 `App.vue` 已有的全局任务栏（L124–138）。
`App.vue` 的任务栏当前只读 `DownloadTask`，需要泛化或并列渲染。

### 7.4 性能优化

| 问题 | 方案 |
|---|---|
| `listBackups` 每条 `existsSync`（L409） | 默认**不做**磁盘探测；`withStatus:true` 时才探测，并在模块内做 5 秒结果缓存（`Map<destPath, {exists, at}>`） |
| 渲染层每次进项目页拉全量 | 用新的 `listLatestBackups()`，preload 侧聚合后只传 N 条 |
| 备份页列表长度 | 默认分组 + 折叠；单组超过 20 条时组内分页/懒渲染 |
| 统计头需要全量 | `backupStats()` 在 preload 内聚合，只回传 6 个数字 |
| `estimateBackup` 遍历大目录 | 复用 `extract.js` 的 `dirSize`，但加入分片让出，避免估算本身卡界面 |

---

## 8. 文件级改动清单

**新增（8）**

| 文件 | 内容 |
|---|---|
| `src/views/BackupsView.vue` | 备份管理页（统计头 / 工具行 / 分组与时间轴 / 批量） |
| `src/components/dialogs/BackupCreateDialog.vue` | 新建备份对话框 |
| `src/components/dialogs/RestoreDialog.vue` | 三步恢复向导 |
| `src/components/ConfirmDialog.vue` | 通用危险操作确认（单条 / 批量 / 需勾选 / 需输入名称） |
| `src/components/BackupListItem.vue` | 备份条目（供分组视图与时间轴复用） |
| `src/composables/useBackups.ts` | 备份状态：列表、统计、筛选、任务订阅、刷新 |
| `src/utils/format.ts` | `fmtSize` / `formatTime` / `formatRelative` / `fmtDuration` |
| `src-ztools/preload/lib/backup.js`、`lib/fsutil.js` | 上述 preload 模块 |

**修改（10）**

| 文件 | 改动 |
|---|---|
| `src/views/ProjectsView.vue` | 移除备份模态框/样式/大部分逻辑；改为 emit 跳转；约 −200 行 |
| `src/components/TabBar.vue` | 新增「备份」标签 + 窄宽度适配 |
| `src/App.vue` | 新增 `backups` 路由分支、`pendingBackupProject` 意图态、事件接线 |
| `src/views/SettingsView.vue` | 备份区扩展为「备份与恢复」 |
| `src/types/godot.ts` | `BackupRecord` / `BackupStats` / `BackupTask` / `GodotSettings` / `DOC_ID` |
| `src/env.d.ts` | 同步全部新 API 类型 |
| `src-ztools/preload/services.js` | 暴露新 API |
| `src-ztools/preload/lib/projects.js` | 瘦身：备份逻辑移出，`trashPath` 改用 fsutil |
| `src-ztools/preload/lib/extract.js` | `createZip` 支持 level + 分片让出 + 取消；新增 `readZipEntries` |
| `src/views/Dashboard.vue` | （可选）统计区增加「备份 N 份」入口 |
| `src/components/Icon.vue` | 可能需要补 `tag`（备注）/ `filter` / `layers` / `hard-drive` 等图标 |

---

## 9. 分阶段实施步骤

> 每阶段独立可验证、可提交。建议严格按序，阶段 0 是后面所有阶段的地基。

### 阶段 0 · 地基（无 UI 变化，可单独验证）

1. 新增 `lib/fsutil.js`，从 `projects.js` 抽出 `trashPath` / `sanitizeName` / `stamp` / `copyTree`，并加入 `yieldToLoop`。
2. `extract.js` 的 `createZip` 改为分片让出 + 支持 `level` + 取消回调。
3. `copyTree` 改为分片让出 + 取消回调（保持同步 fs，只让出事件循环）。
4. 新增 `src/utils/format.ts`，`ProjectsView` 改为引用它（消除重复，行为不变）。
5. **验证**：在 `VersionsView` 或临时入口跑一次大目录打包，确认界面不冻结、进度实时刷新。

### 阶段 1 · preload 领域层

6. 新增 `lib/backup.js`：迁入备份逻辑，实现 §7.2 全部新 API + §7.3 原子落盘与任务表。
7. `projects.js` 瘦身；`services.js` 组装；`env.d.ts` 同步类型。
8. **验证**：用 `window.services.*` 直接跑通创建 / 列表 / 统计 / 校验 / 备注 / 批量删除 / 恢复（两种模式）/ 取消，
   并确认取消与失败后 `destDir` 中**无残留临时文件**、DB 中**无脏记录**。
9. **提交**：`重构备份能力为独立领域模块并支持取消与原子落盘`

### 阶段 2 · 备份管理页

10. `types/godot.ts` 扩展；`useBackups.ts`；`ConfirmDialog.vue`；`BackupListItem.vue`。
11. `BackupsView.vue`：统计头 → 工具行 → 分组视图 → 时间轴视图 → 空状态 → 批量模式。
12. `TabBar.vue` + `App.vue` 接线（含 `pendingBackupProject` 筛选跳转）。
13. **验证**：真机窗口宽度下标签栏不溢出；分组/筛选/搜索/批量删除/备注全部可用；孤立备份与缺失备份分支正确。
14. **提交**：`新增独立备份管理页面与备份列表分组筛选`

### 阶段 3 · 创建与恢复流程

15. `BackupCreateDialog.vue`（含预估、压缩级别、备注、设为默认、进度、取消、结果）。
16. `RestoreDialog.vue` 三步向导（含覆盖模式的输入名称确认、缺失/无效备份拦截、恢复进度）。
17. `ProjectsView.vue` 改造：移除旧模态框、改用 emit、行内摘要可点。
18. `SettingsView.vue` 备份设置扩展。
19. **验证**：§12 全部验收项。
20. **提交**：`重设计备份创建与恢复流程,项目页改为跳转备份管理`

### 阶段 4 · 可选增强

21. 备份任务接入 `App.vue` 全局任务栏（跨页可见 + 完成通知）。
22. 清理策略（`pruneBackups` + 设置项 + 预览确认）。
23. 批量备份（多选项目一次排队）。
24. `verifyBackup` 的自动巡检（进入备份页时后台校验缺失/过期项）。

---

## 10. 兼容与迁移

**不做破坏性迁移**，全部新字段 optional，按 `schema` 缺省视为 v1。UI 兜底：

| 老数据缺失 | UI 表现 |
|---|---|
| `label` | 显示 `{projectName} · {YYYY-MM-DD HH:mm}` |
| `includeCache` | 显示 `—` |
| `level` | 显示「标准」 |
| `engineVersion` | 显示 `—` |
| `verified` | 显示「未校验」徽标（不显示为失败） |
| `durationMs` | 不显示耗时 |

`projectId` 指向的项目已删除 → 归入「已移除的项目」组，禁用覆盖恢复，仅允许「恢复为新项目」。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 第 7 个标签在窄宿主窗口溢出 | 标签栏换行/裁切 | 阶段 2 第一步实测；预留三档宽度适配方案（§5.6） |
| preload 无完整 `fs.promises` | 不能改成真异步 IO | 用「同步 fs + 分片让出」组合，注释写明原因（现有 L348、L193 已有关注） |
| 让出频率过高 | 大项目打包变慢 | 以「24 文件或 30ms」双条件让出；让出开销远小于 UI 卡死代价 |
| 取消发生在 `rename` 之后 | 文件已是最终态但无记录 | 取消检查点只放在写入临时路径阶段；`rename` 后立即写记录，两者之间不设检查点 |
| 覆盖恢复中途断电 | 项目目录半新半旧 | 保留现有「改名 → 复制 → 旧目录入回收站」三段式 + 失败回滚（L456–467） |
| 批量删除误删 | 数据丢失 | 需勾选确认 + 列出清单 + 说明回收站语义 |
| 备份页数据不新鲜 | 显示过期状态 | 页面不加入 `KeepAlive`；`onMounted` 与 `onActivated` 均刷新 |
| 同步 `existsSync` 卡顿 | 进页变慢 | 默认不探测 + 5s 缓存（§7.4） |

---

## 12. 验收清单

**流程**
- [ ] 项目页行内「备份」只打开创建对话框，不出现历史列表
- [ ] 项目页页头「备份管理」与行内「备份于 X 前」都能跳到备份页（后者带项目筛选）
- [ ] 备份过程中界面不冻结，进度百分比/文件数/当前文件实时变化
- [ ] 备份可取消；取消后目标目录无临时文件、DB 无记录、UI 提示明确
- [ ] 备份失败后同上，且错误原因可读
- [ ] 同一分钟内对同一项目连续两次备份不互相覆盖
- [ ] 覆盖恢复必须输入项目名才能继续；恢复成功后项目可正常打开
- [ ] 恢复为新项目成功后自动出现在项目页
- [ ] 恢复过程中有进度；覆盖模式进入替换阶段后取消按钮禁用并有说明

**管理**
- [ ] 备份页展示全部项目的备份，统计头的份数/占用/缺失与列表一致
- [ ] 搜索（项目名/备注/路径）、模式筛选、缺失筛选、未备份项目筛选均生效
- [ ] 分组视图与时间轴视图切换正常；分组可折叠
- [ ] 孤立备份（项目已删除）单独成组且只能恢复为新项目
- [ ] 缺失备份标红、禁用恢复、可「移除记录」，并支持一键清理全部缺失
- [ ] 批量删除需勾选确认，执行后统计头与列表同步更新
- [ ] 备注可新增/修改并持久化，重启后仍在

**兼容与质量**
- [ ] 老备份记录（无新字段）全部正常显示、恢复、删除
- [ ] 设置页所有备份项生效且在重启后保持
- [ ] `npm run build`（`vue-tsc && vite build`）无类型错误
- [ ] 深浅双主题下备份页与三个对话框均正常
- [ ] 备份页不在 `KeepAlive` 中，切回时数据为最新

---

## 13. 待确认的取舍（已决策）

> 2026-09-24 决策：Q1/Q2/Q3/Q5 采用建议方案，Q4 采用「第 7 个标签」。

1. **压缩级别纳入首版** ✅（`createZip` 已支持 `level: 1|6|9`，默认 6）
2. **备份任务接入全局任务栏** ✅ 建议方案（排在 UI 重构之后，即阶段 4；
   任务表与 `watchBackupTasks` 已在阶段 1 就位）
3. **不自动排除 `.git` / `build`** ✅（默认保真，仅在高级选项提供 `exclude`，已实现）
4. **采用第 7 个「备份」标签页** ✅（阶段 2 实施；需实测窄窗口宽度，见 §5.6）
5. **不加内容校验和** ✅（校验仅为「zip 可读 + 含 `project.godot`」，已实现 `verifyBackup`）

---

## 14. 实施进度

### 阶段 0 · 地基 ✅ 已完成（commit `1354b1e`）

| 交付 | 说明 |
|---|---|
| `preload/lib/fsutil.js`（新增） | `yieldToLoop` / `createCancelToken` / `forEachSliced` / `walkFiles` / `copyTree` / `estimateTree` / `trashPath` / `sanitizeName` / `stampSec` / `uniquePath` / `tempPath` / `makeExcluder` / `rmQuiet` |
| `preload/lib/extract.js`（改造） | `createZip` 支持 `level` / `includeCache` / `exclude` / 分片让出 / 取消；`extractZip` 改为 fd 随机读取（不再整包入内存）+ 异步 + 进度 + 取消；新增 `readZipEntries` / `inspectZip` |
| `src/utils/format.ts`（新增） | `fmtSize` / `formatTime` / `formatRelative` / `fmtDuration`，消除 `ProjectsView` 内的重复实现 |

### 阶段 1 · preload 领域层 ✅ 已完成（commit `1354b1e`）

| 交付 | 说明 |
|---|---|
| `preload/lib/backup.js`（新增） | 创建 / 预估 / 查询 / 统计 / 备注 / 校验 / 单条与批量删除 / 清理预览 / 恢复（new + overwrite）/ 任务表与订阅 / 取消 |
| `preload/lib/projects.js`（瘦身） | 504 → 305 行；备份逻辑全部移出；`removeProject` 改用 `fsutil.trashPath` |
| `preload/services.js` | 暴露 17 个备份相关方法（原 4 个） |
| `src/types/godot.ts` | `BackupRecord` 扩展 12 个可选字段；新增 `BackupStats` / `BackupTask` / `BackupPhase` / `DOC_PREFIX`；`GodotSettings` 扩展 5 个备份项 |
| `src/env.d.ts` | 全部新 API 的类型声明 |
| 依赖方向 | `services → backup → projects → fsutil`，无循环依赖 |

**验证方式**：Node 中桩掉 `window.ztools.db`，直接驱动 preload 模块跑通 18 组场景、**101 项断言全部通过**，其中包含：

- 分片让出的直接证据：备份期间外部事件循环**转动 7 次**（纯同步实现应为 0）
- 取消：终态 `canceled`、无脏记录、目标目录文件数不变、无 `.gpm-tmp-*` 残留
- 覆盖恢复进入 `replacing` 后 `cancelBackupTask` 返回 `false`；解包阶段取消则生效
- 同一秒内重复备份不覆盖（原实现同分钟会静默覆盖）
- 截断 zip / 文件缺失均被 `verifyBackup` 判为无效
- L9 压缩体积小于 L1（`5347 < 15430`）

`npx vue-tsc` 类型检查通过（exit 0）。

### 阶段 2 · 备份管理页 ✅ 已完成（commit `5a7b736`）

| 交付 | 说明 |
|---|---|
| `src/views/BackupsView.vue`（新增） | 统计头（份数 / 占用 / 失效 / 覆盖项目）、工具行（搜索 + 5 种筛选 + 排序 + 分组·时间轴切换）、分组视图（可折叠、孤立备份单独成组）、时间轴视图、未备份项目列表、批量操作条、备注编辑弹窗 |
| `src/composables/useBackups.ts`（新增） | 列表 / 统计 / 筛选 / 分组 / 时间轴 / 未备份项目 / 批量选择 / 备注 / 校验 / 删除的完整状态与动作 |
| `src/components/BackupListItem.vue`（新增） | 备份条目：状态点、备注名、模式/级别/引擎版本标签、规模、相对时间、校验结论、行内操作 |
| `src/components/ConfirmDialog.vue`（新增） | 通用危险确认：影响面清单（可折叠）、需勾选、需输入指定文本 |
| `src/components/dialogs/RestoreDialog.vue`（新增，原计划在阶段 3） | 三步恢复向导：选择方式 → 确认影响 → 执行；覆盖模式需输入项目名；进入替换阶段后取消按钮禁用并说明 |
| `src/components/TabBar.vue` | 新增第 7 个「备份」标签；`.tabs` 允许横向滚动，并加 980/900/800px 三档宽度适配 |
| `src/App.vue` | `backups` 路由分支 + `backupScope`（项目页→备份页筛选）与 `backupRequest`（备份页→项目页）两个意图态 |
| `src/views/ProjectsView.vue` | **纯新增**：页头「备份管理」按钮、「备份于 X 前」改为可点击跳转、`autoBackup` 属性（备份页「立即备份」联动）。**旧备份弹窗保持原样**,留待阶段 3 移除 |
| `src/components/Icon.vue` | 新增 `tag` / `filter` / `layers` / `hard-drive` / `shield-check` |
| `src/main.css` | 模态框外壳提升为全局（三个新对话框共用）、`.grow` 与 `.chk` 工具类、`.modal.sm/.lg` 宽度修饰 |

**验证方式**（无法在浏览器里点击，因此用两种可执行检查替代）：

1. `npx vue-tsc` 类型检查通过（exit 0）；`npx vite build` 生产构建通过（56 modules，874ms）。
2. 把 `useBackups.ts` 打成自包含 ESM 包，在 Node 中桩掉 `window.services` / `window.ztools.db` 后驱动**真实的 Vue 响应式组合式函数**，运行 12 组场景、**76 项断言全部通过**：统计与筛选计数、关键词搜索（备注/项目名/路径）、三种排序、按项目分组与孤立备份归组、时间轴四档分桶、未备份项目、项目范围限定叠加筛选、批量选择、备注增删、校验写回、批量与单条删除后统计同步、折叠状态、全空数据不崩。
3. 期间发现并修复一个真实缺陷：**「全选/取消全选」原先没有限定在当前筛选列表内**——切换筛选后点「取消全选」会清空全部选择。现改为「勾选取并集、取消只移除列表内项」，选择在切换筛选时始终可预期、可逆。

**关键 UI 风险已核实**：按实际字宽估算，7 个标签 + 品牌区约需 **676px**，宿主窗口实测宽度 **922px**，留有余量；同时 `.tabs` 已加 `overflow-x: auto` 兜底，并准备了 980/900/800px 三档降级（收内边距 → 隐藏品牌副标题 → 只留图标），任何宽度下都不会换行或溢出。

### 阶段 3 · 创建流程与旧界面下线 ✅ 已完成（commit `ee23a66`）

| 交付 | 说明 |
|---|---|
| `src/components/dialogs/BackupCreateDialog.vue`（新增） | 项目选择（项目页进入时锁定）/ 备注名 / 方式卡片 / 压缩级别 / 保存位置 + 设为默认 / 高级排除（`.godot`、`.git`、`build`+`export`）/ 分片式预估 / 进度 + 取消 / 结果卡（体积、文件数、耗时、路径） |
| `src/views/ProjectsView.vue` | **移除**旧备份弹窗模板、样式与全部相关逻辑（`confirmBackup` / `doRestore` / `doDeleteBackup` / `chooseBackupDir` / `historyList` / 两击确认状态）；行内备份按钮改为打开创建对话框；改用 `listLatestBackups()` 取行内摘要。**1202 → 792 行（−410）** |
| `src/views/BackupsView.vue` | 页头加入「新建备份」入口（未选项目时可选项目） |
| `src/views/SettingsView.vue` | 「项目备份目录」→「备份与恢复」：默认目录 / 默认方式 / zip 压缩级别 / 默认包含缓存 / 默认排除目录（5 项） |
| `src/App.vue` | 补回 `@backup-project` 接线（备份页「立即备份」→ 项目页创建对话框） |

**验证**：`npx vue-tsc` 通过；`npx vite build` 通过（59 modules）；阶段 0/1 的 101 项 preload 断言重跑仍全绿（回归无误）。

> **保留策略**（保留最近 N 份 / 早于 M 天）没有在本阶段加入设置页：`pruneBackups` 已就位，但配套的「预览 → 确认 → 执行」交互属于阶段 4，先放设置项会出现「改了设置却什么都不发生」，因此推迟到与清理功能一起上线。

### 阶段 4 · 可选增强 ✅ 已完成（commit `033bac7`）

| 交付 | 说明 |
|---|---|
| `src/App.vue` | 备份/恢复任务接入全局任务栏：两种来源的任务归一化为统一条目（下载 `tag`、备份「备份 · 项目名」+ 阶段与百分比），完成后统一通知并清理；任务栏按钮按类型在「备份任务 / 引擎任务」间切换 |
| `src/components/dialogs/PruneDialog.vue`（新增） | 清理备份：保留策略（每项目最近 N 份 / 早于 M 天 / 不清理）→ **先预览**（份数、可释放体积、逐条清单）→ 勾选确认 → 执行；可把策略保存为默认 |
| `src/composables/useBackups.ts` | 新增 `patrol()`（后台巡检）与 `backupMany()`（串行批量备份） |
| `src/views/BackupsView.vue` | 页头「清理」入口；「未备份项目」分组加入「全部备份」按钮（串行执行并显示 `n/总 项目名` 进度）；进入页面后自动后台巡检并在顶部显示进度 |

**两个刻意的设计决定**

1. **保留策略放在清理对话框里，而不是设置页**：`pruneBackups` 是「按需触发」的操作，设置页里的一项孤立配置会出现「改了却什么都不发生」。对话框内就地设置并支持「保存为默认」，既好用又不留无效项。
2. **巡检只处理「从未校验」与「缺失但未判定」的记录**：已判定为缺失的记录不重复校验（文件若被恢复，`missing` 会先翻回 `false`，那时才会重新验证），避免每次进页面都做无谓的磁盘探测。

---

## 15. 运行环境差异（重要教训）

阶段 1 的 101 项断言在 Node 里全绿，但**在 ZTools 里一打开新建备份对话框就报 `setImmediate is not defined`**。

原因：`fsutil.yieldToLoop()` 直接使用了 `setImmediate`。它是 **Node 专有全局**，而 preload 实际运行在渲染进程的沙箱里（浏览器侧的全局环境）——`Buffer`、`process.nextTick`、`require` 都在，唯独定时器是 Web 的一套。

修复（commit `43ab2e4`）：`yieldToLoop` 按可用性依次降级，并用队列而非单个变量持有回调（并发任务同时让出时不会互相覆盖）：

```
setImmediate  →  MessageChannel  →  setTimeout(0)
（纯 Node）      （浏览器/沙箱，无 4ms 嵌套钳制）   （兜底）
```

同时补上了**两条路径的自动化验证**：测试脚本支持 `--no-immediate`，在 `require` 任何 preload 模块之前删除 `globalThis.setImmediate`，用来模拟真实沙箱。两条路径现在都是 **102 项断言全绿**。

> 这个缺陷暴露了「本地跑通」与「宿主里跑通」的差距：preload 层的自动化测试必须在**移除 Node 专有全局**的条件下再跑一遍，否则会漏掉整整一类错误。后续新增 preload 代码时，这条要作为常规检查项。

---

## 16. 最终状态

四个阶段全部完成，五次功能提交 + 两次文档提交：

| 提交 | 内容 |
|---|---|
| `1354b1e` | 阶段 0/1：地基（分片让出、取消、原子落盘）+ 备份领域层 |
| `5a7b736` | 阶段 2：备份管理页 + 三步恢复向导 |
| `ee23a66` | 阶段 3：新建备份对话框 + 旧界面下线 + 设置页 |
| `43ab2e4` | 修复 preload 沙箱无 `setImmediate` |
| `033bac7` | 阶段 4：全局任务栏 + 清理策略 + 批量备份 + 后台巡检 |

**功能闭环**：项目页创建 → 备份页集中管理（统计 / 搜索 / 筛选 / 分组 / 时间轴 / 批量 / 备注 / 校验 / 清理）→ 三步恢复向导（覆盖模式需输入项目名）。

**新增**：`backup.js`、`fsutil.js`、`BackupsView.vue`、`useBackups.ts`、`BackupListItem.vue`、`ConfirmDialog.vue`、`BackupCreateDialog.vue`、`RestoreDialog.vue`、`PruneDialog.vue`、`utils/format.ts`。
**瘦身**：`projects.js` 504 → 305 行；`ProjectsView.vue` 1202 → 792 行。

**验证手段**（无浏览器环境下的替代方案）：preload 层 102 项断言（两条 yield 路径各跑一遍）+ 管理页派生逻辑 90 项断言（把组合式函数打成自包含包，在 Node 中驱动真实 Vue 响应式）+ `vue-tsc` 与 `vite build` 全绿。

### 16.1 宿主内人工验证

| 项 | 状态 | 说明 |
|---|---|---|
| 备份进行中切页，底部任务栏显示进度 | ✅ 已确认 | 跨页面可见、显示「备份 · 项目名 + 阶段 + 百分比」 |
| 「清理」对话框的预览数字 | ✅ 已确认 | 份数 / 可释放体积 / 逐条清单与实际一致 |
| 7 个标签在真实窗口宽度下不溢出 | ✅ 已确认 | 922px 窗口下正常容纳，未见换行或裁切 |
| 修复前的新建备份对话框报错 | ✅ 已确认修复 | 见 §15 |
| 备份创建全流程（zip / 快照 / 压缩级别 / 排除项） | ⬜ 待验证 | 修复 `setImmediate` 后尚未走完整流程 |
| 三步恢复向导（尤其覆盖模式） | ⬜ 待验证 | 覆盖模式需输入项目名，替换阶段取消应被拒绝 |
| 批量备份（未备份项目 → 全部备份） | ⬜ 待验证 | 串行执行，底部任务栏应逐个显示 |
| 进入备份页的后台巡检 | ⬜ 待验证 | 顶部应出现「正在巡检备份完整性 n/N」 |
| 暗色主题下的备份页与三个对话框 | ⬜ 待验证 | 深浅双主题均使用同一套 CSS 变量，预期无差异 |

> 标 ⬜ 的项目不是在等自动化补测——它们只能在 ZTools 宿主里点一遍才能确认，而本环境没有浏览器/宿主。
> 自动化能覆盖的是「逻辑正确」（177 项断言），覆盖不了「宿主里真的跑得通」；§15 那个 `setImmediate` 缺陷正是这个差距的实例。



