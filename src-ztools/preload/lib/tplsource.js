// 自编译模板 · 代下载源码(docs/tplsource-plan.md,P0d;母计划 template-build-wizard-plan.md §2 决策 12):
//   官方 release 资产 godot-<tag>.tar.xz → 与同 release 的 .tar.xz.sha256 旁证逐字节比对 →
//   绝对路径调 System32\tar.exe 解到 <destDir>/godot-<tag>/。下载复用 http.js 的 downloadResumable
//   (.part 断点、3 次尝试、可取消)。
// 红线(继承母计划 :20-22):URL、tar 参数、各闸判据全在本文件拼死;渲染层只给 tag 与 destDir 两个值。
// 完整性是生命线:sha256 不匹配**或旁证缺失/形态不认**都拒绝解包;不匹配时删掉已下整包
// (断点续传只续网络中断,不续坏包),重试从零下。
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { downloadResumable, getText } = require('./http')
const { TAR_EXE } = require('./buildtools')

/** 官方 release 资产基址;资产名与旁证名规律见母计划 :125-131(跨 5 个 tag 核实) */
const RELEASE_BASE = 'https://github.com/godotengine/godot/releases/download'

/** 解前盘闸:解包后源码树约 1 GB 量级,留余量(与母计划 §6 同口径 4 GB) */
const MIN_FREE_BYTES = 4 * 1024 * 1024 * 1024

/** 在途锁:全局至多一条代下载(同目录重入是它的子集);结束与取消都清 */
let active = null

/**
 * tag → 资产与旁证 URL。tag 形态闸在调用处(tag 进 URL 与文件名,不白名单就是注入门)。
 * @param {string} tag
 */
function sourceUrls(tag) {
  const asset = `godot-${tag}.tar.xz`
  return { asset: `${RELEASE_BASE}/${tag}/${asset}`, sidecar: `${RELEASE_BASE}/${tag}/${asset}.sha256` }
}

/** 流式 sha256(分块读、不整文件进内存;写法同 inspectfs.js:389) */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(file)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

function rmTree(p) {
  try { fs.rmSync(p, { recursive: true, force: true }) } catch (e) { /* 清不掉留给错误文案点名 */ }
}

/**
 * 代下载主流程。各失败路径都带「下一步」,不静默消失。
 * @param {{tag: string, destDir: string}} params
 * @param {(p: {stage: 'downloading' | 'hashing' | 'extracting', received?: number, total?: number}) => void} [onProgress]
 * @returns {Promise<{ok: true, srcDir: string} | {ok: false, error: string}>}
 */
function downloadTemplateSource(params, onProgress) {
  return downloadTemplateSourceWith(params, onProgress, {
    downloadResumable,
    getText,
    existsSync: fs.existsSync,
    statfsSync: fs.statfsSync,
    spawn
  })
}

/**
 * 实现体。下载/旁证/探头/盘闸/tar 全注入,桩测不碰网络与真盘(哈希与 rename/unlink 走真 fs,落在临时目录)。
 * @param {{tag: string, destDir: string}} params
 * @param {(p: any) => void} [onProgress]
 * @param {{downloadResumable: typeof downloadResumable, getText: typeof getText, existsSync: (p: string) => boolean, statfsSync: (p: string) => {bsize: number, bavail: number}, spawn: typeof spawn}} deps
 */
async function downloadTemplateSourceWith(params, onProgress, deps) {
  const tag = String((params && params.tag) || '').trim()
  const destDir = String((params && params.destDir) || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
    return { ok: false, error: `tag 形态不合法(只认字母数字与 . _ -):${tag}` }
  }
  if (!destDir) return { ok: false, error: '未指定下载父目录' }
  if (!deps.existsSync(destDir)) return { ok: false, error: `下载父目录不存在:${destDir}` }
  if (!deps.existsSync(TAR_EXE)) {
    return { ok: false, error: '未找到 System32\\tar.exe,无法解包源码包。请手动准备源码目录。' }
  }
  if (active) return { ok: false, error: '已有代下载在途,先取消或等它完成,再发起新的。' }

  const xz = path.join(destDir, `godot-${tag}.tar.xz`)
  const part = `${xz}.part`
  const top = path.join(destDir, `godot-${tag}`)
  // 不覆盖用户既有目录:顶目录已在一律拒,要复用请先手动移除或换父目录
  if (deps.existsSync(top)) {
    return { ok: false, error: `目标目录已存在:${top}。请先移除它或换一个父目录(不覆盖既有目录)。` }
  }
  const urls = sourceUrls(tag)
  const state = { phase: 'downloading', dl: null, child: null, canceled: false }
  active = state
  const progress = (p) => {
    if (!onProgress) return
    try { onProgress(p) } catch (e) { /* 渲染层回调异常不许打死主流程 */ }
  }
  try {
    // ---------- 下载(已有整包则跳过:上次下完没解成,不必重下) ----------
    if (!deps.existsSync(xz)) {
      const dl = deps.downloadResumable(urls.asset, part, {
        attempts: 3,
        onProgress: (received, total) => progress({ stage: 'downloading', received, total })
      })
      state.dl = dl
      try {
        await dl.promise
      } catch (e) {
        if (state.canceled) return { ok: false, error: '已取消(已下字节留在 .part,重试可续传)。' }
        return { ok: false, error: `下载失败:${(e && e.message) || e}(.part 已保留,重试从断点继续)` }
      }
      if (state.canceled) return { ok: false, error: '已取消(已下字节留在 .part,重试可续传)。' }
      fs.renameSync(part, xz)
    }
    // ---------- 旁证 + 流式比对 ----------
    state.phase = 'hashing'
    progress({ stage: 'hashing' })
    let sidecar = ''
    try {
      sidecar = String(await deps.getText(urls.sidecar))
    } catch (e) {
      return { ok: false, error: '官方 sha256 旁证拉取失败(缺失或网络不通),拒绝盲解。请手动准备源码,或稍后重试。' }
    }
    const expect = (sidecar.trim().split(/\s+/)[0] || '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(expect)) {
      return { ok: false, error: '官方 sha256 旁证形态不认(不是 64 位十六进制),拒绝盲解。' }
    }
    const actual = await hashFile(xz)
    if (actual !== expect) {
      // 坏包不配续传:整包删掉,重试从零下
      try { fs.unlinkSync(xz) } catch (e) { /* ignore */ }
      try { fs.unlinkSync(part) } catch (e) { /* ignore */ }
      return { ok: false, error: `sha256 与官方旁证不一致(下载物 ${actual.slice(0, 12)}… / 旁证 ${expect.slice(0, 12)}…),已删除下载物。请重试或手动准备源码。` }
    }
    // ---------- 解前盘闸 ----------
    const st = deps.statfsSync(destDir)
    if (!st || !(st.bsize * st.bavail >= MIN_FREE_BYTES)) {
      return { ok: false, error: '目标盘剩余空间不足 4 GB,不够解包源码树(约 1 GB 量级)。换盘或清理后重试。' }
    }
    // ---------- tar 解包(顶目录进门时不存在,此后它是本流程自创的) ----------
    state.phase = 'extracting'
    progress({ stage: 'extracting' })
    let stderrTail = ''
    let code = 0
    try {
      code = await new Promise((resolve, reject) => {
        const child = deps.spawn(TAR_EXE, ['-xf', xz, '-C', destDir])
        state.child = child
        if (child.stderr) child.stderr.on('data', (d) => { stderrTail = (stderrTail + String(d)).slice(-400) })
        child.on('error', reject)
        child.on('close', (c) => resolve(c == null ? -1 : c))
      })
    } catch (e) {
      rmTree(top)
      return { ok: false, error: `tar.exe 起不来:${(e && e.message) || e}` }
    }
    if (state.canceled) {
      rmTree(top)
      return { ok: false, error: '已取消(解包半成品已清理,下载物保留可直接重试)。' }
    }
    if (code !== 0) {
      rmTree(top)
      return { ok: false, error: `tar 解包失败(退出码 ${code}):${stderrTail || '无 stderr 输出'}。下载物已保留,可直接重试。` }
    }
    if (!deps.existsSync(path.join(top, 'SConstruct')) || !deps.existsSync(path.join(top, 'version.py'))) {
      return { ok: false, error: `解包结果形态不符(${top} 缺 SConstruct 或 version.py),不当作源码根。请检查该目录或换父目录。` }
    }
    return { ok: true, srcDir: top }
  } finally {
    if (active === state) active = null
  }
}

/** 取消在途代下载:下载期留 .part 供续传;解包期 kill tar,半成品由主流程收口清理 */
function cancelTemplateSourceDownload() {
  const state = active
  if (!state) return
  state.canceled = true
  if (state.phase === 'downloading' && state.dl) {
    try { state.dl.cancel() } catch (e) { /* ignore */ }
  }
  if (state.child) {
    try { state.child.kill() } catch (e) { /* ignore */ }
  }
}

module.exports = {
  sourceUrls,
  hashFile,
  MIN_FREE_BYTES,
  downloadTemplateSource,
  downloadTemplateSourceWith,
  cancelTemplateSourceDownload
}
