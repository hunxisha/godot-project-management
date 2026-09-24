# preload 回归测试

备份领域层（`lib/backup.js`、`lib/fsutil.js`、`lib/extract.js`）的回归测试。
在 Node 中桩掉 `window.ztools.db`，**require 真实源码**后跑通完整流程，不依赖任何测试框架。

## 运行

```bash
npm run test:preload            # 默认路径
npm run test:preload:sandbox    # 模拟 ZTools preload 沙箱（先删掉 setImmediate）
npm test                        # 上面两条 + 组合式函数测试
```

也可以直接指定被测目录与工作目录：

```bash
node src-ztools/preload/lib/__tests__/backup.test.js [libDir] [workDir] [--no-immediate]
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

## 覆盖范围

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
| 清理与删除 | `pruneBackups` 默认 dryRun 只预览、单条 / 批量删除、`keepRecordOnly` |
| 排除规则 | `.git` / `addons` 等按目录名排除并记入记录 |

## 已知副作用

其中一项断言会验证「删除备份 → 移入回收站」这条真实链路，因此**每次运行都会在 Windows 回收站
里留下一个几百字节的临时文件**。被删对象位于本次运行的临时工作目录内（默认
`os.tmpdir()` 下新建的 `gpm-backup-test-*`），不影响仓库内容。
