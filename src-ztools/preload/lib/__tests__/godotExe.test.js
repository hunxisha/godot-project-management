// godotExe.js 回归测试:版本串解析 / 展示名 / 平台标识。
//
// 这个模块此前**没有任何测试触达**(见 docs/optimization-plan.md P2-1),而它决定了两件
// 影响面很大的事:已安装版本能否被识别(parseVersionOutput / parseTagFromFileName),
// 以及版本在界面上的名字(displayName)。纯函数,测试成本极低。
//
// displayName 与 currentPlatform 原本各有两份实现(install.js 与 releases.js),
// 现已统一到本模块 —— 第 4 节是去重护栏,防止重复实现重新长出来。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/godotExe.test.js
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.resolve(__dirname, '..')
const exe = require(path.join(LIB, 'godotExe.js'))

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

// ---------- 1. displayName ----------
section('1. displayName:版本 tag → 展示名')
ok(exe.displayName('4.7.2-stable') === '4.7.2 Stable', 'stable 频道首字母大写')
ok(exe.displayName('4.7.2-beta3') === '4.7.2 Beta3', 'beta 频道')
ok(exe.displayName('4.7.2-rc1') === '4.7.2 Rc1', 'rc 频道(仅首字母大写,与既有实现一致)')
ok(exe.displayName('4.7.2-dev6') === '4.7.2 Dev6', 'dev 频道')
ok(exe.displayName('4.7.2') === '4.7.2', '无频道后缀时原样返回')
ok(exe.displayName('local') === 'local', '非标准 tag 不抛错')
ok(exe.displayName('') === '', '空串安全')

// ---------- 2. currentPlatform ----------
section('2. currentPlatform:平台标识')
const TABLE = { win32: 'win64', darwin: 'macos', linux: 'linux64' }
const expectPlatform = TABLE[process.platform] || 'linux64'
ok(exe.currentPlatform() === expectPlatform, `当前平台映射正确(${process.platform} → ${expectPlatform})`, exe.currentPlatform())
ok(['win64', 'macos', 'linux64'].includes(exe.currentPlatform()), '取值属于 Platform 联合类型')

// ---------- 3. 版本串解析 ----------
section('3. parseVersionOutput:--version 输出 → tag')
ok(exe.parseVersionOutput('4.3.stable.official.xxx') === '4.3-stable', '两位版本号')
ok(exe.parseVersionOutput('4.7.2.stable.official.abc') === '4.7.2-stable', '三位版本号')
ok(exe.parseVersionOutput('4.4.dev6.official') === '4.4-dev6', 'dev 预发布')
ok(exe.parseVersionOutput('4.7.beta3.official') === '4.7-beta3', 'beta 预发布')
ok(exe.parseVersionOutput('  4.3.stable.official  ') === '4.3-stable', '首尾空白被 trim')
ok(exe.parseVersionOutput('not a version') === null, '无法识别时返回 null')
ok(exe.parseVersionOutput('') === null, '空输出返回 null')

section('4. parseTagFromFileName:安装包文件名 → tag')
ok(exe.parseTagFromFileName('Godot_v4.3-stable_win64.exe') === '4.3-stable', 'Windows 标准版')
ok(exe.parseTagFromFileName('Godot_v4.7.2-stable_mono_win64.zip') === '4.7.2-stable', 'mono 变体')
ok(exe.parseTagFromFileName('Godot_v4.7.2-rc1_win64.exe') === '4.7.2-rc1', 'rc 预发布')
ok(exe.parseTagFromFileName('nope.exe') === null, '无版本信息时返回 null')

// ---------- 5. 去重护栏 ----------
section('5. 去重护栏:displayName / currentPlatform 全仓只有一处定义')
const PRELOAD = path.resolve(LIB, '..')

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

const sources = walk(PRELOAD).filter((p) => !p.includes(`${path.sep}__tests__${path.sep}`))
const rel = (p) => path.relative(PRELOAD, p).replace(/\\/g, '/')
const read = (p) => fs.readFileSync(p, 'utf-8')

for (const fn of ['displayName', 'currentPlatform']) {
  const re = new RegExp(`^function\\s+${fn}\\s*\\(`, 'm')
  const hits = sources.filter((p) => re.test(read(p))).map(rel)
  ok(hits.length === 1, `${fn} 只有一处定义`, hits.join(', '))
  ok(hits[0] === 'lib/godotExe.js', `${fn} 的定义位于 lib/godotExe.js`, hits[0])
}

// 旧实现里重复过的平台三元表达式不得复活(install.js 的 platformOfProcess / releases.js 的旧 currentPlatform)
const reTriple = /process\.platform === 'win32' \? 'win64'/
const tripleHits = sources.filter((p) => reTriple.test(read(p))).map(rel)
ok(tripleHits.length === 0, '不存在内联的平台三元表达式重复实现', tripleHits.join(', '))

// ---------- 结果 ----------
console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
