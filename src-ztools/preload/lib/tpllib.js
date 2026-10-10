// 自编译模板 · 模板库(docs/tpllib-plan.md,P0c):多套裁剪变体存档 + 换入换出生效。
//
// 落点:存档根 = export_templates 基目录的**同级** tplpack/(标准引擎 %APPDATA%\Godot\tplpack,
// 自包含引擎 exe 旁 editor_data\tplpack)—— 与生效位同盘,切换才是 rename 而不是跨盘复制;
// 记录(db `godot/tplpack/<packId>`)只存 packId 与元数据,目录位置运行时由根解析,换根零迁移。
//
// 语义三条(任务书 §0):
//   · dir='' = 这套**正在生效位**(收编登记,没搬过文件);dir=<packId> = 独立副本躺在存档槽;
//   · 切换 = 两次 move:换出(生效位 → 活跃存档槽,无 dir='' 记录则新建收编槽)→ 换入(存档槽 → 生效位),
//     第二步失败回滚第一步;不走回收站(回收站只服务删除);
//   · 自编译导入自动存档(独立副本);官方 tpz 不存档(可重下,不替用户占盘)。
//
// 红线继承母计划:渲染层只给 versionId / packId 两个值,路径全在宿主拼;fs 与 db 全走注入缝可桩。
const fs = require('node:fs')
const path = require('node:path')
const { getDoc, putDoc, removeDoc, listDocs } = require('./store')
const fsutil = require('./fsutil')

const PACK_PREFIX = 'godot/tplpack/'

/** @typedef {import('../../../src/types/services').TemplatePack} TemplatePack */

/**
 * 存档记录(db `godot/tplpack/<packId>` 的文档体)。`dir=''` = 这套正在生效位(收编登记、没搬过文件);
 * `dir=<packId>` = 独立副本躺在存档槽。除 packId 外的目录位置运行时由根解析,换根零迁移。
 * @typedef {object} PackDoc
 * @property {string} packId
 * @property {string} versionId
 * @property {string} tag
 * @property {string} versionDir
 * @property {string} dir
 * @property {'selfbuild'|'adopted'} [source]
 * @property {number} [bytes]
 * @property {number} [createdAt]
 * @property {string[]} [writtenFlags]
 * @property {string} [mode]
 */

/**
 * 注入缝:fs 与 db 全走这里(文件头那条红线),测试整份换掉即可造 EXDEV / 缺目录 / 回收站炸。
 * `renameSync` 只有桩会传 —— 真宿主走 `fs.renameSync`。
 * @typedef {object} TplLibDeps
 * @property {(p: string) => boolean} existsSync
 * @property {(p: string) => string[]} readdirSync
 * @property {(s: string, d: string) => void} cpSync
 * @property {(p: string) => void} rmSync
 * @property {(p: string) => void} trashPath
 * @property {(p: string) => number} dirSize
 * @property {(exePath: string) => string} resolveBase
 * @property {(versionId: string) => { versionDir?: string, installed?: boolean }} status
 * @property {(id: string) => any} getDoc
 * @property {(id: string, doc: any) => any} putDoc
 * @property {(id: string) => any} removeDoc
 * @property {(prefix: string) => PackDoc[]} listDocs
 * @property {() => number} now
 * @property {(oldPath: string, newPath: string) => void} [renameSync]
 */

/** @returns {TplLibDeps} */
function realDeps() {
  // templates 懒 require:templates.js 顶部 require 本文件(自动存档钩子),顶层互 require 会拿到半空 exports
  const T = require('./templates')
  const { dirSize } = require('./extract')
  return {
    existsSync: fs.existsSync,
    readdirSync: (/** @type {string} */ p) => fs.readdirSync(p),
    cpSync: (/** @type {string} */ s, /** @type {string} */ d) => fs.cpSync(s, d, { recursive: true }),
    rmSync: (/** @type {string} */ p) => fs.rmSync(p, { recursive: true, force: true }),
    trashPath: (/** @type {string} */ p) => fsutil.trashPath(p, true),
    dirSize,
    resolveBase: (/** @type {string} */ exePath) => T.resolveTemplatesBase(exePath).base,
    status: (/** @type {string} */ versionId) => T.exportTemplateStatus({ versionId }),
    getDoc, putDoc, removeDoc, listDocs,
    now: () => Date.now()
  }
}

/** 同盘 rename、跨盘 EXDEV/EPERM 回退复制(与 templates.js:120 同形态);rename 走注入缝,桩可造 EXDEV */
function moveSync(/** @type {string} */ src, /** @type {string} */ dest, /** @type {TplLibDeps} */ deps) {
  const rename = deps.renameSync || fs.renameSync
  try {
    rename(src, dest)
  } catch (e) {
    if (/** @type {{code?: string}} */ (e).code !== 'EXDEV' && /** @type {{code?: string}} */ (e).code !== 'EPERM') throw e
    deps.cpSync(src, dest)
    deps.rmSync(src)
  }
}

function newPackId(/** @type {TplLibDeps} */ deps) {
  return `tpl-${deps.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 存档根:生效基目录的同级 tplpack/(同盘前提,任务书 §0 第 1 拍) */
function packRoot(/** @type {string} */ base) {
  return path.join(path.dirname(base), 'tplpack')
}

/** @returns {PackDoc|null} */
function readPack(/** @type {string} */ packId, /** @type {TplLibDeps} */ deps) {
  const d = deps.getDoc(PACK_PREFIX + packId)
  return d && d.packId ? d : null
}

/**
 * 某版本串下的存档列表(同 tag 多台引擎共享,任务书 §5)。列不出即空表,本函数没有失败分支。
 * @param {{base: string, versionDir: string}} params
 * @param {TplLibDeps} [deps]
 * @returns {{ok: true, packs: TemplatePack[]}}
 */
function listTemplatePacks(params, deps) {
  const d = deps || realDeps()
  const root = packRoot(params.base)
  const docs = d.listDocs(PACK_PREFIX) || []
  const packs = docs
    .filter((x) => x && x.versionDir === params.versionDir)
    .map((x) => ({
      packId: x.packId,
      versionId: x.versionId,
      tag: x.tag,
      versionDir: x.versionDir,
      source: /** @type {'selfbuild'|'adopted'} */ (x.source || 'adopted'),
      dir: x.dir || '',
      active: (x.dir || '') === '',
      bytes: x.bytes || 0,
      createdAt: x.createdAt || 0,
      writtenFlags: x.writtenFlags || [],
      mode: x.mode || '',
      path: (x.dir || '') === '' ? path.join(params.base, params.versionDir) : path.join(root, x.dir)
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
  return { ok: true, packs }
}

/**
 * 自编译导入后的自动存档:生效位 cpSync 一份独立副本进槽 + 写记录(dir=槽名,非 active)。
 * 失败由调用方(templates.js 的安装任务)收成 archiveError,不影响安装 ok。
 * @param {{base: string, dest: string, versionId: string, tag: string, versionDir: string, archive: {source?: string, writtenFlags?: string[], mode?: string}}} params
 * @param {TplLibDeps} [deps]
 * @returns {{packId: string}}
 */
function archiveFromInstall(params, deps) {
  const d = deps || realDeps()
  const packId = newPackId(d)
  const slot = path.join(packRoot(params.base), packId)
  d.cpSync(params.dest, slot)
  const rec = {
    packId,
    versionId: params.versionId,
    tag: params.tag,
    versionDir: params.versionDir,
    source: (params.archive && params.archive.source) || 'selfbuild',
    dir: packId,
    bytes: d.dirSize(slot),
    createdAt: d.now(),
    writtenFlags: (params.archive && params.archive.writtenFlags) || [],
    mode: (params.archive && params.archive.mode) || ''
  }
  d.putDoc(PACK_PREFIX + packId, rec)
  return { packId }
}

/**
 * 收编:把当前生效目录登记为 dir='' 的存档(**不搬文件**);首次被换出时才 move 进槽。
 * @param {{base: string, versionId: string, tag: string, versionDir: string}} params
 * @param {TplLibDeps} [deps]
 * @returns {{ok: true, packId: string} | {ok: false, error: string}}
 */
function adoptTemplatePack(params, deps) {
  const d = deps || realDeps()
  const dest = path.join(params.base, params.versionDir)
  if (!d.existsSync(dest)) return { ok: false, error: '当前没有生效中的模板目录,无从收编' }
  const listed = listTemplatePacks({ base: params.base, versionDir: params.versionDir }, d)
  if (listed.packs.some((p) => p.active)) return { ok: false, error: '已有「在生效位」的存档记录,不必重复收编' }
  const packId = newPackId(d)
  d.putDoc(PACK_PREFIX + packId, {
    packId,
    versionId: params.versionId,
    tag: params.tag,
    versionDir: params.versionDir,
    source: 'adopted',
    dir: '',
    bytes: d.dirSize(dest),
    createdAt: d.now(),
    writtenFlags: [],
    mode: ''
  })
  return { ok: true, packId }
}

/**
 * 切换生效:两次 move + 回滚(任务书 §5)。跨 versionDir 拒、已 active 早退;不设在途锁 —— 理由见下面那条注释。
 * @param {{base: string, versionId: string, versionDir: string, packId: string}} params
 * @param {TplLibDeps} [deps]
 * @returns {{ok: true, moved?: boolean} | {ok: false, error: string}}
 */
function activateTemplatePack(params, deps) {
  const d = deps || realDeps()
  const pack = readPack(params.packId, d)
  if (!pack) return { ok: false, error: `存档不存在:${params.packId}` }
  if (pack.versionDir !== params.versionDir) {
    return { ok: false, error: `存档的版本串是 ${pack.versionDir},与这台引擎要的 ${params.versionDir} 不符(编辑器按版本串找模板,跨串换入是静默失效)` }
  }
  if ((pack.dir || '') === '') return { ok: true, moved: false } // 已在生效位,不搬无谓的两步
  const root = packRoot(params.base)
  const slotSrc = path.join(root, pack.dir)
  if (!d.existsSync(slotSrc)) return { ok: false, error: `存档目录已不在:${slotSrc}(记录陈旧,请删除该存档)` }
  // 全程同步 fs(node 单线程,两次 move 之间没有 await,不需要在途锁 —— 锁会是钉不红的死分支)
  const dest = path.join(params.base, params.versionDir)
  let outSlot = ''
  let outRec = null
  // ---- 换出:生效位 → 活跃存档槽(无 dir='' 记录则新建收编槽)
  if (d.existsSync(dest)) {
    const listed = listTemplatePacks({ base: params.base, versionDir: params.versionDir }, d)
    const activeRec = listed.packs.find((p) => p.active)
    outSlot = activeRec ? activeRec.packId : newPackId(d)
    moveSync(dest, path.join(root, outSlot), d)
    outRec = activeRec
      ? { ...readPack(activeRec.packId, d), dir: activeRec.packId }
      : {
          packId: outSlot,
          versionId: params.versionId,
          tag: pack.tag,
          versionDir: params.versionDir,
          source: 'adopted',
          dir: outSlot,
          bytes: d.dirSize(path.join(root, outSlot)),
          createdAt: d.now(),
          writtenFlags: [],
          mode: ''
        }
    d.putDoc(PACK_PREFIX + outSlot, outRec)
  }
  // ---- 换入:存档槽 → 生效位;失败回滚换出
  try {
    moveSync(slotSrc, dest, d)
  } catch (e) {
    if (outSlot) {
      try { moveSync(path.join(root, outSlot), dest, d) } catch (e2) { /* 回滚也失败时保留现场,错误里点名 */ }
      d.putDoc(PACK_PREFIX + outSlot, outRec)
    }
    return { ok: false, error: `换入失败已回滚:${(e && e.message) || e}` }
  }
  d.putDoc(PACK_PREFIX + pack.packId, { ...pack, dir: '' })
  const prior = d.getDoc(`godot/templates/${params.versionId}`)
  if (prior) {
    d.putDoc(`godot/templates/${params.versionId}`, {
      ...prior,
      versionDir: params.versionDir,
      path: dest,
      fileCount: d.readdirSync(dest).length
    })
  }
  return { ok: true, moved: true }
}

/**
 * 删除存档:有槽目录的进回收站 + 除名;dir='' 的只除名(不动生效位,任务书 §6 末条)。
 * @param {{base: string, packId: string}} params
 * @param {TplLibDeps} [deps]
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function deleteTemplatePack(params, deps) {
  const d = deps || realDeps()
  const pack = readPack(params.packId, d)
  if (!pack) return { ok: false, error: `存档不存在:${params.packId}` }
  if ((pack.dir || '') !== '') {
    const slot = path.join(packRoot(params.base), pack.dir)
    if (d.existsSync(slot)) {
      try {
        d.trashPath(slot)
      } catch (e) {
        return { ok: false, error: `进回收站失败(回收站不可用?):${(e && e.message) || e}` }
      }
    }
  }
  d.removeDoc(PACK_PREFIX + params.packId)
  return { ok: true }
}

module.exports = {
  PACK_PREFIX,
  packRoot,
  listTemplatePacks,
  archiveFromInstall,
  adoptTemplatePack,
  activateTemplatePack,
  deleteTemplatePack,
  forVersion,
  listForVersion,
  activateForVersion,
  deleteForVersion,
  adoptForVersion
}

/**
 * versionId → 模板库操作上下文(base / versionDir / installed / tag);引擎记录或版本串读不出就 ok:false。
 * @param {string} versionId
 * @param {TplLibDeps} [deps]
 * @returns {{ok: false, error: string} | {ok: true, base: string, versionDir: string, installed: boolean, tag: string, versionId: string}}
 */
function forVersion(versionId, deps) {
  const d = deps || realDeps()
  const v = d.getDoc(versionId)
  if (!v || !v.tag) return { ok: false, error: '引擎记录不存在' }
  const st = d.status(versionId)
  if (!st.versionDir) return { ok: false, error: '读不到该引擎的模板版本串' }
  return { ok: true, base: d.resolveBase(v.exePath), versionDir: st.versionDir, installed: !!st.installed, tag: v.tag, versionId }
}

/** @param {string} versionId @param {TplLibDeps} [deps] */
function listForVersion(versionId, deps) {
  const d = deps || realDeps()
  const c = forVersion(versionId, d)
  if (!c.ok) return c
  return listTemplatePacks({ base: c.base, versionDir: c.versionDir }, d)
}

/** @param {string} versionId @param {string} packId @param {TplLibDeps} [deps] */
function activateForVersion(versionId, packId, deps) {
  const d = deps || realDeps()
  const c = forVersion(versionId, d)
  if (!c.ok) return c
  return activateTemplatePack({ base: c.base, versionId, versionDir: c.versionDir, packId }, d)
}

/** @param {string} versionId @param {string} packId @param {TplLibDeps} [deps] */
function deleteForVersion(versionId, packId, deps) {
  const d = deps || realDeps()
  const c = forVersion(versionId, d)
  if (!c.ok) return c
  return deleteTemplatePack({ base: c.base, packId }, d)
}

/** @param {string} versionId @param {TplLibDeps} [deps] @returns {{ok: true, packId: string} | {ok: false, error: string}} */
function adoptForVersion(versionId, deps) {
  const d = deps || realDeps()
  const c = forVersion(versionId, d)
  if (!c.ok) return c
  if (!c.installed) return { ok: false, error: '当前没有生效中的模板,无从收编' }
  return adoptTemplatePack({ base: c.base, versionId, tag: c.tag, versionDir: c.versionDir }, d)
}
