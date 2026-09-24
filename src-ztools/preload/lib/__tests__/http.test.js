// http.js 回归测试:GET 文本/JSON、文件下载、代理分支与取消。
//
// 这个模块此前**没有任何测试触达**,而它是全项目风险最高的代码(网络、代理、TLS、重定向、
// 取消),一旦出错排查成本极高。这里用 Module._load 注入假 https/http/tls,把各条分支
// 钉住 —— 包括刚修掉的那个「cancel() 让 promise 永久悬空」。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/http.test.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')

const LIB = path.resolve(__dirname, '..')

// ---------- 桩注入(必须在 require http.js 之前) ----------
let settings = null
let plans = []
const getCalls = []
const connectCalls = []

function makeRes(plan) {
  if (plan.hang) {
    const r = new Readable({ read() {} })
    r.statusCode = plan.statusCode || 200
    r.headers = plan.headers || {}
    return r
  }
  const r = Readable.from([Buffer.from(plan.body || '')])
  r.statusCode = plan.statusCode || 200
  r.headers = plan.headers || {}
  return r
}

const fakeHttps = {
  get(url, opts, cb) {
    const req = new EventEmitter()
    req.url = url
    req.opts = opts
    req.destroy = () => {
      req.destroyed = true
    }
    getCalls.push({ url: String(url), opts })
    const plan = plans.shift() || { statusCode: 200, body: 'ok' }
    if (plan.throwSync) {
      setImmediate(() => {})
      throw new plan.throwSync()
    }
    setImmediate(() => {
      if (plan.netError) return req.emit('error', new Error(plan.netError))
      cb(makeRes(plan))
    })
    return req
  }
}

const fakeHttp = {
  request(opts) {
    const req = new EventEmitter()
    req.opts = opts
    req.destroyed = false
    req.destroy = () => { req.destroyed = true }
    req.end = () => {}
    connectCalls.push(opts)
    return req
  }
}

const fakeTls = {
  connect() {
    const sock = new EventEmitter()
    sock.destroy = () => {}
    return sock
  }
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  const fromHttp = parent && /http\.js$/.test(parent.filename || '')
  if (fromHttp) {
    if (request === './store') return { getDoc: () => settings }
    if (request === 'node:https') return fakeHttps
    if (request === 'node:http') return fakeHttp
    if (request === 'node:tls') return fakeTls
  }
  return origLoad.apply(this, arguments)
}

const { getText, getJson, downloadFile } = require(path.join(LIB, 'http.js'))

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function reset() {
  settings = null
  plans = []
  getCalls.length = 0
  connectCalls.length = 0
}
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-http-test-'))
const dest = (n) => path.join(WORK, n)
const outcome = (p, ms = 300) =>
  Promise.race([
    p.then(() => 'resolved', (e) => 'rejected:' + e.message),
    sleep(ms).then(() => 'pending')
  ])

async function main() {
  // ---------- 1. getText 正常路径 ----------
  section('1. getText:200 / UA / 自定义头')
  {
    reset()
    plans = [{ statusCode: 200, body: 'hello' }]
    const text = await getText('https://example.test/a')
    ok(text === 'hello', '返回响应体文本', text)
    ok(getCalls.length === 1, '只发一次请求', String(getCalls.length))
    ok(getCalls[0].url === 'https://example.test/a', '请求了正确 URL', getCalls[0].url)
    ok(getCalls[0].opts.headers['User-Agent'] === 'ztools-godot-plugin', '带默认 User-Agent', JSON.stringify(getCalls[0].opts.headers))

    reset()
    plans = [{ statusCode: 200, body: 'x' }]
    await getText('https://example.test/b', { 'X-Test': '1' })
    ok(getCalls[0].opts.headers['X-Test'] === '1', '自定义头被带上')
    ok(getCalls[0].opts.headers['User-Agent'] !== undefined, '自定义头不覆盖 UA')
  }

  // ---------- 2. getText 重定向与非 200 ----------
  section('2. getText:重定向与非 200')
  {
    reset()
    plans = [
      { statusCode: 302, headers: { location: 'https://example.test/final' } },
      { statusCode: 200, body: 'done' }
    ]
    const text = await getText('https://example.test/start')
    ok(text === 'done', '跟随重定向后返回最终内容', text)
    ok(getCalls.length === 2, '发了两次请求', String(getCalls.length))
    ok(getCalls[1].url === 'https://example.test/final', '第二次请求打到 location', getCalls[1].url)

    reset()
    plans = [{ statusCode: 404, body: 'nope' }]
    const out = await outcome(getText('https://example.test/missing'))
    ok(/^rejected:HTTP 404/.test(out), '非 200 时拒绝并带状态码', out)
    ok(out.includes('https://example.test/missing'), '错误信息里带 URL', out)
  }

  // ---------- 3. getJson ----------
  section('3. getJson')
  {
    reset()
    plans = [{ statusCode: 200, body: '{"a":1,"b":"x"}' }]
    const obj = await getJson('https://example.test/j')
    ok(obj.a === 1 && obj.b === 'x', '解析出对象', JSON.stringify(obj))

    reset()
    plans = [{ statusCode: 200, body: 'not json' }]
    const out = await outcome(getJson('https://example.test/bad'))
    ok(/^rejected:响应解析失败/.test(out), '非法 JSON 时给出可读错误', out)
  }

  // ---------- 4. 代理:校验与隧道 ----------
  section('4. 代理分支')
  {
    // 无代理 → 直连(上面已覆盖);这里验证「代理地址无效」
    reset()
    settings = { proxy: 'not a url' }
    const out1 = await outcome(getText('https://example.test/p'))
    ok(/^rejected:代理地址无效/.test(out1), '代理地址非法时拒绝并说明', out1)
    ok(getCalls.length === 0, '非法代理不会去直连', String(getCalls.length))

    reset()
    settings = { proxy: 'https://127.0.0.1:8080' }
    const out2 = await outcome(getText('https://example.test/p'))
    ok(/仅支持 HTTP 代理/.test(out2), '拒绝非 http 代理(提示原因)', out2)

    // 合法 http 代理 → 走 CONNECT 隧道
    reset()
    settings = { proxy: 'http://127.0.0.1:8080' }
    plans = [{ statusCode: 200, body: 'via-proxy' }]
    const p = getText('https://example.test/tunnel')
    await sleep(30)
    ok(connectCalls.length === 1, '向代理发起一次 CONNECT', String(connectCalls.length))
    const req = connectCalls[0]
    ok(req.method === 'CONNECT', '方法是 CONNECT', String(req.method))
    ok(req.path === 'example.test:443', 'CONNECT 目标为 host:443', String(req.path))
    ok(req.host === '127.0.0.1' && req.port === 8080, '连到代理主机与端口', `${req.host}:${req.port}`)
    ok(req.headers.Host === 'example.test:443', 'CONNECT 带 Host 头')
    ok(getCalls.length === 0, '隧道未建立前不会去直连')
    void p
    await sleep(10)

    // 带凭据的代理 → Proxy-Authorization
    reset()
    settings = { proxy: 'http://user:p%40ss@127.0.0.1:3128' }
    const p2 = getText('https://example.test/auth')
    await sleep(30)
    const auth = connectCalls[0].headers['Proxy-Authorization']
    ok(!!auth && auth.startsWith('Basic '), '带凭据的代理加上 Proxy-Authorization', String(auth))
    const decoded = Buffer.from(String(auth).slice(6), 'base64').toString('utf8')
    ok(decoded === 'user:p@ss', '凭据做了 URL 解码', decoded)
    void p2
    await sleep(10)

    // settings 读取异常时不用代理(fail-open)
    reset()
    settings = { proxy: 123 }
    plans = [{ statusCode: 200, body: 'no-proxy' }]
    const text = await getText('https://example.test/nohtml')
    ok(text === 'no-proxy', 'proxy 不是字符串时按直连处理', text)
    ok(connectCalls.length === 0, '也不会走代理')
  }

  // ---------- 5. downloadFile 成功路径 ----------
  section('5. downloadFile:成功下载')
  {
    reset()
    const file = dest('ok.bin')
    const progress = []
    plans = [{ statusCode: 200, headers: { 'content-length': '5' }, body: 'hello' }]
    const h = downloadFile('https://example.test/f.zip', file, { onProgress: (r, t) => progress.push([r, t]) })
    ok(typeof h.cancel === 'function' && h.promise instanceof Promise, '返回 { promise, cancel }')
    await h.promise
    ok(fs.readFileSync(file, 'utf8') === 'hello', '写入了完整内容')
    ok(progress.length >= 1, '至少报一次进度', JSON.stringify(progress))
    ok(progress[progress.length - 1][0] === 5, '最终进度为已收字节数', JSON.stringify(progress))
    ok(progress[progress.length - 1][1] === 5, '总大小取自 content-length', JSON.stringify(progress))

    // content-length 缺失时用 opts.total 兜底
    reset()
    const f2 = dest('fallback.bin')
    const prog2 = []
    plans = [{ statusCode: 200, headers: {}, body: 'abc' }]
    await downloadFile('https://example.test/g.zip', f2, { total: 999, onProgress: (r, t) => prog2.push([r, t]) }).promise
    ok(prog2[prog2.length - 1][1] === 999, '无 content-length 时用 opts.total', JSON.stringify(prog2))

    // 重定向后下载
    reset()
    const f3 = dest('redirect.bin')
    plans = [
      { statusCode: 301, headers: { location: 'https://cdn.test/x.zip' } },
      { statusCode: 200, headers: { 'content-length': '2' }, body: 'ok' }
    ]
    await downloadFile('https://example.test/r.zip', f3).promise
    ok(fs.readFileSync(f3, 'utf8') === 'ok', '跟随重定向后写入内容')
    ok(getCalls[1].url === 'https://cdn.test/x.zip', '第二次请求打到新地址')
  }

  // ---------- 6. downloadFile 失败路径 ----------
  section('6. downloadFile:各类失败')
  {
    reset()
    plans = [{ statusCode: 404 }]
    let out = await outcome(downloadFile('https://example.test/404.zip', dest('a.bin')).promise)
    ok(/^rejected:下载失败 HTTP 404/.test(out), '非 200 时拒绝', out)

    reset()
    plans = [{ netError: 'boom' }]
    out = await outcome(downloadFile('https://example.test/net.zip', dest('b.bin')).promise)
    ok(/^rejected:网络错误: boom/.test(out), '网络错误包装为可读信息', out)

    // 重定向次数过多:连续 7 次 302
    reset()
    plans = Array.from({ length: 8 }, (_, i) => ({
      statusCode: 302,
      headers: { location: `https://example.test/hop${i}` }
    }))
    out = await outcome(downloadFile('https://example.test/loop.zip', dest('c.bin')).promise)
    ok(/^rejected:重定向次数过多/.test(out), '重定向超过 5 次后放弃', out)
  }

  // ---------- 7. downloadFile 取消(回归:曾永久悬空) ----------
  section('7. downloadFile.cancel:必须了结 promise')
  {
    reset()
    const file = dest('cancel.bin')
    plans = [{ statusCode: 200, headers: {}, hang: true }]
    const h = downloadFile('https://example.test/slow.zip', file, {})
    await sleep(30)
    h.cancel()
    const out = await outcome(h.promise)
    ok(
      out === 'rejected:已取消',
      '取消后 promise 以「已取消」拒绝(修复前会永久悬空,导致下载队列卡死)',
      out
    )
    ok(!fs.existsSync(file), '取消后清掉半成品文件')

    // 取消后在下一个分片/重试点也不会重新开始
    reset()
    const f2 = dest('cancel2.bin')
    plans = [{ statusCode: 200, headers: {}, hang: true }]
    const h2 = downloadFile('https://example.test/slow2.zip', f2, {})
    await sleep(20)
    h2.cancel()
    h2.cancel() // 重复取消不应抛错或改变结局
    const out2 = await outcome(h2.promise)
    ok(out2 === 'rejected:已取消', '重复取消幂等', out2)

    // 已成功完成后再取消:不能把已 resolve 的 promise 翻成 reject
    reset()
    const f3 = dest('done-then-cancel.bin')
    plans = [{ statusCode: 200, headers: { 'content-length': '2' }, body: 'ok' }]
    const h3 = downloadFile('https://example.test/done.zip', f3, {})
    await h3.promise
    h3.cancel()
    const out3 = await outcome(h3.promise)
    ok(out3 === 'resolved', '已完成的任务调用 cancel 不会翻案', out3)
    ok(!fs.existsSync(f3), '但会按取消语义清掉文件(既有行为)')
  }

  // ---------- 8. 取消后的后续请求 ----------
  section('8. 取消后不再发起新请求')
  {
    reset()
    const file = dest('cancel-redirect.bin')
    // 第一次响应是重定向,但在其到达前就取消
    plans = [
      { statusCode: 302, headers: { location: 'https://example.test/next' } },
      { statusCode: 200, headers: {}, body: 'should-not-happen' }
    ]
    const h = downloadFile('https://example.test/start.zip', file, {})
    h.cancel()
    const out = await outcome(h.promise)
    ok(out === 'rejected:已取消', '取消立即了结', out)
    await sleep(30)
    ok(getCalls.length <= 1, '不会因为重定向再发第二次请求', String(getCalls.length))
  }

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
