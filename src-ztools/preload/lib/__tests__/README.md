# preload 回归测试

preload 领域层的回归测试。在 Node 中桩掉 `window.ztools.db`，**require 真实源码**后跑通完整流程，
不依赖任何测试框架。

| 文件 | 覆盖 |
|---|---|
| `backup.test.js` | 备份领域层（`backup.js` / `fsutil.js` / `extract.js`） |
| `addons.test.js` | 插件来源与复制（`assets.js` 的 `listAddons`、`projects.js` 的 `copyAddonsToProject`） |
| `godotExe.test.js` | 版本串解析 / 展示名 / 平台标识（`godotExe.js`），并守住「这些工具函数全仓只有一处定义」 |
| `taskqueue.test.js` | 任务队列语义（`taskqueue.js`）：快照拷贝、监听器异常隔离、终态才可 dismiss、取消令牌、串行执行 |
| `fsutil.test.js` | 文件系统工具（`fsutil.js`）：名称/路径处理、取消令牌与 lock 语义、**分片让出的三级降级链**、递归收集与复制、预估 |
| `http.test.js` | 网络层（`http.js`）：文本/JSON、重定向、代理校验与 CONNECT 隧道、下载进度、**取消必须了结 promise** |
| `install.test.js` | 下载安装编排（`install.js`）：串行队列、状态机、取消、失败路径（`http` / `extract` / `store` 打桩） |
| `services.test.js` | 服务面契约：`window.services` 的 47 个方法 与 `src/env.d.ts` 的 `interface Services` 必须逐项一致 |

## 运行

```bash
npm run test:preload            # 备份:默认路径
npm run test:preload:sandbox    # 备份:模拟 ZTools 沙箱（先删掉 setImmediate）
npm run test:addons             # 插件来源与复制:默认 + 沙箱各跑一遍
npm run test:preload:unit       # godotExe + taskqueue + fsutil + http + install + services 契约（打桩，秒级）
npm test                        # 全部（含主题、格式化、对话框骨架与组合式函数测试）
```

也可以直接指定被测目录与工作目录：

```bash
node src-ztools/preload/lib/__tests__/backup.test.js [libDir] [workDir] [--no-immediate]
node src-ztools/preload/lib/__tests__/addons.test.js [libDir] [workDir] [--no-immediate]
node src-ztools/preload/lib/__tests__/godotExe.test.js
node src-ztools/preload/lib/__tests__/taskqueue.test.js
node src-ztools/preload/lib/__tests__/fsutil.test.js
node src-ztools/preload/lib/__tests__/http.test.js
node src-ztools/preload/lib/__tests__/install.test.js
node src-ztools/preload/lib/__tests__/services.test.js
```

## 为什么必须有 `--no-immediate` 这一条

`--no-immediate` 会在 require 任何被测模块**之前**删除 `globalThis.setImmediate`，
用来复现 ZTools preload 的真实环境。preload 跑在渲染进程的沙箱里（浏览器侧全局环境）：
`Buffer`、`process.nextTick`、`require` 都在，**唯独没有 `setImmediate`**——它是 Node 专有全局。

这正是 commit `43ab2e4` 修掉的那个缺陷：101 项断言在 Node 里全绿，但一打开新建备份对话框就报
`setImmediate is not defined`。只跑默认路径会漏掉整整一类「本地能跑、宿主里报错」的问题，
所以**两条路径都要跑**。

新增 preload 代码时请遵守：只用 `setTimeout` / `MessageChannel` 这类通用调度 API，
需要「让出事件循环」时统一走 `fsutil.yieldToLoop()`（它已按可用性降级）。

## backup.test.js 覆盖范围

| 分组 | 内容 |
|---|---|
| 分片让出 | 备份期间外部事件循环仍在转动（纯同步实现应为 0 次） |
| 创建 | zip / 完整快照、压缩级别 L1 vs L9 体积差异、`.godot` 与自定义目录排除 |
| 原子性 | 无 `.gpm-tmp-*` 残留、失败/取消不写脏记录、同秒重复备份不互相覆盖 |
| 查询 | `listBackups` 的字符串与对象两种入参、`withStatus` 开关、`listLatestBackups` 折叠、`backupStats` 聚合 |
| 校验 | 正常 zip、截断 zip、文件缺失三种结论 |
| 修改 | 备注写入 / trim / 清除、不存在的记录返回失败 |
| 恢复 | 恢复为新项目（快照与 zip 两条路径）、覆盖恢复及回滚保护 |
| 取消 | 备份取消的终态与无残留、恢复解包阶段可取消、覆盖恢复进入 `replacing` 后取消被拒绝 |
| 清理与删除 | `pruneBackups` 默认 dryRun 只预览、单条 / 批量删除、`keepRecordOnly`；「删除→回收站」真实链路默认跳过（见下） |
| 排除规则 | `.git` / `addons` 等按目录名排除并记入记录 |

## addons.test.js 覆盖范围

| 分组 | 内容 |
|---|---|
| 来源解析 | `fromMarket` 判定、`assetId`、商店链接（优先用记录里的 `meta.storeUrl`，缺失时按 `assetId` 拼装）、版本优先取 `plugin.cfg`、启用状态 |
| 复制过户 | 复制目录时把 `godot/asset/*` 来源记录一并过户到目标项目（否则目标项目显示「未知来源」且失去商店链接与版本入口） |
| 幂等与补回 | 目录已存在时只补来源、不重复复制；记录已存在时不重复过户；删掉目标记录后再复制可补回 |
| 不凭空生成 | 手工放置、无来源记录的插件复制后仍是「未知来源」 |
| 合并 | 同一资产对应多个目录时并入同一条记录（`dirNames` 取并集） |
| 边界 | 不能复制到同一项目、不存在的目录计入 `skipped`、不存在的项目返回空列表 |

## 已知副作用（默认已关闭）

`backup.test.js` 里唯一会写系统回收站的断言是「真实删除 → 移入回收站」这条链路，
它调用 Windows 的 `SendToRecycleBin`，**每次运行都会在回收站里留下一个几百字节的临时文件**。

为了不让 `npm test` 变成非幂等操作，该断言**默认跳过**（结果行会打印 `SKIP`，不会静默少跑），
其余删除断言一律走 `keepRecordOnly`，只移除记录、不碰磁盘。需要验证这条真实链路时显式开启：

```bash
GPM_TEST_TRASH=1 npm run test:preload     # Windows PowerShell: $env:GPM_TEST_TRASH=1; npm run test:preload
```

被删对象位于本次运行的临时工作目录内（默认 `os.tmpdir()` 下新建的 `gpm-backup-test-*`），
不影响仓库内容。

