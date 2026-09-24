// fsutil.js 回归测试:文件系统工具与「分片让出事件循环」机制。
//
// 这个模块此前只被 backup.test.js 间接覆盖。它其实是全项目最容易踩环境坑的地方:
//   · yieldToLoop 的三级降级链(setImmediate → MessageChannel → setTimeout)——
//     沙箱里没有 setImmediate,写错就是「本地全绿、宿主里一打开就报错」
//   · 取消令牌的 lock 语义(进入不可回滚阶段后必须拒绝取消,且要清掉已排队的取消)
//   · 路径与名称处理(Windows 非法字符、同秒重名、临时产物命名)
//
// 用法:
//   node src-ztools/preload/lib/__tests__/fsutil.test.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const LIB = path.resolve(__dirname, '..')
const F = require(path.join(LIB, 'fsutil.js'))

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

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-fsutil-test-'))

/** 建一棵临时目录树 */
function makeTree(name, spec) {
  const root = path.join(WORK, name)
  for (const [rel, content] of Object.entries(spec)) {
    const abs = path.join(root, ...rel.split('/'))
    if (content === null) fs.mkdirSync(abs, { recursive: true })
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    }
  }
  return root
}

async function main() {
  // ---------- 1. 名称与时间戳 ----------
  section('1. sanitizeName / stamp / stampSec')
  ok(F.sanitizeName('My:Game?') === 'My_Game_', 'Windows 非法字符替换为下划线', F.sanitizeName('My:Game?'))
  ok(F.sanitizeName('  a/b\\c  ') === 'a_b_c', '斜杠与反斜杠也替换,并 trim', F.sanitizeName('  a/b\\c  '))
  ok(F.sanitizeName('') === 'project', '空串回退为 project')
  ok(F.sanitizeName(null) === 'project', 'null 回退为 project')
  ok(F.sanitizeName('project') === 'project', '正常名称原样返回')
  ok(F.sanitizeName('a*b"c<d>e|f') === 'a_b_c_d_e_f', '其余非法字符逐个替换', F.sanitizeName('a*b"c<d>e|f'))

  ok(/^\d{8}_\d{4}$/.test(F.stamp()), 'stamp 形如 YYYYMMDD_HHmm', F.stamp())
  // 注意实际格式是 YYYYMMDD_HHmm_ss(三段),不是注释里曾写的 YYYYMMDD_HHmmss
  ok(/^\d{8}_\d{4}_\d{2}$/.test(F.stampSec()), 'stampSec 形如 YYYYMMDD_HHmm_ss', F.stampSec())
  ok(F.stampSec().startsWith(F.stamp() + '_'), 'stampSec 以 stamp + 下划线为前缀(同分钟可比较)')

  // ---------- 2. 路径工具 ----------
  section('2. tempPath / uniquePath')
  ok(F.tempPath('E:\\B', 'bt-1', false) === path.join('E:\\B', '.gpm-tmp-bt-1.zip'), '文件用 .zip 后缀', F.tempPath('E:\\B', 'bt-1', false))
  ok(F.tempPath('E:\\B', 'bt-1', true) === path.join('E:\\B', '.gpm-tmp-bt-1'), '目录不带后缀')
  ok(F.tempPath('/tmp/b', 'x', false).includes('.gpm-tmp-'), '临时产物带可识别前缀')

  const t = makeTree('unique', { 'a.zip': 'x' })
  const p1 = path.join(t, 'a.zip')
  ok(F.uniquePath(path.join(t, 'nope.zip')) === path.join(t, 'nope.zip'), '不冲突时原样返回')
  ok(F.uniquePath(p1) === path.join(t, 'a_2.zip'), '已存在时追加 _2(保留扩展名)', F.uniquePath(p1))
  fs.writeFileSync(path.join(t, 'a_2.zip'), 'x')
  ok(F.uniquePath(p1) === path.join(t, 'a_3.zip'), '_2 也占用时顺延到 _3', F.uniquePath(p1))
  const d = path.join(t, 'somedir')
  fs.mkdirSync(d)
  ok(F.uniquePath(d) === `${d}_2`, '目录(无扩展名)追加在末尾', F.uniquePath(d))

  // ---------- 3. 排除器 ----------
  section('3. makeExcluder:仅目录、大小写不敏感')
  ok(F.makeExcluder() === null, '未配置时返回 null(调用方据此跳过过滤)')
  ok(F.makeExcluder([]) === null, '空数组返回 null')
  ok(F.makeExcluder(['']) === null, '全是空串也返回 null')
  const ex = F.makeExcluder(['.git', 'build'])
  ok(!!ex, '给了名字则返回函数')
  ok(ex('.git', true) === true, '命中排除目录')
  ok(ex('.GIT', true) === true, '大小写不敏感', String(ex('.GIT', true)))
  ok(ex('.git', false) === false, '同名文件不排除(只按目录名匹配)')
  ok(ex('src', true) === false, '未列入的目录不排除')
  const ex2 = F.makeExcluder(['build', null, undefined, ''])
  ok(ex2('build', true) === true, '列表里的空值被过滤掉,不影响其余项')

  // ---------- 4. 取消令牌 ----------
  section('4. createCancelToken / checkCancel')
  {
    const tok = F.createCancelToken()
    ok(tok.isCanceled() === false, '初始未取消')
    ok(tok.locked === false, '初始未锁定')
    F.checkCancel(tok)
    ok(true, '未取消时 checkCancel 不抛')

    ok(tok.cancel() === true, 'cancel 返回 true')
    ok(tok.isCanceled() === true, '取消后 isCanceled 为真')
    let threw = null
    try {
      F.checkCancel(tok)
    } catch (e) {
      threw = e
    }
    ok(!!threw, '已取消时 checkCancel 抛错')
    ok(threw instanceof F.CanceledError, '抛的是 CanceledError', threw && threw.constructor.name)
    ok(threw.canceled === true && threw.name === 'CanceledError', '错误对象带 canceled 标记与名字')
    ok(/已取消/.test(threw.message), '默认消息为「已取消」', threw.message)

    // lock:进入不可回滚阶段后拒绝取消,并清掉已排队的取消
    const t2 = F.createCancelToken()
    t2.cancel()
    ok(t2.isCanceled() === true, '前置:已请求取消')
    t2.lock()
    ok(t2.locked === true, 'lock 后标记为已锁定')
    ok(t2.isCanceled() === false, 'lock 清掉已请求的取消(替换阶段不可被打断)')
    ok(t2.cancel() === false, 'lock 后 cancel 被拒绝并返回 false')
    F.checkCancel(t2)
    ok(true, 'lock 后 checkCancel 不抛(任务可继续跑完)')

    // checkCancel 对 null/undefined 安全
    F.checkCancel(null)
    F.checkCancel(undefined)
    ok(true, 'checkCancel 对空令牌安全')
  }

  // ---------- 5. yieldToLoop 降级链 ----------
  section('5. yieldToLoop:三级降级链(沙箱坑的守门测试)')
  {
    // 1) 默认环境(Node 有 setImmediate)
    await F.yieldToLoop()
    ok(true, '默认路径可让出事件循环')

    // 2) 模拟 ZTools 沙箱:删掉 setImmediate → 走 MessageChannel
    const savedImmediate = globalThis.setImmediate
    delete globalThis.setImmediate
    let okChannel = false
    try {
      await F.yieldToLoop()
      okChannel = true
    } catch (e) { /* ignore */ }
    ok(okChannel, '无 setImmediate 时仍能让出(MessageChannel 分支)')
    ok(typeof MessageChannel === 'function', '前提:当前 Node 有 MessageChannel')

    // 3) 最极端:MessageChannel 也没有 → setTimeout 兜底
    const savedChannel = globalThis.MessageChannel
    delete globalThis.MessageChannel
    let okTimeout = false
    try {
      await F.yieldToLoop()
      okTimeout = true
    } catch (e) { /* ignore */ }
    ok(okTimeout, 'setImmediate 与 MessageChannel 都缺时用 setTimeout 兜底')

    // 恢复
    globalThis.setImmediate = savedImmediate
    globalThis.MessageChannel = savedChannel
    let restored = false
    try {
      await F.yieldToLoop()
      restored = true
    } catch (e) { /* ignore */ }
    ok(restored, '恢复全局后仍可让出')

    // 并发让出不会互相覆盖回调(队列而非单变量)
    delete globalThis.setImmediate
    const order = []
    await Promise.all([
      F.yieldToLoop().then(() => order.push(1)),
      F.yieldToLoop().then(() => order.push(2)),
      F.yieldToLoop().then(() => order.push(3))
    ])
    globalThis.setImmediate = savedImmediate
    ok(order.length === 3, '并发让出全部完成(回调未互相覆盖)', order.join(','))
  }

  // ---------- 6. forEachSliced ----------
  section('6. forEachSliced:分片、让出与取消')
  {
    const items = Array.from({ length: 10 }, (_, i) => i)
    const seen = []
    await F.forEachSliced(items, (x, i) => seen.push(`${i}:${x}`), { sliceFiles: 3 })
    ok(seen.length === 10, '每项都被处理', String(seen.length))
    ok(seen[0] === '0:0' && seen[9] === '9:9', '顺序与索引正确')

    // 取消:在分片边界后被检查到
    const token = F.createCancelToken()
    token.cancel()
    let threw = null
    try {
      await F.forEachSliced(items, () => {}, { token, sliceFiles: 3 })
    } catch (e) {
      threw = e
    }
    ok(threw instanceof F.CanceledError, '已取消时在分片边界抛出 CanceledError', threw && threw.constructor.name)

    // 只有一项时不触发让出,也就不会检查取消(与原实现一致)
    let singleThrew = false
    try {
      await F.forEachSliced([1], () => {}, { token, sliceFiles: 1 })
    } catch (e) {
      singleThrew = true
    }
    ok(singleThrew === false, '单项任务不触发让出、不检查取消')

    // 空列表安全
    await F.forEachSliced([], () => { throw new Error('不该被调用') })
    ok(true, '空列表不调用 handler')

    // sliceMs=0:即使没到 sliceFiles,每个非末项后都会让出(覆盖「单个超大文件不让出」的防护)
    let handled = 0
    await F.forEachSliced([1, 2, 3, 4], () => { handled++ }, { sliceFiles: 1000, sliceMs: 0 })
    ok(handled === 4, 'sliceMs=0 时仍处理完全部项', String(handled))
  }

  // ---------- 7. walkFiles ----------
  section('7. walkFiles:递归收集与排除')
  {
    const root = makeTree('walk', {
      'project.godot': 'x',
      'scenes/main.tscn': 'x',
      'addons/demo/plugin.cfg': 'x',
      '.godot/imported/a.ctex': 'x',
      'build/out.exe': 'x'
    })
    const all = F.walkFiles(root)
    const rels = all.map((f) => f.rel).sort()
    ok(rels.includes('project.godot'), '收集到根文件')
    ok(rels.includes('scenes/main.tscn'), 'rel 用 / 分隔的子目录文件', rels.join(','))
    ok(rels.some((r) => r.startsWith('.godot/')), '默认包含 .godot 缓存')

    const noCache = F.walkFiles(root, { includeCache: false }).map((f) => f.rel)
    ok(!noCache.some((r) => r.startsWith('.godot/')), 'includeCache=false 时跳过 .godot')
    ok(noCache.length === rels.length - 1, '只少了缓存那一项', String(noCache.length))

    const excluded = F.walkFiles(root, { exclude: F.makeExcluder(['build', '.godot']) }).map((f) => f.rel)
    ok(!excluded.some((r) => r.startsWith('build/')), '排除 build 目录')
    ok(!excluded.some((r) => r.startsWith('.godot/')), '排除 .godot 目录')
    ok(excluded.includes('addons/demo/plugin.cfg'), '未排除的目录仍在内')

    // 不存在的目录:walkFiles 内部不做 try/catch,会直接抛 ENOENT。
    // 这是既有行为(调用方负责先确认目录存在),这里钉住以免被无声改掉。
    let missingThrew = null
    try {
      F.walkFiles(path.join(WORK, 'definitely-missing'))
    } catch (e) {
      missingThrew = e
    }
    ok(!!missingThrew, '不存在的目录会抛错(调用方负责先校验)')
    ok(/ENOENT/.test(missingThrew && missingThrew.code ? missingThrew.code : ''), '抛的是 ENOENT', String(missingThrew && missingThrew.code))
  }

  // ---------- 8. estimateTree / copyTree ----------
  section('8. estimateTree / copyTree')
  {
    const src = makeTree('src-tree', {
      'project.godot': 'aaaa',
      'scenes/main.tscn': 'bb',
      'addons/demo/plugin.cfg': 'c',
      '.godot/cache.bin': 'dddddd'
    })

    const est = await F.estimateTree(src)
    ok(est.fileCount === 4, '统计全部文件数(含缓存)', String(est.fileCount))
    ok(est.bytes === 4 + 2 + 1 + 6, '统计字节数', String(est.bytes))

    const estNo = await F.estimateTree(src, { includeCache: false })
    ok(estNo.fileCount === 3, 'includeCache=false 时不计缓存', String(estNo.fileCount))

    const phases = []
    await F.estimateTree(src, { onProgress: (p) => phases.push(p.phase) })
    ok(phases.length === 4 && phases.every((p) => p === 'scanning'), '预估进度阶段为 scanning', phases.join(','))

    // 复制
    const dest = path.join(WORK, 'dest-tree')
    const prog = []
    const copied = await F.copyTree(src, dest, { includeCache: false, onProgress: (p) => prog.push(p) })
    ok(copied.fileCount === 3, '复制跳过缓存后的文件数', String(copied.fileCount))
    ok(fs.existsSync(path.join(dest, 'project.godot')), '根文件已复制')
    ok(fs.existsSync(path.join(dest, 'addons', 'demo', 'plugin.cfg')), '子目录结构已保留')
    ok(!fs.existsSync(path.join(dest, '.godot')), '缓存目录未被复制')
    ok(prog.length === 3, '每个文件报一次进度', String(prog.length))
    ok(prog[prog.length - 1].done === 3 && prog[prog.length - 1].total === 3, '进度计到总数')
    ok(prog[0].phase === 'copying', '默认阶段为 copying', prog[0].phase)
    ok(copied.bytes === 4 + 2 + 1, '复制字节数与预估一致(不含缓存)', String(copied.bytes))

    // 复制可取消(在分片边界)
    const token = F.createCancelToken()
    token.cancel()
    let threw = null
    try {
      await F.copyTree(src, path.join(WORK, 'dest-cancel'), { token, sliceFiles: 1 })
    } catch (e) {
      threw = e
    }
    ok(threw instanceof F.CanceledError, '复制过程中取消会抛 CanceledError', threw && threw.constructor.name)
  }

  // ---------- 9. rmQuiet ----------
  section('9. rmQuiet:静默删除')
  {
    const p = path.join(WORK, 'to-remove.txt')
    fs.writeFileSync(p, 'x')
    F.rmQuiet(p)
    ok(!fs.existsSync(p), '删除存在的文件')
    F.rmQuiet(p)
    ok(true, '删除不存在的路径不抛错')
    F.rmQuiet('')
    F.rmQuiet(null)
    F.rmQuiet(undefined)
    ok(true, '空值安全')

    const dir = path.join(WORK, 'dir-to-remove')
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sub', 'f'), 'x')
    F.rmQuiet(dir)
    ok(!fs.existsSync(dir), '递归删除目录')
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
  // 第 5 节跑过 MessageChannel 分支,该端口刻意 unref 之外地维持着事件循环
  // (见 fsutil.getChannel 的注释),必须显式退出,否则进程会挂住。
  process.exit(0)
}

main().catch((e) => {
  console.error('\n未捕获异常:', e)
  process.exit(1)
})
