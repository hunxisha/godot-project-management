# 术语表

本项目的文档（README / CHANGELOG / `docs/*`）与提交信息里，同一件事曾有多种叫法。
graphify 知识图谱抽出了其中 5 组「语义相同、表述不同」的关系 —— 这份表把正名定下来，
其余位置统一引用。第一列是**唯一正名**，写文档、提 commit、起变量名都用它。

## 5 组已收敛的表述

### 1. 三步恢复向导

从备份恢复的交互流程：**选择方式 → 确认影响 → 执行**。

- 曾用表述：`三步恢复向导（选择方式 → 确认影响 → 执行）`
- 实现：`src/components/dialogs/RestoreDialog.vue`（`step` 状态机 1/2/3）
- 注意：覆盖恢复是破坏性操作，第 2 步必须输入项目名确认；进入 `replacing` 阶段后取消会被拒绝。

### 2. 来源过户

复制插件目录到另一个项目时，把 `godot/asset/*` 的市场来源记录**一并过户**，
使目标项目仍能显示商店链接与版本入口。

- 曾用表述：`复制插件到其他项目时保留市场来源`
- 实现：`src-ztools/preload/lib/projects.js` 的 `copyAddonsToProject`
- 相关字段：记录上的 `copiedFrom` 用于追溯

### 3. 分片让出

长循环（遍历/复制/打包）每隔 `SLICE_FILES` 个文件或 `SLICE_MS` 毫秒**主动让出事件循环**，
使渲染层能重绘并响应取消。

- 曾用表述：`长任务不冻结界面：分片让出事件循环`、`同步 fs + 分片让出事件循环`
- 实现：`src-ztools/preload/lib/fsutil.js` 的 `yieldToLoop()` 与 `forEachSliced()`
- 相关：`yieldToLoop` 有三级降级链（`setImmediate` → `MessageChannel` → `setTimeout`），
  因为 preload 沙箱里**没有 `setImmediate`**；`--no-immediate` 沙箱测试守的就是这条。

### 4. 原子落盘

先写临时产物（`.gpm-tmp-*`），成功后再 rename 到最终名；失败/取消一律清理。

- 曾用表述：`原子落盘：先写临时产物再改名`、`先写 .gpm-tmp-* 再原子改名`
- 实现：`src-ztools/preload/lib/fsutil.js` 的 `tempPath()`；调用方 `backup.js` 的 `backupProject` / `restoreBackup`
- 约束：临时产物与最终目标**同目录**（保证 rename 不跨盘）

### 5. 保留策略

备份清理规则：**每项目保留最近 N 份** 与/或 **删除早于 M 天的备份**。

- 曾用表述：`保留策略清理（最近 N 份 / 早于 M 天）`
- 实现：`src-ztools/preload/lib/backup.js` 的 `pruneBackups`（**默认 `dryRun: true`**，必须先预览）
- 设置项：`backupKeepPerProject` / `backupKeepDays`；放在清理对话框里而不是设置页

## 其他高频术语

| 正名 | 含义 | 入口 |
|---|---|---|
| **渲染层** | Vue 部分（`src/`），跑在 ZTools webview 里 | `src/main.ts` |
| **preload 层** | CommonJS 的 Node 能力层（`src-ztools/preload/`），跑在渲染进程沙箱内 | `src-ztools/preload/services.js` |
| **`window.services`** | 渲染层访问 preload 能力的**唯一**出口（47 个方法） | 类型见 `src/env.d.ts`，实现见 `services.js` |
| **bridge** | 渲染层访问 ZTools 宿主 API（db、对话框、通知、shell）的统一出口 | `src/services/bridge.ts` |
| **任务表** | 长任务（下载/备份/恢复）的注册表 + 快照订阅 + 取消机制 | `src-ztools/preload/lib/taskqueue.js` |
| **契约测试** | 断言 `window.services` 的 47 个方法与 `env.d.ts` 逐项一致的测试 | `lib/__tests__/services.test.js` |
| **沙箱测试** | 先删掉 `setImmediate` 再跑，模拟 ZTools preload 真实环境 | `npm run test:preload:sandbox` |
| **`--no-immediate`** | 上述沙箱模拟的开关；**两条路径都要跑**，只跑默认路径会漏掉一整类宿主专属报错 | 同上 |

## 维护约定

新增术语时：先在这里定正名，再让文档与 commit 引用它。
如果发现同一件事又出现了第二种写法，请在本表登记并**把旧写法改掉**，而不是两种并存。
