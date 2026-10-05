// 工具页 P1 第二批 #11 版本控制卫生(src/tools/inspectors/git.ts)的断言。
//
// §3.2 原文这条叫「Git 卫生」,含「被 Git 跟踪的大二进制」。本批**不判「被跟踪」**:
// 要知道谁被跟踪,要么跑 `git`(新执行面,违反 §2.2 的最小 IO 原语,还要 Rust + shim 跟齐),
// 要么解析 `.git/index`(新二进制解析器)。两者都不在本批形状里。
// 所以下面的大文件那条只说「清单里有大文件」,并把「判不了是否被跟踪」写在措辞里 —— 近似口径要自首。
//
// 能判死的是这几条,全部只用文件清单 + 文本:
//   · 是不是一个 git 仓库(清单里有没有 `.git` 条目);
//   · 有没有 .gitignore;
//   · .gitignore 里有没有针对 .godot 的忽略行(只认列出的那几种常见写法,认不出的一律不判);
//   · 有没有 .editorconfig / .gitattributes(官方新建项目模板会写);
//   · 清单里的大文件。
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tools.mjs')

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const T = await import(pathToFileURL(BUNDLE).href)

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }

const HAS = typeof T.runGit === 'function'
ok(HAS, 'runGit 已在打包产物里导出')
if (!HAS) {
  console.log('\n实现尚未落地,后续断言无法执行(这就是 RED 那一步)。')
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  process.exit(1)
}

function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}
function tree(specs) {
  const base = Date.UTC(2026, 0, 1)
  return specs.map(([rel, size, off = 0]) => ({ rel, size, mtimeMs: base + off * 86400000, ext: extOf(rel) }))
}
function makeCtx(specs, { trunc = false, texts = {}, fail = {} } = {}) {
  const calls = []
  const ctx = {
    projectId: 'godot/project/p', root: 'E:/proj', truncated: trunc, tree: tree(specs),
    readText: async (rel) => {
      calls.push(rel)
      if (Object.prototype.hasOwnProperty.call(fail, rel)) return fail[rel]
      return typeof texts[rel] === 'string' ? { text: texts[rel] } : { skipped: true }
    }
  }
  return { ctx, calls }
}

const MB = 1024 * 1024
const noRepoOf = (fs) => fs.filter((f) => f.id === 'git:not-repo')
const noIgnOf = (fs) => fs.filter((f) => f.id === 'git:no-ignore')
const godotOf = (fs) => fs.filter((f) => f.id === 'git:godot-not-ignored')
const editorOf = (fs) => fs.filter((f) => f.id === 'git:no-editorconfig')
const attrsOf = (fs) => fs.filter((f) => f.id === 'git:no-gitattributes')
const bigOf = (fs) => fs.filter((f) => f.id === 'git:big-files')
const idsOf = (fs) => fs.map((f) => f.id).join('|')

/** 一个「干净」的 Godot 仓库该有的样子:.git 在、.godot 被忽略、两份配置模板都在 */
const CLEAN_SPECS = [
  ['.git/HEAD', 23], ['.git/config', 300],
  ['project.godot', 400], ['.gitignore', 60], ['.gitattributes', 40], ['.editorconfig', 180],
  ['scene/main.tscn', 300], ['.godot/global_script_class_cache.cfg', 50]
]
const GITIGNORE_GODOT = '*.import\n.import\n# Godot 4+\n.gitignore\n.godot/\n'

section('1. 全部齐备时一条结论都不发(但会说明「被跟踪」判不了)')
{
  const fs = await T.runGit(makeCtx(CLEAN_SPECS, { texts: { '.gitignore': GITIGNORE_GODOT } }).ctx)
  ok(noIgnOf(fs).length === 0 && godotOf(fs).length === 0 && editorOf(fs).length === 0 && attrsOf(fs).length === 0,
    '该有的都有 → 这四类一条都不报', idsOf(fs))
  ok(bigOf(fs).length === 0 && noRepoOf(fs).length === 0, '没有大文件、也认得出是仓库', idsOf(fs))
}

section('2. 不是 git 仓库:只出一条说明,不再判别的')
{
  const fs = await T.runGit(makeCtx([['project.godot', 400], ['scene/main.tscn', 300]], { texts: {} }).ctx)
  ok(fs.length === 1 && noRepoOf(fs).length === 1, '只出「不是 git 仓库」这一条 info', idsOf(fs))
  ok(noRepoOf(fs)[0].severity === 'info', '没初始化 git 不是错', noRepoOf(fs)[0].severity)
  ok(noRepoOf(fs)[0].detail.includes('git'), '措辞讲的是没做成什么', noRepoOf(fs)[0].detail)
}

section('3. 是仓库但没有 .gitignore = warn,且不再判 .godot 覆盖')
{
  const fs = await T.runGit(makeCtx(
    [['.git/HEAD', 23], ['project.godot', 400], ['.editorconfig', 180], ['.gitattributes', 40]],
    { texts: {} }
  ).ctx)
  ok(noIgnOf(fs).length === 1 && noIgnOf(fs)[0].severity === 'warn', '缺 .gitignore 报 warn', idsOf(fs))
  ok(godotOf(fs).length === 0, '没有 ignore 文件时不重复报「.godot 没被忽略」', idsOf(fs))
}

section('4. .gitignore 在,但没覆盖 .godot = warn')
{
  const fs = await T.runGit(makeCtx(
    [['.git/HEAD', 23], ['.gitignore', 20], ['project.godot', 400], ['.editorconfig', 180], ['.gitattributes', 40]],
    { texts: { '.gitignore': '*.tmp\nbuild/\n' } }
  ).ctx)
  const g = godotOf(fs)
  ok(g.length === 1 && g[0].severity === 'warn', '这条最有价值:缓存进仓库是 Godot 项目的头号污染', idsOf(g))
  ok(g[0].title.includes('.godot'), '标题点名 .godot', g[0].title)
  ok(/只认|常见写法/.test(g[0].detail), '措辞承认只认几种写法,不假装懂完整 gitignore 语义', g[0].detail)
}

section('5. 认下的忽略写法')
{
  for (const line of ['.godot/', '.godot', '/.godot/', '/.godot', '**/.godot/']) {
    const fs = await T.runGit(makeCtx(
      [['.git/HEAD', 23], ['.gitignore', 20], ['project.godot', 400], ['.editorconfig', 180], ['.gitattributes', 40]],
      { texts: { '.gitignore': `tmp/\n${line}\n` } }
    ).ctx)
    ok(godotOf(fs).length === 0, `「${line}」算已忽略`, idsOf(fs))
  }
  // 注释行里出现 .godot 不算忽略(官方模板就把这几行注释掉了)
  const commented = await T.runGit(makeCtx(
    [['.git/HEAD', 23], ['.gitignore', 20], ['project.godot', 400], ['.editorconfig', 180], ['.gitattributes', 40]],
    { texts: { '.gitignore': '# Godot 4+\n#.godot/\n' } }
  ).ctx)
  ok(godotOf(commented).length === 1, '被注释掉的忽略行不算已忽略', idsOf(commented))
}

section('6. 缺 .editorconfig / .gitattributes = info,不与 warn 混')
{
  const fs = await T.runGit(makeCtx(
    [['.git/HEAD', 23], ['.gitignore', 20], ['project.godot', 400]],
    { texts: { '.gitignore': GITIGNORE_GODOT } }
  ).ctx)
  ok(editorOf(fs).length === 1 && editorOf(fs)[0].severity === 'info', '缺 .editorconfig 是 info', idsOf(fs))
  ok(attrsOf(fs).length === 1 && attrsOf(fs)[0].severity === 'info', '缺 .gitattributes 是 info', idsOf(fs))
  ok(noIgnOf(fs).length === 0 && godotOf(fs).length === 0, '该有的不误报', idsOf(fs))
}

section('7. 大文件只报「清单里有」,不谎称「被跟踪」')
{
  const specs = [['.git/HEAD', 23], ['.gitignore', 20], ['project.godot', 400], ['.editorconfig', 180],
    ['.gitattributes', 40], ['assets/big.webm', 60 * MB], ['assets/big2.wav', 30 * MB],
    ['.godot/cached.tex', 90 * MB]]
  const fs = await T.runGit(makeCtx(specs, { texts: { '.gitignore': GITIGNORE_GODOT } }).ctx)
  const b = bigOf(fs)
  ok(b.length === 1 && b[0].severity === 'info', '大文件合成一条 info', idsOf(b))
  ok(b[0].detail.includes('big.webm') && b[0].detail.includes('big2.wav'), '逐个点名带体积', b[0].detail)
  ok(!b[0].detail.includes('cached.tex'), '.godot 里的缓存不算候选(它本来就该被忽略)', b[0].detail)
  ok(/跟踪|git ls|判不了/.test(b[0].detail), '明确说出「是否真的被跟踪本工具判不了」', b[0].detail)
}

section('8. 截断与读不到')
{
  const fs = await T.runGit(makeCtx(
    [['project.godot', 400], ['.gitignore', 20]], { trunc: true, texts: { '.gitignore': 'tmp/\n' } }
  ).ctx)
  ok(noRepoOf(fs).length === 1, '截断时 .git 可能整体没进清单 → 不能判「不是仓库」之外的东西', idsOf(fs))
  ok(/截断/.test(noRepoOf(fs)[0].detail), '措辞要说清是清单残缺而不是项目没 git', noRepoOf(fs)[0].detail)

  const r = await T.runGit(makeCtx(
    [['.git/HEAD', 23], ['.gitignore', 20], ['project.godot', 400], ['.editorconfig', 180], ['.gitattributes', 40]],
    { fail: { '.gitignore': { skipped: true } } }
  ).ctx)
  ok(godotOf(r).length === 0, '.gitignore 读不到时不判覆盖情况', idsOf(r))
  ok(r.every((f) => f.id !== 'git:godot-not-ignored'), '同样的错不报两遍', idsOf(r))
}

section('9. 红线:畸形输入不抛')
{
  const e = await T.runGit({ projectId: 'p', root: 'E:/x', truncated: false, tree: [], readText: async () => ({}) })
  ok(Array.isArray(e) && e.length === 1, '空清单 = 不是仓库那一条', e.length)
  const j = await T.runGit({
    projectId: 'p', root: 'E:/x', truncated: false,
    tree: [{ rel: '.git', size: 1, mtimeMs: 0, ext: '' }, null],
    readText: async () => ({ text: null })
  })
  ok(Array.isArray(j), '裸 .git 文件(submodule 的 gitdir 指针)也算仓库,且不抛', j)
}

section('10. .gitignore 覆盖的大文件不进候选(#21/#22 拍板后的做法:不开执行面,用忽略表摘噪音)')
{
  const REPO = [['.git/HEAD', 23], ['.gitignore', 60], ['project.godot', 400],
    ['.editorconfig', 180], ['.gitattributes', 40]]
  const runWith = (rules, extra) => T.runGit(makeCtx([...REPO, ...(extra || [])], { texts: { '.gitignore': rules } }).ctx)

  let fs = await runWith('dist/\n', [['dist/game.zip', 40 * MB]])
  ok(bigOf(fs).length === 0 && fs.every((f) => f.id !== 'git:big-files'),
    '目录规则覆盖的大文件不报', idsOf(fs))

  fs = await runWith('*.zip\n', [['export/build.zip', 80 * MB], ['art/keep.webm', 30 * MB]])
  let b = bigOf(fs)
  ok(b.length === 1 && b[0].detail.includes('art/keep.webm') && !b[0].detail.includes('export/build.zip'),
    '后缀规则只摘掉它覆盖的那一个', b[0] && b[0].detail)
  ok(b[0].detail.includes('排除 1 个'), '排除数要说出口(静默少报等于把判据藏进实现)', b[0] && b[0].detail)

  fs = await runWith('data/hero.psd\n', [['data/hero.psd', 55 * MB], ['other/hero.psd', 30 * MB]])
  b = bigOf(fs)
  ok(b.length === 1 && b[0].detail.includes('other/hero.psd'),
    '含斜杠的规则按根锚定,不殃及别处的同名文件', b[0] && b[0].detail)

  fs = await runWith('node_modules\n', [['node_modules/pkg/big.js', 25 * MB]])
  ok(bigOf(fs).length === 0, '裸名规则匹配任意层级的同名段', idsOf(fs))

  // 取反:!keep.bin 让它重新进候选;后写的规则赢(与 git 同向)
  fs = await runWith('*.bin\n!data/keep.bin\n', [['data/keep.bin', 30 * MB], ['data/other.bin', 30 * MB]])
  b = bigOf(fs)
  ok(b.length === 1 && b[0].detail.includes('data/keep.bin') && !b[0].detail.includes('data/other.bin'),
    '取反行点名的那个照旧上报,其余仍算已忽略', b[0] && b[0].detail)

  fs = await runWith('[Ll]og/*.bin\n', [['log/a.bin', 30 * MB]])
  b = bigOf(fs)
  ok(b.length === 1, '字符类规则判不出来 → 当未覆盖(方向是多报,不是少报)', idsOf(fs))
  ok(/判不了|不跑|git ls-files/.test(b[0].detail), '卡面继续自首「是否被跟踪判不了」', b[0].detail)

  fs = await T.runGit(makeCtx([['.git/HEAD', 23], ['project.godot', 400], ['.editorconfig', 180],
    ['.gitattributes', 40], ['assets/big.webm', 30 * MB]], { texts: {} }).ctx)
  b = bigOf(fs)
  ok(b.length === 1 && !/排除/.test(b[0].detail), '没有忽略表时不说「已排除几个」', b[0] && b[0].detail)
}

section('11. .godot 覆盖判定与大文件共用同一把尺子')
{
  const REPO = [['.git/HEAD', 23], ['.gitignore', 60], ['project.godot', 400],
    ['.editorconfig', 180], ['.gitattributes', 40], ['.godot/x.cache', 10]]
  for (const line of ['.godot', '.godot/', '/.godot', '/.godot/', '**/.godot/', '**/.godot']) {
    const fs = await T.runGit(makeCtx(REPO, { texts: { '.gitignore': `tmp/\n${line}\n` } }).ctx)
    ok(godotOf(fs).length === 0, `「${line}」在共用尺子下仍算已忽略`, idsOf(fs))
  }
  const weird = await T.runGit(makeCtx(REPO, { texts: { '.gitignore': '[.]godot/\n' } }).ctx)
  ok(godotOf(weird).length === 1, '字符类写法仍判不出来 → 照旧出 warn(措辞已承认覆盖面有限)', idsOf(weird))
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
