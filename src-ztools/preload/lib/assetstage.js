// 安装预览域:预下载暂存(24h 过期清扫)+ 冲突检测 + 安装计划;
// 用户在确认层取消时释放暂存。从 assets.js 拆出(2026-09-29)。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { downloadFile } = require('./http')
const { readZipEntries } = require('./extract')
const { getDoc } = require('./store')
const { getAssetDetail, asArray, splitAssetId } = require('./assetapi')
const { collectFiles, resolveUnder, findPluginCfgs } = require('./assetfiles')

// ---------- 安装预览:预下载暂存 + 安装计划 ----------

const STAGE_PREFIX = 'ztools-godot-stage-'
/** stageId → { dir, zipPath, assetId, createdAt } */
const staged = new Map()

/** 暂存最长保留时间:过期的包连同目录一起清掉(含上次会话的孤儿目录) */
const STAGE_MAX_AGE = 24 * 60 * 60 * 1000

function sweepStaged() {
  const now = Date.now()
  try {
    for (const ent of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
      if (!ent.isDirectory() || !ent.name.startsWith(STAGE_PREFIX)) continue
      const p = path.join(os.tmpdir(), ent.name)
      try {
        if (now - fs.statSync(p).mtimeMs > STAGE_MAX_AGE) fs.rmSync(p, { recursive: true, force: true })
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
  for (const [id, s] of staged) {
    if (now - s.createdAt > STAGE_MAX_AGE) {
      try { fs.rmSync(s.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
      staged.delete(id)
    }
  }
}

/** 冲突摘要(目标项目已存在的同路径文件) */
/** @typedef {{count: number, samples: string[]}} ConflictInfo */

/** 安装计划:确认层渲染所需的全部信息(zip 内容归纳) */
/** @typedef {{
 *   kind: 'addon'|'asset'|'project',
 *   topEntries: {name: string, isDir: boolean, files: number}[],
 *   fileCount: number,
 *   zipSize: number,
 *   singleTopDir: string,
 *   conflicts: { asIs: ConflictInfo, stripped: ConflictInfo|null }
 * }} InstallPlan */

/**
 * 计算文件清单与项目的冲突。
 * @param {string} projectPath
 * @param {string[]} relFiles 相对写入根的文件路径(正斜杠)
 * @returns {ConflictInfo}
 */
function conflictInfo(projectPath, relFiles) {
  /** @type {string[]} */
  const samples = []
  let count = 0
  for (const rel of relFiles) {
    const dest = resolveUnder(projectPath, rel)
    if (dest && fs.existsSync(dest)) {
      count++
      if (samples.length < 3) samples.push(rel)
    }
  }
  return { count, samples }
}

/**
 * 从 zip 条目名列表归纳安装计划。目录条目以 / 结尾;只统计文件条目。
 * @param {string} projectPath
 * @param {string[]} names
 * @param {number} zipSize
 * @returns {InstallPlan}
 */
function buildInstallPlan(projectPath, names, zipSize) {
  /** @type {Map<string, number>} */
  const tops = new Map()
  /** @type {Set<string>} 顶层散文件(没有子路径的条目) */
  const topLoose = new Set()
  /** @type {string[]} */
  const relFiles = []
  let hasPluginCfg = false
  for (const raw of names) {
    const name = raw.replace(/\\/g, '/')
    if (name.endsWith('/')) continue
    const top = name.split('/')[0]
    if (top === '__MACOSX') continue
    relFiles.push(name)
    if (name === top) topLoose.add(top)
    tops.set(top, (tops.get(top) || 0) + 1)
    if (name.split('/').pop() === 'plugin.cfg') hasPluginCfg = true
  }
  const topEntries = [...tops.entries()].map(([name, files]) => ({ name, isDir: !topLoose.has(name), files }))
  const single = topEntries.length === 1 && topEntries[0].isDir ? topEntries[0].name : ''
  const hasRootProject = topLoose.has('project.godot')
  const hasWrapperProject = !!single && relFiles.includes(`${single}/project.godot`)
  const strippedFiles = single
    ? relFiles.filter((n) => n.startsWith(single + '/')).map((n) => n.slice(single.length + 1))
    : []
  // 嗅探:有 plugin.cfg 走插件;根级(或 wrapper 根级)带 project.godot 的是完整项目
  const kind = hasPluginCfg ? 'addon' : hasRootProject || hasWrapperProject ? 'project' : 'asset'
  return {
    kind,
    topEntries,
    fileCount: relFiles.length,
    zipSize,
    singleTopDir: single,
    conflicts:
      kind === 'asset'
        ? { asIs: conflictInfo(projectPath, relFiles), stripped: single ? conflictInfo(projectPath, strippedFiles) : null }
        : { asIs: { count: 0, samples: [] }, stripped: null }
  }
}

/** assetId → 进行中的预览下载句柄(供取消) */
const activePreviews = new Map()

/**
 * 安装预览:预下载 zip 并暂存,归纳安装计划(kind/顶层条目/冲突)供确认层展示。
 * 确认后把 stageId 传给 installAsset 复用已下载的包;取消用 cancelStagedAsset 释放。
 * 下载阶段可用 cancelAssetPreview 中途取消(大包不必干等)。
 * @param {{projectId: string, assetId: string, version?: string}} opts
 * @param {(p: {stage: 'downloading'|'extracting', received?: number, total?: number}) => void} [onProgress]
 * @returns {Promise<{ok: boolean, error?: string, stageId?: string, title?: string, versionString?: string, plan?: InstallPlan}>}
 */
async function previewAssetInstall({ projectId, assetId, version }, onProgress) {
  const project = getDoc(projectId)
  if (!project) return { ok: false, error: '项目不存在' }
  const detail = await getAssetDetail(assetId, version)
  if (!detail.downloadUrl) return { ok: false, error: '资产没有下载地址' }
  sweepStaged()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), STAGE_PREFIX))
  try {
    const zipPath = path.join(dir, 'asset.zip')
    const dl = downloadFile(detail.downloadUrl, zipPath, {
      onProgress: (received, total) => onProgress && onProgress({ stage: 'downloading', received, total })
    })
    activePreviews.set(assetId, dl)
    try {
      await dl.promise
    } finally {
      activePreviews.delete(assetId)
    }
    const { entries: names } = readZipEntries(zipPath)
    const plan = buildInstallPlan(project.path, names, fs.statSync(zipPath).size)
    const stageId = path.basename(dir)
    staged.set(stageId, { dir, zipPath, assetId, createdAt: Date.now() })
    return { ok: true, stageId, title: detail.title, versionString: detail.versionString, plan }
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e2) { /* ignore */ }
    return { ok: false, error: (e && e.message) || '获取资产信息失败' }
  }
}

/**
 * 取消进行中的预览下载(幂等;无在途下载时为空操作)。
 * @param {string} assetId
 * @returns {{ok: boolean}}
 */
function cancelAssetPreview(assetId) {
  const dl = activePreviews.get(assetId)
  if (dl) dl.cancel()
  return { ok: true }
}

/**
 * 取走暂存的 zip(取走即从暂存表删除)。与 assetId 不匹配或包已丢失时返回 '',
 * 调用方回退为正常下载。
 * @param {string|undefined} stageId
 * @param {string} assetId
 * @returns {string}
 */
function takeStaged(stageId, assetId) {
  if (!stageId) return ''
  const s = staged.get(stageId)
  staged.delete(stageId)
  if (!s) return ''
  if (s.assetId !== assetId || !fs.existsSync(s.zipPath)) {
    try { fs.rmSync(s.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
    return ''
  }
  return s.zipPath
}

/**
 * 释放暂存的安装包(用户取消确认层时调用;幂等)。
 * @param {string} stageId
 * @returns {{ok: boolean}}
 */
function cancelStagedAsset(stageId) {
  const s = staged.get(stageId)
  if (s) {
    try { fs.rmSync(s.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
    staged.delete(stageId)
  }
  return { ok: true }
}

module.exports = {
  sweepStaged,
  conflictInfo,
  buildInstallPlan,
  previewAssetInstall,
  cancelAssetPreview,
  takeStaged,
  cancelStagedAsset
}
