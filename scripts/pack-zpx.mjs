#!/usr/bin/env node
// 把插件源码目录打成 ZTools 的 .zpx。
//
// .zpx = Brotli(quality 5)[ ASAR[ plugin.json, dist/, preload/, logo.png, ... ] ]
// 顺序不能变:brotli 包着 asar,asar 里放插件根目录(不是仓库根目录)。
//
//   node scripts/pack-zpx.mjs                       # 默认 src-ztools → ./<name>-v<version>.zpx
//   node scripts/pack-zpx.mjs --out out/x.zpx       # 指定输出
//   node scripts/pack-zpx.mjs --src src-ztools --quality 5
//
// 打完会回读自己生成的文件:解 brotli、解析 asar 头、把里面的 plugin.json 读出来比对
// name / version / main,任何一项对不上就非 0 退出 —— 不能让「装着是旧版本」的包流出去。
//
// @electron/asar v4 是 ESM-only 且要求 Node >= 22.12,所以用 import() 动态加载,
// 并按「项目」而不是「脚本所在位置」解析(脚本可以被复制到别处用)。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createBrotliCompress, brotliDecompressSync, constants } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { createReadStream, createWriteStream } from 'node:fs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const projectRoot = process.cwd()
const srcDir = path.resolve(projectRoot, arg('src', 'src-ztools'))
const quality = Number(arg('quality', '5'))
const srcManifestPath = path.join(srcDir, 'plugin.json')

function die(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

if (!existsSync(srcManifestPath)) die(`源目录里没有 plugin.json:${srcManifestPath}`)
const srcManifest = JSON.parse(readFileSync(srcManifestPath, 'utf8'))
const { name, version, main } = srcManifest
if (!name || !version) die('plugin.json 缺 name 或 version')

// main 指向的文件必须真的在包里,否则装上去是白屏
if (main && !existsSync(path.join(srcDir, main))) {
  console.warn(`! 警告:plugin.json main=「${main}」在 ${srcDir} 下找不到 —— 是不是忘了 npm run build?`)
}

const outPath = path.resolve(projectRoot, arg('out', `${name}-v${version}.zpx`))

const require = createRequire(path.join(projectRoot, 'package.json'))
let asar
try {
  asar = await import(pathToFileURL(require.resolve('@electron/asar')).href)
} catch (e) {
  die(`加载 @electron/asar 失败:${e.message}\n  先装依赖:npm i -D @electron/asar`)
}

const tmpDir = mkdtempSync(path.join(tmpdir(), 'zpx-'))
const tmpAsar = path.join(tmpDir, 'plugin.asar')

try {
  await asar.createPackage(srcDir, tmpAsar)
  await pipeline(
    createReadStream(tmpAsar),
    createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: quality } }),
    createWriteStream(outPath)
  )
} finally {
  // 索引服务/杀毒偶尔会短暂占着句柄;临时文件删不掉不算失败
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

// ---------- 回读校验:不信任自己刚写的字节,重新解一遍 ----------
const asarBuf = brotliDecompressSync(readFileSync(outPath))
const dataStart = 8 + asarBuf.readUInt32LE(4)
const jsonLen = asarBuf.readUInt32LE(12)
const header = JSON.parse(asarBuf.subarray(16, 16 + jsonLen).toString('utf8'))

const top = Object.keys(header.files || {})
const need = ['plugin.json', 'dist', 'preload']
const missing = need.filter((k) => !top.includes(k))

const entry = header.files['plugin.json']
if (!entry) die('.zpx 顶层没有 plugin.json —— 打到了错误的目录(要打插件根目录,不是仓库根目录)')
const at = dataStart + Number(entry.offset)
const inner = JSON.parse(asarBuf.subarray(at, at + entry.size).toString('utf8'))

const problems = []
if (inner.name !== name) problems.push(`name「${inner.name}」≠ 源「${name}」`)
if (inner.version !== version) problems.push(`version「${inner.version}」≠ 源「${version}」`)
if (inner.main !== main) problems.push(`main「${inner.main}」≠ 源「${main}」`)
if (missing.length) problems.push(`顶层缺 ${missing.join(' / ')}`)

const size = statSync(outPath).size
if (problems.length) die(`打包校验失败:${problems.join(';')}`)

console.log(`✓ ${path.relative(projectRoot, outPath) || outPath}`)
console.log(`  name=${inner.name}  version=${inner.version}  main=${inner.main}`)
console.log(`  顶层 ${top.length} 项:${top.slice(0, 8).join(', ')}${top.length > 8 ? ' …' : ''}`)
console.log(`  ${(size / 1024).toFixed(1)} KB(brotli quality=${quality})`)
