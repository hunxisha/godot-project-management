// 工具页 P2 #16 前半 纹理导入体检(src/tools/inspectors/textures.ts)的断言。
//
// 与 importFile.test.mjs 的分工:那边钉「[params] 三键怎么读」,这边钉**检查器决定**:
// 候选只认哪些 importer、判据只看写下的值还是也猜默认、大纹理怎么定、2D/3D 不明时文案怎么自首、
// 截断与读不到时怎么说人话。
//
// 用法(npm script 会先跑打包步骤):
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/textures.test.mjs
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

const HAS = typeof T.runTextures === 'function' && typeof T.BIG_TEXTURE_BYTES === 'number'
ok(HAS, 'runTextures 与 BIG_TEXTURE_BYTES 已在打包产物里导出')
if (!HAS) {
  console.log('\n实现尚未落地,后续断言无法执行(这就是 RED 那一步)。')
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  process.exit(1)
}
ok(T.BIG_TEXTURE_BYTES === 4 * 1024 * 1024, '大纹理体积闸是 4 MiB(默认值拍定在检查器,不散落)', String(T.BIG_TEXTURE_BYTES))

const MB = 1024 * 1024
function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}
function tree(specs) {
  const base = Date.UTC(2026, 0, 1)
  return specs.map(([rel, size]) => ({ rel, size, mtimeMs: base, ext: extOf(rel) }))
}
/** 一份 4.x texture 边车;三键可由调用方覆写(传 undefined 删行,模拟「没写」) */
function importText({ mode = 0, mip = false, d3d = 1 } = {}) {
  const lines = [
    '[remap]',
    '',
    'importer="texture"',
    'type="CompressedTexture2D"',
    'uid="uid://bkm2b5nqf3rhe"',
    'path="res://.godot/imported/x.ctex"',
    '',
    '[deps]',
    '',
    'source_file="res://art/x.png"',
    'dest_files=["res://.godot/imported/x.ctex"]',
    '',
    '[params]',
    '',
    'compress/mode=' + mode,
    'mipmaps/generate=' + mip,
    'detect_3d/compress_to=' + d3d
  ]
  return lines.join('\n')
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
const find = (fs, pred) => fs.filter(pred)

async function main() {
  // ---------- 1. 核心判据 ----------
  section('1. 核心判据:大纹理 + 无损 + 无 mipmap → warn')
  {
    const specs = [
      ['art/big.png', 5 * MB],
      ['art/big.png.import', 300]
    ]
    const { ctx } = makeCtx(specs, { texts: { 'art/big.png.import': importText({ mode: 0, mip: false, d3d: 1 }) } })
    const fs = await T.runTextures(ctx)
    const hit = find(fs, (f) => f.id.startsWith('textures:big-lossless:'))
    ok(hit.length === 1, '★5 MiB 的 png(mode=0、mipmaps=false)报一条 warn', JSON.stringify(fs.map((f) => f.title)))
    ok(hit[0] && hit[0].severity === 'warn' && hit[0].rel === 'art/big.png',
      '主证据是源文件(不是边车),级别 warn', hit[0] && `${hit[0].severity}/${hit[0].rel}`)
    ok(hit[0] && JSON.stringify(hit[0].related) === JSON.stringify(['art/big.png.import']),
      'related 指回边车(用户要去改的是 .import 的参数)', hit[0] && JSON.stringify(hit[0].related))
    ok(hit[0] && /2D/.test(hit[0].detail) && /3D/.test(hit[0].detail),
      '★detail 自首用途不明:2D 与 3D 两种读法都说清(拿不到项目类型,不替用户猜)')
    ok(hit[0] && /detect_3d\/compress_to=1/.test(hit[0].detail), 'detect_3d 的值原样进 detail 作证据', hit[0] && hit[0].detail)
  }
  {
    const specs = [
      ['art/big.png', 5 * MB],
      ['art/big.png.import', 300]
    ]
    const { ctx } = makeCtx(specs, { texts: { 'art/big.png.import': importText({ mode: 0, mip: false, d3d: 0 }) } })
    const fs = await T.runTextures(ctx)
    const hit = find(fs, (f) => f.id.startsWith('textures:big-lossless:'))
    ok(hit.length === 1 && /自动转压已被显式关闭/.test(hit[0].detail),
      'detect_3d/compress_to=0(自动链路被关)在 detail 里点名', hit[0] && hit[0].detail)
  }

  // ---------- 2. 不该报的四个方向 ----------
  section('2. 反例:改任何一项都不报')
  {
    const specs = [['art/a.png', 5 * MB], ['art/a.png.import', 300], ['art/b.png', 5 * MB], ['art/b.png.import', 300],
      ['art/c.png', 5 * MB], ['art/c.png.import', 300], ['art/d.png', 5 * MB], ['art/d.png.import', 300]]
    const texts = {
      'art/a.png.import': importText({ mode: 2, mip: false }),   // 已是 VRAM 压缩
      'art/b.png.import': importText({ mode: 0, mip: true }),    // 已开 mipmap
      'art/c.png.import': importText({ mode: 1, mip: false }),   // 有损压缩
      'art/d.png.import': '[remap]\nimporter="texture"\n'        // 没有 [params](手写边车)
    }
    const { ctx } = makeCtx(specs, { texts })
    const fs = await T.runTextures(ctx)
    ok(find(fs, (f) => f.id.startsWith('textures:big-lossless:')).length === 0,
      '★mode=2 / mip=true / mode=1 / 缺 params 四种都不报(判据只看写下的值,缺键不猜默认)',
      JSON.stringify(fs.map((f) => f.title)))
    ok(find(fs, (f) => f.severity === 'error').length === 0, '反例一张都不产生 error 级')
  }
  {
    const specs = [['art/small.png', 2 * MB], ['art/small.png.import', 300]]
    const { ctx } = makeCtx(specs, { texts: { 'art/small.png.import': importText({ mode: 0, mip: false }) } })
    const fs = await T.runTextures(ctx)
    ok(find(fs, (f) => f.id.startsWith('textures:big-lossless:')).length === 0,
      '★2 MiB(< 4 MiB 闸)的同参数纹理不报', JSON.stringify(fs.map((f) => f.title)))
  }

  // ---------- 3. 候选口径 ----------
  section('3. 候选口径:importer、legacy、失效边车、大小写')
  {
    const specs = [
      ['a.png', 5 * MB], ['a.png.import', 300],
      ['b.png', 5 * MB], ['b.png.import', 300],
      ['c.png', 5 * MB], ['c.png.import', 300],
      ['d.png', 5 * MB], ['d.png.import', 300],
      ['e.png.import', 300],
      ['Art/F.PNG', 5 * MB], ['Art/F.PNG.import', 300]
    ]
    const texts = {
      'a.png.import': importText(),                                                          // texture:报
      'b.png.import': importText().replace('importer="texture"', 'importer="bitmap"'),       // bitmap:报
      'c.png.import': importText().replace('importer="texture"', 'importer="wavefront_obj"'),// 非图像导入器:不判
      'd.png.import': 'generator="organically.godot.texture"\n\n[params]\ncompress/mode=0\nmipmaps/generate=false\n', // legacy:不判
      'e.png.import': importText(),                                                          // 源缺失边车:不判
      'Art/F.PNG.import': importText()                                                       // 源写成小写异体:照判
    }
    const { ctx } = makeCtx(specs, { texts })
    const fs = await T.runTextures(ctx)
    const rels = find(fs, (f) => f.id.startsWith('textures:big-lossless:')).map((f) => f.rel).sort()
    ok(JSON.stringify(rels) === JSON.stringify(['Art/F.PNG', 'a.png', 'b.png']),
      '★只认 importer=texture/bitmap;wavefront_obj 与 Godot3 legacy 不判;源缺失/大小写异体各按口径',
      JSON.stringify(rels))
  }
  {
    const gd = [['art/.gdignore', 0], ['art/x.png', 5 * MB], ['art/x.png.import', 300]]
    const { ctx } = makeCtx(gd, { texts: { 'art/x.png.import': importText() } })
    const fs = await T.runTextures(ctx)
    ok(find(fs, (f) => f.id.startsWith('textures:big-lossless:')).length === 0,
      '★.gdignore 屏蔽目录里的纹理不判(引擎看不见它们)', JSON.stringify(fs.map((f) => f.title)))
  }
  {
    const cache = [['.godot/imported/x.png.import', 5 * MB], ['.godot/imported/x.png', 5 * MB]]
    const { ctx } = makeCtx(cache, { texts: { '.godot/imported/x.png.import': importText() } })
    const fs = await T.runTextures(ctx)
    ok(find(fs, (f) => f.id.startsWith('textures:big-lossless:')).length === 0,
      '.godot 缓存里的边车不进候选(sourceFiles 口径)')
  }

  // ---------- 4. 排序与截断 ----------
  section('4. 排序(体积降序)、LIST_CAP 与尾条')
  {
    const specs = []
    const texts = {}
    for (let i = 0; i < 23; i++) {
      const n = String(i).padStart(2, '0')
      specs.push([`t${n}.png`, (5 + (22 - i)) * MB], [`t${n}.png.import`, 300])
      texts[`t${n}.png.import`] = importText()
    }
    const { ctx } = makeCtx(specs, { texts })
    const fs = await T.runTextures(ctx)
    const hits = find(fs, (f) => f.id.startsWith('textures:big-lossless:'))
    ok(hits.length === 20, '23 张命中只列前 20(LIST_CAP)', String(hits.length))
    ok(hits[0].rel === 't00.png' && hits[19].rel === 't19.png', '按体积降序(t00=27MB 最大,t19=8MB 是第 20 张)', `${hits[0].rel}…${hits[19].rel}`)
    const tail = find(fs, (f) => f.id === 'textures:tail')
    ok(tail.length === 1 && /另有 3 张/.test(tail[0].title), '尾条说清差额外还有多少', tail[0] && tail[0].title)
    ok(fs.every((f) => f.id !== 'textures:skip-count'), '边车全读到时不出「读不到」条目')
  }

  // ---------- 5. 读不到与截断 ----------
  section('5. 边车读不到 / 清单截断怎么说')
  {
    const specs = [['a.png', 5 * MB], ['a.png.import', 300], ['b.png', 5 * MB], ['b.png.import', 300]]
    const { ctx } = makeCtx(specs, {
      texts: { 'a.png.import': importText() },
      fail: { 'b.png.import': { skipped: true } }
    })
    const fs = await T.runTextures(ctx)
    ok(find(fs, (f) => f.id.startsWith('textures:big-lossless:')).length === 1,
      '读得到的那张照常报', JSON.stringify(fs.map((f) => f.title)))
    const skip = find(fs, (f) => f.id === 'textures:skip-count')
    ok(skip.length === 1 && /1 个边车读不到/.test(skip[0].title), '读不到的计数成一条,不谎称完整', skip[0] && skip[0].title)
  }
  {
    const specs = [['a.png', 5 * MB], ['a.png.import', 300]]
    const { ctx } = makeCtx(specs, { trunc: true, texts: { 'a.png.import': importText() } })
    const fs = await T.runTextures(ctx)
    ok(fs.some((f) => f.id === 'textures:truncated' && f.severity === 'warn') &&
      fs.some((f) => f.id.startsWith('textures:big-lossless:')),
      '★截断时照常报 + 覆盖面警示(secrets 同款,静默漏报会被读成「没有大纹理」)',
      JSON.stringify(fs.map((f) => f.id)))
  }
  {
    const specs = [['a.png', 5 * MB], ['a.png.import', 300]]
    const { ctx } = makeCtx(specs, { trunc: true, texts: {} })
    const fs = await T.runTextures(ctx)
    ok(fs.some((f) => f.id === 'textures:truncated'), '截断且零命中时警示仍要出现(不能把「没扫到」渲染成干净)')
  }

  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) {
    console.log('失败项:\n - ' + failures.join('\n - '))
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
