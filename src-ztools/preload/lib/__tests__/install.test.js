// install.js 回归测试:下载安装编排的任务生命周期。
//
// 这个模块此前**没有任何测试触达**(见 docs/optimization-plan.md P2-1),而它承担了
// 「串行下载队列 + 状态机 + 取消 + 落库」这条最容易出错的链路。taskqueue 抽取后必须
// 有护栏,否则「本地看着对」就等于没验证。
//
// 依赖处理:
//   - http / extract / store:有网络与磁盘副作用,**打桩**
//   - godotExe:纯函数用真实现(findExecutable / verifyExecutable 打桩,避免真的去 spawn)
//
// 用法:
//   node src-ztools/preload/lib/__tests__/install.test.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const LIB = path.resolve(__dirname, '..')

// ---------- 依赖打桩(必须在 require install.js 之前) ----------
function stub(relFile, exports) {
  const abs = require.resolve(path.join(LIB, relFile))
  require.cache[abs] = { id: abs, filename: abs, loaded: true, children: [], paths: [], exports }
}

const downloads = [] // 每次 downloadFile 调用产生的句柄
function makeHandle(url, destPath, opts) {
  let resolveFn
  let rejectFn
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej })
  const handle = {
    url,
    destPath,
    cancelled: false,
    promise,
    cancel() {
      handle.cancelled = true
      rejectFn(new Error('已取消'))
    },
    /** 测试驱动:模拟下载成功 */
    finish() {
      if (opts && opts.onProgress) opts.onProgress(1024, 1024)
      resolveFn()
    },
    /** 测试驱动:模拟下载失败 */
    fail(msg) {
      rejectFn(new Error(msg))
    }
  }
  downloads.push(handle)
  return handle
}
stub('http.js', {
  downloadFile: makeHandle,
  // install.js 用带续传的封装;桩里复用同一句柄工厂,行为契约一致
  downloadResumable: (url, destPath, opts) => makeHandle(url, destPath, opts)
})

let extractShouldFail = false
const extracted = []
stub('extract.js', {
  ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
  extractZip: async (zipPath, installDir) => {
    if (extractShouldFail) throw new Error('解压损坏')
    fs.mkdirSync(installDir, { recursive: true })
    fs.writeFileSync(path.join(installDir, 'Godot_v4.7.2-stable_win64.exe'), 'fake')
    extracted.push(installDir)
  },
  dirSize: () => 12345,
  // install.js 下载后会做 zip 预检;桩里视为合法压缩包
  inspectZip: () => ({ ok: true, entries: ['Godot.exe'] })
})

const FAKE_EXE = path.join('C:', 'fake', 'Godot.exe')
const realExe = require(path.join(LIB, 'godotExe.js'))
stub('godotExe.js', {
  ...realExe,
  findExecutable: () => FAKE_EXE,
  verifyExecutable: async () => ({ ok: true, output: '4.7.2.stable.official' })
})

const db = new Map()
const putCalls = []
stub('store.js', {
  getDoc: (id) => (db.has(id) ? { ...db.get(id) } : null),
  putDoc: (id, data) => { putCalls.push(id); db.set(id, { ...data }); return true },
  removeDoc: (id) => { db.delete(id); return true },
  listDocs: (prefix) => [...db.keys()].filter((k) => k.startsWith(prefix))
})

const install = require(path.join(LIB, 'install.js'))

// ---------- harness ----------
let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`)
  }
}
function section(t) {
  console.log(`\n=== ${t} ===`)
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const TERMINAL = { done: 1, error: 1, canceled: 1 }
// 常驻订阅:每次 emit 都刷新快照,taskOf 从最新快照里取(不要在这里再 subscribe,会漏订阅)
let lastSnapshot = []
install.watchTasks((snaps) => { lastSnapshot = snaps })
const taskOf = (id) => lastSnapshot.find((t) => t.id === id)
/** 轮询直到条件成立(或超时),避免依赖微任务计数 */
async function waitUntil(pred, maxTicks = 200) {
  for (let i = 0; i < maxTicks; i++) {
    if (pred()) return true
    await tick()
  }
  return false
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-install-test-'))
const ROOT = path.join(WORK, 'versions')
const PARAMS = (tag) => ({
  tag,
  variant: 'standard',
  platform: 'win64',
  url: `https://example.test/${tag}.zip`,
  fileName: `Godot_v${tag}_win64.zip`,
  totalSize: 1024
})

async function main() {
  // ---------- 1. 建队列 ----------
  section('1. 启动下载:任务立即可见,id 形状不变')
  const before = downloads.length
  const id1 = install.downloadAndInstall(PARAMS('4.7.2-stable'), { versionsRoot: ROOT })
  ok(/^dl-\d+-[a-z0-9]{5}$/.test(id1), 'id 形状保持 dl-<毫秒>-<5 位随机>', id1)
  ok(!!taskOf(id1), '订阅者立刻看到该任务')
  ok(taskOf(id1).status === 'downloading', '作业同步推进到 downloading', taskOf(id1).status)
  ok(taskOf(id1).tag === '4.7.2-stable', '任务带上版本 tag')
  ok(downloads.length === before + 1, '只创建了一个下载句柄')
  ok(downloads[before].url === PARAMS('4.7.2-stable').url, '下载 URL 正确')
  ok(downloads[before].destPath.endsWith('.part'), '先下到 .part 临时文件')

  // ---------- 2. 成功路径 ----------
  section('2. 成功路径:downloading → extracting → verifying → done')
  const seen = []
  const unsub = install.watchTasks((snaps) => {
    const t = snaps.find((x) => x.id === id1)
    if (t && seen[seen.length - 1] !== t.status) seen.push(t.status)
  })
  downloads[before].finish()
  ok(await waitUntil(() => taskOf(id1).status === 'done'), '任务在限时内到达 done', taskOf(id1).status)
  unsub()
  ok(seen.includes('extracting'), '观察到 extracting 阶段', seen.join('→'))
  ok(seen.includes('verifying'), '观察到 verifying 阶段', seen.join('→'))
  const done = taskOf(id1)
  ok(!!done.versionId && /^godot\/version\//.test(done.versionId), 'done 携带 versionId', String(done.versionId))
  ok(!!done.version && done.version.name === '4.7.2 Stable', '版本记录展示名走共享 displayName', done.version && done.version.name)
  ok(done.version.size === 12345, '版本体积来自 dirSize')
  ok(done.version.managed === true && done.version.verified === true, 'managed / verified 标记正确')
  ok(putCalls.includes(done.versionId), '版本记录已落库')

  // ---------- 3. 串行队列 ----------
  section('3. 串行:第二个下载不抢跑')
  const seqBefore = downloads.length
  const idA = install.downloadAndInstall(PARAMS('4.6-stable'), { versionsRoot: ROOT })
  const idB = install.downloadAndInstall(PARAMS('4.5-stable'), { versionsRoot: ROOT })
  ok(downloads.length === seqBefore + 1, '同一时刻只有一个下载在跑')
  ok(taskOf(idB).status === 'queued', '排在后面的任务仍为 queued', taskOf(idB).status)
  downloads[seqBefore].finish()
  ok(await waitUntil(() => downloads.length === seqBefore + 2), '前一个完成后才启动下一个')
  ok(await waitUntil(() => taskOf(idA).status === 'done'), '第一个任务完成')
  downloads[seqBefore + 1].finish()
  ok(await waitUntil(() => taskOf(idB).status === 'done'), '第二个任务随后完成')
  ok(db.has(taskOf(idA).versionId) && db.has(taskOf(idB).versionId), '两个版本都落库')

  // ---------- 4. 取消 ----------
  section('4. 取消:销毁请求 / 不写脏记录 / 终态 canceled')
  const cancelBefore = downloads.length
  const docsBefore = putCalls.length
  const idC = install.downloadAndInstall(PARAMS('4.4-stable'), { versionsRoot: ROOT })
  ok(taskOf(idC).status === 'downloading', '取消前处于 downloading')
  install.cancelTask(idC)
  ok(downloads[cancelBefore].cancelled === true, '取消触发了下载句柄的 cancel()')
  ok(taskOf(idC).status === 'canceled', '任务状态立即变为 canceled', taskOf(idC).status)
  await waitUntil(() => taskOf(idC).status === 'canceled')
  await tick(); await tick()
  ok(putCalls.length === docsBefore, '取消后没有写入版本记录')
  ok(taskOf(idC).status === 'canceled', '取消后状态保持 canceled(不被后续阶段覆盖)', taskOf(idC).status)

  // ---------- 5. 失败路径 ----------
  section('5. 失败路径:解压失败 → error')
  extractShouldFail = true
  const idD = install.downloadAndInstall(PARAMS('4.3-stable'), { versionsRoot: ROOT })
  downloads[downloads.length - 1].finish()
  ok(await waitUntil(() => taskOf(idD).status === 'error'), '解压失败后状态为 error', taskOf(idD).status)
  ok(taskOf(idD).error === '解压损坏', 'error 带上了失败原因', String(taskOf(idD).error))
  extractShouldFail = false

  section('6. 下载失败 → error')
  const idE = install.downloadAndInstall(PARAMS('4.2-stable'), { versionsRoot: ROOT })
  downloads[downloads.length - 1].fail('网络断了')
  ok(await waitUntil(() => taskOf(idE).status === 'error'), '下载失败后状态为 error', taskOf(idE).status)
  ok(taskOf(idE).error === '网络断了', 'error 带上网络失败原因', String(taskOf(idE).error))

  // ---------- 6. dismiss ----------
  section('7. dismiss:任何状态都可移除(与原实现一致)')
  const live = install.downloadAndInstall(PARAMS('4.1-stable'), { versionsRoot: ROOT })
  install.dismissTask(live)
  ok(!taskOf(live), '进行中的任务也能被移除')
  ok(!lastSnapshot.some((t) => t.id === live), '订阅者快照中已消失')
  downloads[downloads.length - 1].cancel()
  await tick(); await tick()
  ok(!taskOf(live), '被移除的任务不会因后续阶段而复活')

  section('8. 已结束任务可清理')
  install.dismissTask(id1)
  install.dismissTask(idA)
  install.dismissTask(idB)
  install.dismissTask(idC)
  install.dismissTask(idD)
  install.dismissTask(idE)
  ok(lastSnapshot.filter((t) => TERMINAL[t.status]).length === 0, '终态任务清理干净', String(lastSnapshot.length))

  // ---------- 结果 ----------
  console.log(`\n${'='.repeat(56)}`)
  console.log(`PASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) {
    console.log('失败项:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('全部通过')
  process.exit(0)
}

main().catch((e) => {
  console.error('\n未捕获异常:', e)
  process.exit(1)
})
