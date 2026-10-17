// http.js 的 POST 路径回归测试(与 http.test.js 分开,因为注入的假 https 形状不同)。
//
// 这条链路只有一个消费者:翻译。它承重的地方有两处:
//   1. **err.status** —— translate.js 靠 401/403 决定「暂停,别再烧钱」,状态码被吞掉
//      用户看到的就是每次翻页都失败却不知道为什么;
//   2. **代理路径的请求体缓冲** —— 隧道是异步建立的,而调用方是同步 write/end 的。
//      真机上「测试连接」报过 `req.write is not a function`,就是漏了这一步。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/transhttp.test.js
const path = require('node:path')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')

const LIB = path.resolve(__dirname, '..')

/** 每次请求记录的入参 */
const sent = []
/** 下一条响应怎么回 */
let plan = { statusCode: 200, body: '{}' }
/** 当前代理设置(store.getDoc 的返回值) */
let settings = null
/** CONNECT 调用记录 */
const connectCalls = []

function makeRes(p) {
  if (p.hang) {
    const r = new Readable({ read() {} })
    r.statusCode = p.statusCode || 200
    r.headers = {}
    return r
  }
  const r = Readable.from([Buffer.from(p.body || '')])
  r.statusCode = p.statusCode || 200
  r.headers = p.headers || {}
  return r
}

/** 造一个请求句柄:累积 write,在 end 时按 plan 回响应 */
function makeReq(args, cb) {
  const req = new EventEmitter()
  req.opts = typeof args[0] === 'string' ? args[1] : args[0]
  req.url = typeof args[0] === 'string' ? args[0] : undefined
  req.body = ''
  req.destroy = () => { req.destroyed = true }
  req.setTimeout = (ms, fn) => { req.timeoutMs = ms; req.timeoutFn = fn }
  req.write = (buf) => { req.body += String(buf) }
  req.end = () => {
    req.ended = true
    sent.push({ url: String(req.url || ''), opts: req.opts, body: req.body })
    const p = plan
    if (p.throwSync) throw p.throwSync()
    setImmediate(() => {
      if (p.netError) return req.emit('error', new Error(p.netError))
      if (p.timeout) return req.timeoutFn && req.timeoutFn()
      cb(makeRes(p))
    })
  }
  return req
}

const fakeHttps = {
  request(...args) {
    const cb = args[args.length - 1]
    return makeReq(args, typeof cb === 'function' ? cb : () => {})
  }
}

/** 代理的 CONNECT 请求:end() 后异步回 200 + 一个假 socket */
const fakeHttp = {
  request(opts) {
    const req = new EventEmitter()
    req.opts = opts
    req.destroy = () => { req.destroyed = true }
    req.end = () => {
      connectCalls.push(opts)
      const socket = { destroy: () => {} }
      setImmediate(() => {
        if (plan.connectError) return req.emit('error', new Error(plan.connectError))
        req.emit('connect', { statusCode: plan.connectStatus || 200 }, socket)
      })
    }
    return req
  }
}

/** TLS:secureConnect 异步触发,模拟真实握手 */
const fakeTls = {
  connect() {
    const sock = new EventEmitter()
    sock.destroy = () => {}
    setImmediate(() => sock.emit('secureConnect'))
    return sock
  }
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  const file = (parent && parent.filename) || ''
  if (/http\.js$/.test(file)) {
    if (request === './store') return { getDoc: () => settings }
    if (request === 'node:https') return fakeHttps
    if (request === 'node:http') return fakeHttp
    if (request === 'node:tls') return fakeTls
  }
  return origLoad.apply(this, arguments)
}

const { postJson } = require(path.join(LIB, 'http.js'))

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
function reset() {
  sent.length = 0
  connectCalls.length = 0
  settings = null
}
const outcome = (p, ms = 600) =>
  Promise.race([
    p.then((v) => ({ state: 'resolved', value: v }), (e) => ({ state: 'rejected', error: e })),
    new Promise((r) => setTimeout(() => r({ state: 'pending' }), ms))
  ])

async function main() {
  section('1. 直连成功:方法/头/body 都是 POST')
  {
    reset()
    plan = { statusCode: 200, body: '{"ok":true,"value":42}' }
    const json = await postJson('https://api.test/v1/chat', { a: 1 }, { Authorization: 'Bearer k' })
    ok(json && json.value === 42, '解析出响应 JSON', JSON.stringify(json))
    ok(sent[0].opts.method === 'POST', '方法为 POST', String(sent[0].opts.method))
    ok(sent[0].opts.headers['Content-Type'] === 'application/json', '带 JSON 内容类型')
    ok(sent[0].opts.headers.Authorization === 'Bearer k', '自定义头被带上', JSON.stringify(sent[0].opts.headers))
    ok(sent[0].body === '{"a":1}', 'body 是序列化后的 JSON', sent[0].body)
    ok(Number(sent[0].opts.headers['Content-Length']) === Buffer.byteLength('{"a":1}'), 'Content-Length 按字节数给')
    ok(sent[0].opts.headers['User-Agent'] === 'ztools-godot-plugin', '默认 UA 仍在')
  }

  section('2. 401:状态码必须带到 err.status 上')
  {
    reset()
    plan = { statusCode: 401, body: '{"error":{"message":"invalid key"}}' }
    const out = await outcome(postJson('https://api.test/v1/chat', {}))
    ok(out.state === 'rejected', '非 2xx 抛错', out.state)
    ok(out.error && out.error.status === 401, 'err.status === 401(translate.js 靠它决定暂停)', String(out.error && out.error.status))
    ok(/invalid key/.test(out.error.message), '错误体片段进了消息,能看出是密钥问题', out.error.message)
  }

  section('3. 429 与 5xx 同样带状态码(可重试,不致命)')
  {
    reset()
    plan = { statusCode: 429, body: 'rate limited' }
    const out = await outcome(postJson('https://api.test/v1/chat', {}))
    ok(out.state === 'rejected' && out.error.status === 429, '429 带状态码', String(out.error && out.error.status))
  }

  section('4. 非 JSON 响应 / 网络错误 / 超时')
  {
    reset()
    plan = { statusCode: 200, body: 'not json' }
    const out1 = await outcome(postJson('https://api.test/v1/chat', {}))
    ok(out1.state === 'rejected' && /响应解析失败/.test(out1.error.message), '非 JSON 给出可读错误', out1.error.message)

    reset()
    plan = { netError: 'connection reset' }
    const out2 = await outcome(postJson('https://api.test/v1/chat', {}))
    ok(out2.state === 'rejected' && /网络错误: connection reset/.test(out2.error.message), '网络错误被包装', out2.error.message)

    reset()
    plan = { timeout: true }
    const out3 = await outcome(postJson('https://api.test/v1/chat', {}, undefined, { timeoutMs: 50 }))
    ok(out3.state === 'rejected' && /请求超时/.test(out3.error.message), '超时会了结 promise(不悬空)', out3.error.message)
  }

  section('5. 代理路径:CONNECT 隧道 + 请求体缓冲(真机回归:req.write is not a function)')
  {
    reset()
    settings = { proxy: 'http://127.0.0.1:7897' }
    plan = { statusCode: 200, body: '{"ok":true,"proxied":true}' }
    const out = await outcome(postJson('https://api.deepseek.com/chat/completions', { hello: 'world' }))
    ok(out.state === 'resolved' && out.value.proxied === true, '经代理的 POST 能拿到响应', JSON.stringify(out))
    ok(connectCalls.length === 1 && connectCalls[0].method === 'CONNECT', '先发一次 CONNECT', String(connectCalls.length))
    ok(connectCalls[0].path === 'api.deepseek.com:443', 'CONNECT 目标正确', String(connectCalls[0].path))
    // 请求体是**隧道建立后**补发的:这里断言它没有丢
    const tunneled = sent.filter((s) => s.opts && s.opts.method === 'POST')
    ok(tunneled.length === 1 && tunneled[0].body === '{"hello":"world"}',
      '请求体在隧道就绪后被完整补发(同步 write 不丢)', JSON.stringify(tunneled.map((t) => t.body)))

    // 代理连不上:应把错误交回,而不是永久挂着
    reset()
    settings = { proxy: 'http://127.0.0.1:7897' }
    plan = { connectError: 'ECONNREFUSED' }
    const out2 = await outcome(postJson('https://api.test/v1/chat', {}))
    ok(out2.state === 'rejected' && /ECONNREFUSED/.test(out2.error.message), '代理拒绝连接时立即报错', JSON.stringify(out2))
  }

  console.log(`\n${'='.repeat(56)}`)
  console.log(`PASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) {
    console.log('失败项:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('全部通过')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
