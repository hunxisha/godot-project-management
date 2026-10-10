// 桌面版垫片的「诚实」红线(静态扫描)。
//
// 为什么只能扫源码:垫片是 index.html 的浏览器全局脚本(第 6 行 `!window.__TAURI__` 直接让位),
// 里面全是 invoke/事件监听,Node 里载不进来,做不了运行时断言。同 format.test.mjs:741-744 的先例。
//
// 为什么需要这条规则(2026-10-09 一次审计里连踩三个):
//   1. `toggleFavorite: () => Promise.resolve(true)` —— 市场收藏既不写库又报成功;
//   2. `docsToggleFavorite: (… ) => invoke('db_put', …).then(() => ({ ok: true }))` —— 入参全丢,
//      而且不带 _rev 对已存在的文档必 conflict。关键是 **Rust 侧把失败当返回值送回来**
//      (store.rs:31-33 是 `{error:true,name,message}` 正常 resolve,不是 rejection),
//      于是 `.then(() => ok:true)` 和 `.catch` 两边都接不到失败,永远报成功;
//   3. `checkAddonUpdate: () => ({ hasUpdate: false })` —— 一条都没查,界面却说「所有插件均为最新版本」。
// 三条是同一个形状:**没做事却给出肯定式判定**。这里把判定写成句法,让下一次写桩时当场红。
//
// 用法: node src/__tests__/tauriShimHonesty.test.mjs
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHIM = path.resolve(__dirname, '../public/tauri-shim.js')
const SRC = readFileSync(SHIM, 'utf8')
const ROOT = path.resolve(__dirname, '../..')
/** vite.config.js 的**生效**配置(直接 import,不正则读文本 —— 改写法不该把断言带红) */
const VCFG = (await import(pathToFileURL(path.join(ROOT, 'vite.config.js')).href)).default

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}  → ${extra}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

/**
 * index.html 里指向垫片的脚本 src。只认**非 module 的经典脚本**:垫片必须在主包之前同步跑完
 * (构造 window.ztools/window.services),写成 type="module" 就变成异步,主包先执行。
 */
const shimTagSrc = (html) => {
  const m = /<script\b(?![^>]*type=["']module)[^>]*\bsrc=["']([^"']*tauri-shim\.js)["']/.exec(html)
  return m ? m[1] : null
}
/** Vite 生效的 publicDir:配置没写就是默认的 `<root>/public`(Vite 不会报错,只是永远取不到文件)。 */
const publicDirOf = (cfg) =>
  typeof cfg.publicDir === 'string' ? path.resolve(ROOT, cfg.publicDir) : path.join(ROOT, 'public')
/** 浏览器按 index.html 里那个 src 发请求时,Vite 实际送出的那个文件。 */
const servedShim = (cfg, src) => (src ? path.join(publicDirOf(cfg), path.posix.basename(src)) : '')

// ---------- 拆出 services 注册块里每个方法的函数体 ----------
// 方法一律缩进 4 空格(嵌套字面量更深),按缩进切即可。整块从 `window.services = {` 起算:
// 上面的 window.ztools 门面是 db 的裸透传,判定归调用方,不在本规则范围内。
// 注释行不进函数体 —— 它们顶着下一个方法,算进去会让解释性文字变成假阳性。
const start = SRC.indexOf('window.services = {')
ok(start > 0, '找得到 window.services 的注册块', String(start))
const lines = SRC.slice(start).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))

/** @type {{name:string, body:string}[]} */
const methods = []
{
  let cur = null
  for (const l of lines) {
    const m = /^ {4}([A-Za-z_$][\w$]*): /.exec(l)
    if (m) {
      if (cur) methods.push(cur)
      cur = { name: m[1], body: l }
    } else if (cur) cur.body += '\n' + l
  }
  if (cur) methods.push(cur)
}
// 防「扫了个空」:方法数掉到个位数说明缩进或写法变了,那时本节会静默通过 —— 那不是通过。
ok(methods.length > 80, `拆出 ${methods.length} 个方法(不足 81 个说明切分失效,而不是宿主变干净了)`,
  methods.slice(0, 5).map((x) => x.name).join(','))

/**
 * 已记名的欠账(不属于本轮修复范围,但也不许被当成通过)。
 * 改好一条就从这里删一条 —— 第 4 节会反向检查「名单里的条目是否还是债」,挂着不清同样红。
 */
const NAMED = {
  getAssetDetail: '取不到详情回 null(形状对了,但功能仍缺:等 Rust 侧抓取命令);原因由弹层按宿主说,不再是 TypeError',
  listExportHistory: '恒空列表:导出历史缺功能但不声明(等 Rust 侧命令;界面已按宿主标注不支持)',
  listAssetReleases: '恒空列表:版本选择会说成「没有可用版本」(界面已按宿主给如实文案,数据侧等命令)',
  getReleaseInfos: '恒空对象:卡片版本/兼容信息缺失(不构成假结论,等 Rust 侧 release 命令)',
  docsGetClassExtras: '回 null 且不说为什么(详情扩展区静默)',
  listBackupTasks: '恒空列表:桌面版任务走 watchBackupTasks 通道,视为如实,留此备案',
  // 这条不是欠账而是**形状盲区**:占位确实给了原因(见 tauri-shim.js 里 hardBlocks[0].why/action),
  // 但这条契约的返回类型是 { ok, issues, hardBlocks } —— 没有 error/problems 两个字段,
  // BARE 那条句法代理只认这两个键名,于是把「原因写在 TplIssue.why 里」读成了「不给原因」。
  // 不放宽 BARE(它抓的是真债),也不往契约里塞一个渲染层不读的 error 字段;记名等 Rust 侧命令,
  // 命令一注册,这个占位连同本条一起删(stale 反向检查会盯着)。
  // 记名的代价是「同一入口以后任何真债也会被放过」—— 那半边由第 5 节那条逐形状断言兜住(Ruling #61),
  // 所以这里挂名不等于免检。
  validateTemplateConfig: 'ok:false 的原因走契约自己的 hardBlocks[].why(BARE 只认 error/problems 两个键名);Rust 侧注册 validate_template_config 后连占位带这条一起删'
}

// 「做了事」的证据:真发命令、走那条带 _rev 的读-改-写辅助、或如实抛错。
const EFFECT = /\binvoke\(|\bputMerged\(|\breadThenPut\(|\bthrow\b/
const SUCCESS = /\bok:\s*true\b|=>\s*true\b|Promise\.resolve\(\s*true\s*\)/
// `.then(() => ({ ok: true }))` 的参数位是空的:IPC 的失败是**正常 resolve 的一个值**,不接住它就等于永远成功。
const DISCARD = /\.then\(\s*\(\)\s*=>\s*\(\s*\{\s*ok:\s*true/
const NOSOURCE = (body) => /hasUpdate:\s*false/.test(body) && !/\binvoke\(|\berror\b/.test(body)
const BARE = (body) => /\{\s*ok:\s*false\s*[,}]/.test(body) && !/\berror\b|\bproblems\b/.test(body)
/**
 * 「静默缺失」的形状:失败却不给原因 / 恒空的列表·对象·null / 干脆空操作。
 * 注意不含 `.catch(() => [])` —— 那是两端共有的取数兜底(preload 也这么吞,见 assetapi.js:105,225),
 * 不是桌面版独有的谎报,拿它算债会把名单糊成一片噪音。
 */
const looksLikeDebt = (body) => BARE(body)
  || /Promise\.resolve\(\s*(?:\[\s*\]|\{\s*\}|null)\s*\)/.test(body)
  || /:\s*\(\)\s*=>\s*\{\s*\}/.test(body)

section('0. 自检:规则抓得住本次审计里真实存在的三个旧形状')
// 这几条不是装饰:如果判定式被谁放松了,下面几节会一起变绿,而问题还在。
// 用的是 git 里真出现过的写法原文,不是编出来的反例。
{
  const FX_TOGGLE = `toggleFavorite: () => Promise.resolve(true),`
  ok(SUCCESS.test(FX_TOGGLE) && !EFFECT.test(FX_TOGGLE), '规则 1 抓得住「市场收藏」那条(既不写库又报成功)')
  const FX_DOCFAV = `docsToggleFavorite: (className, fav) => invoke('db_put', { doc: { _id: 'godot/docs-favorites', _rev: undefined } }).then(() => ({ ok: true })).catch(() => ({ ok: true })),`
  ok(DISCARD.test(FX_DOCFAV), '规则 1 抓得住「丢掉 IPC 返回值再报成功」(文档收藏那条)')
  ok(/invoke\(\s*'db_(put|remove)'/.test(FX_DOCFAV), '规则 3 也抓得住同一条裸 db_put(少 _rev 必 conflict)')
  const FX_CHECK = `checkAddonUpdate: () => Promise.resolve({ hasUpdate: false }),`
  ok(NOSOURCE(FX_CHECK), '规则 2 抓得住「没查却给结论」(检查更新那条)')
  const FX_CLEAN = `docsCleanCache: () => Promise.resolve({ ok: false }),`
  ok(BARE(FX_CLEAN), '规则 4 抓得住「失败但说不出原因」')
}

section('1. 没做事却宣布成功')
{
  const bad = methods.filter((m) => SUCCESS.test(m.body) && !EFFECT.test(m.body))
  ok(bad.length === 0, '不存在「无副作用的 ok:true」', bad.map((m) => m.name).join(','))

  const discard = methods.filter((m) => DISCARD.test(m.body))
  ok(discard.length === 0, '不存在「丢掉 IPC 返回值再报成功」', discard.map((m) => m.name).join(','))

  // 硬编码的空失败清单:批量动作里「有几条没成」必须数得出来。deleteBackups 原来就是这么写的。
  const fakeClean = methods.filter((m) => /failed:\s*\[\s*\]/.test(m.body))
  ok(fakeClean.length === 0, '不存在「硬编码 failed:[]」', fakeClean.map((m) => m.name).join(','))
}

section('2. 定性结论要么有出处、要么带原因')
{
  // hasUpdate:false 会被界面并进「所有插件均为最新版本」(useAddonActions.ts:203),
  // 所以它必须要么真查过(invoke),要么带 error 说明「没查成」。
  const verdict = methods.filter((m) => NOSOURCE(m.body))
  ok(verdict.length === 0, '不许出现「没查过也没给原因」的 hasUpdate:false', verdict.map((m) => m.name).join(','))

  // 同理:authenticated:false 会被设置页读成「密钥无效」;桌面版根本没这条通道,必须带原因。
  const auth = methods.filter((m) => /authenticated:\s*false/.test(m.body) && !/\binvoke\(|\berror\b/.test(m.body))
  ok(auth.length === 0, 'authenticated:false 要么有出处要么带原因(否则界面只有成功分支 = 点了没反应)',
    auth.map((m) => m.name).join(','))
}

section('3. 写库必须走带 _rev 的读-改-写')
{
  // 裸 db_put 少 _rev 对已存在的文档必 conflict(store.rs:98-101),整份替换还会抹掉没写进 body 的字段。
  const raw = methods.filter((m) => /invoke\(\s*'db_(put|remove)'/.test(m.body))
  ok(raw.length === 0, 'services 里不许出现裸 db_put/db_remove', raw.map((m) => m.name).join(','))
  // 反过来:辅助函数本身当然直接 invoke,确认那两条读-改-写还在(被删了就是规则空转)。
  ok(/const putMerged = /.test(SRC) && /const readThenPut = /.test(SRC),
    'putMerged / readThenPut 两个入口仍然存在(缺一节就成摆设)')
}

section('4. 静默缺失:只许是记名欠账,而且记了的必须还是债')
{
  const debts = methods.filter((m) => looksLikeDebt(m.body))
  const unknown = debts.filter((m) => !NAMED[m.name])
  ok(unknown.length === 0, '新出现的「静默缺失」算回归(要修,或写明理由记进名单)',
    unknown.map((m) => m.name).join(','))
  // 反向账:修好了却还挂在名单上,同样是被忽略的债 —— 名单不能只进不出。
  const stale = Object.keys(NAMED).filter((n) => {
    const m = methods.find((x) => x.name === n)
    return m && !looksLikeDebt(m.body)
  })
  ok(stale.length === 0, '名单里已有条目不再成立,应删掉', stale.join(','))
  const missing = Object.keys(NAMED).filter((n) => !methods.some((m) => m.name === n))
  ok(missing.length === 0, '名单条目要对应得上一个真方法(方法没了就说明名单该清)', missing.join(','))
  console.log(`  注:名单现有 ${Object.keys(NAMED).length} 条欠账(${Object.keys(NAMED).join(' / ')}),另检出 ${debts.length} 处静默形状`)
}

section('5. 返回形状要对得上契约(不是「像就行」)')
{
  // docsCacheInfo 原来回 { totalSize, libraries: 0 }:JS 侧是 { sizeBytes, libraries[] },
  // 于是设置页显示「共 0 B」,而清理按钮判据 `libraries.length` 落在数字 0 上 = undefined,永远禁用。
  // 键名错了不会有任何报错,只会长得像「没有缓存」——所以把键名钉住。
  const cache = methods.find((m) => m.name === 'docsCacheInfo')
  ok(!!cache && /sizeBytes/.test(cache.body) && /libraries:\s*\[\s*\]/.test(cache.body),
    'docsCacheInfo 用 JS 侧的键名与数组形状', cache ? cache.body.split('\n')[0].trim() : '没找到该方法')
  // getAssetDetail 取不到时要的是 null(调用点能分辨),不是一个假对象 —— 回 {ok:false} 会让
  // 弹层读 detail.media[0] 抛 TypeError,把内部错误显示给用户。
  const detail = methods.find((m) => m.name === 'getAssetDetail')
  ok(!!detail && /Promise\.resolve\(\s*null\s*\)/.test(detail.body) && !/ok:\s*false/.test(detail.body),
    'getAssetDetail 取不到回 null,不回带 ok 的假对象', detail ? detail.body.split('\n')[0].trim() : '没找到该方法')
  // Ruling #61:validateTemplateConfig 挂在 NAMED 名单上(名单记名的代价是**同一入口以后任何真债
  // 也会被这条记名放过**,而 BARE 本来就看不见写在 hardBlocks[].why 里的那个原因),所以这里按本节
  // 的办法逐形状钉住:占位必须给出**非空的 hardBlocks**,且那一条自带 why 与 skippable:false。
  // 占位退化成 `hardBlocks: []` 就是「ok:false 却一句为什么都不给」,名单救不了它。
  const vtc = methods.find((m) => m.name === 'validateTemplateConfig')
  ok(!!vtc && /hardBlocks:\s*\[\s*\{/.test(vtc.body) && /why:\s*'[^']+'/.test(vtc.body) && /skippable:\s*false/.test(vtc.body),
    'validateTemplateConfig 占位的 hardBlocks 非空且那条带 why/skippable(记名不等于免检)',
    vtc ? vtc.body.split('\n')[0].trim() : '没找到该方法')
}

section('6. 垫片必须真的被宿主取到(index.html 的 URL ↔ Vite publicDir 对得上)')
{
  // 为什么钉这条:垫片是桌面版**唯一**构造 window.ztools / window.services 的地方,它取不到就等于
  // 桌面版开屏即死。2026-10-11 的真事故正是这里 —— 垫片放在 src/public/,而 vite.config.js 从未配
  // publicDir,Vite 于是按默认的 <root>/public 找(该目录根本不存在),/tauri-shim.js 落到 SPA 回落
  // 返回 index.html(text/html),浏览器把 HTML 当 JS 解析报语法错,main.ts 的守卫弹「未检测到 ZTools 环境」。
  // 两端表现还不一样:ZTools 宿主自己注入 window.ztools,这个 404 完全看不出来 —— 只有桌面版会红。
  const src = shimTagSrc(readFileSync(path.join(ROOT, 'index.html'), 'utf8'))

  // 自检(同第 0 节的道理):判定式必须分得开「当年那条红路」和「修好」,否则这一节会静默通过。
  ok(servedShim({ publicDir: undefined }, '/tauri-shim.js') === path.join(ROOT, 'public', 'tauri-shim.js'),
    '自检:publicDir 缺省时判定的是 Vite 默认的 <root>/public', publicDirOf({}))
  ok(!existsSync(servedShim({ publicDir: undefined }, '/tauri-shim.js')),
    '自检:垫片不在 <root>/public 时判定为红(即事故当时的形态)', servedShim({ publicDir: undefined }, '/tauri-shim.js'))
  ok(shimTagSrc('<script type="module" src="/tauri-shim.js"></script>') === null,
    '自检:type="module" 的垫片标签算红(异步执行会晚于主包)')

  ok(!!src, 'index.html 里有一条非 module 的脚本标签指向 tauri-shim.js', '找不到标签')
  const served = servedShim(VCFG, src)
  ok(!!src && existsSync(served), `请求 ${src} 取到的是垫片本体,而不是 SPA 回落的 index.html`,
    `publicDir=${publicDirOf(VCFG)}`)
  // 反向核账:publicDir 里那份必须就是上面第 1~5 节扫描的那一份。复制一份到 public/ 也能让桌面版跑起来,
  // 但那些断言扫的就是假身了 —— 改垫片改到没人运行的那份,比不修更糟。
  ok(!!src && existsSync(served) && realpathSync(served) === realpathSync(SHIM),
    'publicDir 里那份与本文件扫描的那份是同一个文件(realpath 相同,否则第 1~5 节是自证)')
  console.log(`  注:publicDir = ${publicDirOf(VCFG)}`)
}

section('7. tauri dev 不能被 cargo 写盘撞死(vite 得忽略 src-tauri/target)')
{
  // 2026-10-11 实测:cargo 重编到 414/418 时,vite 的 chokidar 撞上 target 下正被独占锁定的
  // build_script_build.exe,抛未捕获的 EBUSY → vite 进程死 → tauri 报 beforeDevCommand 非零退出,
  // 桌面版连窗口都没有。Vite 默认只忽略 node_modules/.git/test-results/cacheDir/outDir,
  // 而 target/ 既在 root 之内又是每次编译都在写的目录,必须自己列进 ignored。
  // 只认函数式判定:Vite 的 glob 要经 escapePath,Windows 反斜杠形态正是这次事故的一部分。
  const ign = [].concat(VCFG.server?.watch?.ignored ?? []).filter((f) => typeof f === 'function')
  ok(ign.length > 0, 'server.watch.ignored 给了函数式判定(Vite 会把函数追加进默认忽略表后面)',
    JSON.stringify(VCFG.server?.watch?.ignored))
  const ignoredByUs = (p) => ign.some((f) => f(p) === true)
  ok(ignoredByUs(path.join(ROOT, 'src-tauri', 'target', 'debug', 'build', 'godot-workshop-3cc26e8d',
    'build_script_build-3cc26e8d.exe')), '崩溃现场那条(cargo 正写的 target 下 exe)被忽略')
  // 反向:误伤源码 = 热更新静默失效,那比崩更难查。
  ok(!ignoredByUs(path.join(ROOT, 'src', 'App.vue')) && !ignoredByUs(path.join(ROOT, 'src-tauri', 'src', 'main.rs')),
    '不误伤 src 与 src-tauri/src(否则改代码不再热更新)', path.join(ROOT, 'src', 'App.vue'))
}

console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
