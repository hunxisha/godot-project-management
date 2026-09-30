// 桌面版窗口策略回归测试。
//
// 起因(线上缺陷):桌面版启动项目后软件自己关闭。链路是
// 渲染层 launchProject 成功 → hideMainWindow() → IPC → 主进程 close() 唯一窗口
// → window-all-closed → app.quit()。这里把「隐藏 ≠ 关闭」钉死,
// 以后谁把策略改回 close() 都会被拦下。
//
// 用法:
//   node desktop/main/__tests__/window-policy.test.js
const path = require('node:path')

const { hideMainWindow, shouldQuitOnAllWindowsClosed } = require(path.resolve(__dirname, '../window-policy.js'))

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

/** 假窗口:只记录被调用的动作,close() 被调用即视为缺陷复现 */
function fakeWindow(opts = {}) {
  return {
    calls: [],
    destroyed: !!opts.destroyed,
    isDestroyed() { return this.destroyed },
    minimize() { this.calls.push('minimize') },
    close() { this.calls.push('close') },
    hide() { this.calls.push('hide') }
  }
}

section('1. hideMainWindow = 最小化,绝不能关窗')
{
  const win = fakeWindow()
  ok(hideMainWindow(win) === true, '执行成功返回 true')
  ok(win.calls.includes('minimize'), '调用了 minimize()', win.calls.join(','))
  ok(!win.calls.includes('close'), '没有调用 close()(否则 window-all-closed → app.quit)', win.calls.join(','))
}

section('2. 边界:空窗口 / 已销毁窗口不抛错')
{
  ok(hideMainWindow(null) === false, 'null → false')
  ok(hideMainWindow(undefined) === false, 'undefined → false')
  const gone = fakeWindow({ destroyed: true })
  ok(hideMainWindow(gone) === false, '已销毁窗口 → false')
  ok(gone.calls.length === 0, '已销毁窗口不触发任何动作', gone.calls.join(','))
}

section('3. 关掉最后一个窗口:非 macOS 才退出')
{
  ok(shouldQuitOnAllWindowsClosed('linux') === true, 'linux 关窗即退出')
  ok(shouldQuitOnAllWindowsClosed('win32') === true, 'win32 关窗即退出')
  ok(shouldQuitOnAllWindowsClosed('darwin') === false, 'macOS 留在程序坞')
}

console.log(`\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
