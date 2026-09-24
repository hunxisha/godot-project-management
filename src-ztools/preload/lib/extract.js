// 零依赖 ZIP 解压/打包:纯 Node 实现(zlib + 缓冲区解析),不依赖 PowerShell/unzip 等外部命令,
// 从根上规避执行策略、源文件扩展名检查、杀软误报等环境问题。
// 支持 stored(0)/deflate(8)条目、目录条目、UTF-8 文件名、路径穿越防护、zip64 检测。
//
// 重要:preload 与渲染层同线程,长循环会冻结界面。本模块所有遍历循环都通过
// fsutil.forEachSliced 周期性让出事件循环,并支持取消令牌。
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { forEachSliced, yieldToLoop, checkCancel } = require('./fsutil')

/** 确保目录存在 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** 定位 EOCD(End Of Central Directory)记录:从缓冲区尾部向前扫描签名 */
function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557) // EOCD + 最大注释长度 65535
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('ZIP 解析失败:未找到目录结束记录(文件可能下载不完整)')
}

/** EOCD + 最大注释长度的读取窗口 */
const EOCD_WINDOW = 65557

/**
 * 从文件句柄读取并解析中央目录。
 * 只读文件尾部窗口 + 中央目录区,不把整个 zip 载入内存(项目备份可能达数 GB)。
 * @returns {{fd:number, size:number, count:number, cd:Buffer}}
 */
function openCentralDirectory(zipPath) {
  const fd = fs.openSync(zipPath, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size < 22) throw new Error('ZIP 文件过小,可能下载不完整')
    const tailLen = Math.min(size, EOCD_WINDOW)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, tail, 0, tailLen, size - tailLen)
    const eocd = findEOCD(tail)
    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOff = tail.readUInt32LE(eocd + 16)
    if (cdOff === 0xFFFFFFFF || count === 0xFFFF) {
      throw new Error('ZIP64 格式暂不支持')
    }
    if (cdOff + cdSize > size) {
      throw new Error('ZIP 解析失败:中央目录越界(文件可能损坏)')
    }
    const cd = Buffer.alloc(cdSize)
    fs.readSync(fd, cd, 0, cdSize, cdOff)
    return { fd, size, count, cd }
  } catch (e) {
    fs.closeSync(fd)
    throw e
  }
}

/**
 * 解析中央目录条目。
 * @returns {{name:string, method:number, compSize:number, rawSize:number, dataOff:number}[]}
 */
function parseEntries(zipPath) {
  const { fd, size, count, cd } = openCentralDirectory(zipPath)
  try {
    const entries = []
    let ptr = 0
    for (let n = 0; n < count; n++) {
      if (ptr + 46 > cd.length || cd.readUInt32LE(ptr) !== 0x02014b50) {
        throw new Error('ZIP 解析失败:目录记录签名错误(文件可能损坏)')
      }
      const flags = cd.readUInt16LE(ptr + 8)
      const method = cd.readUInt16LE(ptr + 10)
      const compSize = cd.readUInt32LE(ptr + 20)
      const rawSize = cd.readUInt32LE(ptr + 24)
      const nameLen = cd.readUInt16LE(ptr + 28)
      const extraLen = cd.readUInt16LE(ptr + 30)
      const commentLen = cd.readUInt16LE(ptr + 32)
      const localOff = cd.readUInt32LE(ptr + 42)

      const nameRaw = cd.slice(ptr + 46, ptr + 46 + nameLen)
      const name = flags & 0x800 ? nameRaw.toString('utf8') : nameRaw.toString('latin1')
      ptr += 46 + nameLen + extraLen + commentLen

      // 定位本地文件头与其后的数据区
      if (localOff + 30 > size) {
        throw new Error('ZIP 解析失败:本地文件头越界: ' + name)
      }
      const lh = Buffer.alloc(30)
      fs.readSync(fd, lh, 0, 30, localOff)
      if (lh.readUInt32LE(0) !== 0x04034b50) {
        throw new Error('ZIP 解析失败:本地文件头签名错误: ' + name)
      }
      const lhNameLen = lh.readUInt16LE(26)
      const lhExtraLen = lh.readUInt16LE(28)
      const dataOff = localOff + 30 + lhNameLen + lhExtraLen
      if (dataOff + compSize > size) {
        throw new Error('ZIP 解析失败:条目数据越界(文件可能被截断): ' + name)
      }
      entries.push({ name, method, compSize, rawSize, dataOff })
    }
    return { entries, fd, size }
  } catch (e) {
    fs.closeSync(fd)
    throw e
  }
}

/**
 * 列出 zip 内的条目名(用于校验备份内容是否完整)。
 * @returns {{entries:string[], count:number}}
 */
function readZipEntries(zipPath) {
  const { entries, fd } = parseEntries(zipPath)
  fs.closeSync(fd)
  return { entries: entries.map((e) => e.name), count: entries.length }
}

/**
 * 解压 zip 到 destDir。
 * 逐个条目随机读取(峰值内存 = 单个最大文件),分片让出事件循环,支持取消与进度。
 * @param {string} zipPath zip 文件路径(任意扩展名)
 * @param {string} destDir 目标目录(自动创建)
 * @param {{
 *   onProgress?: (p:{phase:string,done:number,total:number,current:string,bytes:number}) => void,
 *   token?: object,
 *   sliceFiles?: number,
 *   sliceMs?: number,
 *   phase?: string
 * }} [opts] phase 用于覆盖进度里的阶段名(恢复流程传 'unpacking')
 */
async function extractZip(zipPath, destDir, opts) {
  const o = opts || {}
  const { entries, fd, size } = parseEntries(zipPath)
  try {
    ensureDir(destDir)
    const destRoot = path.resolve(destDir)
    let written = 0
    let sliceStart = Date.now()
    const sliceMs = (o.sliceMs || 30)
    const sliceFiles = (o.sliceFiles || 24)

    for (let n = 0; n < entries.length; n++) {
      const e = entries[n]

      // 防路径穿越(zip slip)
      const target = path.join(destRoot, e.name)
      const resolved = path.resolve(target)
      if (resolved !== destRoot && !resolved.startsWith(destRoot + path.sep)) {
        throw new Error('ZIP 条目路径非法: ' + e.name)
      }

      if (e.name.endsWith('/') || e.name.endsWith('\\')) {
        fs.mkdirSync(target, { recursive: true })
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const comp = Buffer.alloc(e.compSize)
        if (e.compSize) fs.readSync(fd, comp, 0, e.compSize, e.dataOff)
        let data
        if (e.method === 0) {
          data = comp
        } else if (e.method === 8) {
          data = zlib.inflateRawSync(comp) // 内置 adler32 校验,损坏数据会抛错
        } else {
          throw new Error('ZIP 条目使用了不支持的压缩方式(' + e.method + '): ' + e.name)
        }
        if (data.length !== e.rawSize) {
          throw new Error('ZIP 条目大小校验失败: ' + e.name)
        }
        fs.writeFileSync(target, data)
        written += data.length
      }

      if (o.onProgress) {
        o.onProgress({
          phase: o.phase || 'unpacking',
          done: n + 1,
          total: entries.length,
          current: e.name,
          bytes: written
        })
      }
      const last = n === entries.length - 1
      if (!last && (n % sliceFiles === sliceFiles - 1 || Date.now() - sliceStart > sliceMs)) {
        await yieldToLoop()
        checkCancel(o.token)
        sliceStart = Date.now()
      }
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 校验 zip 是否可解析且包含指定条目(如 project.godot)。
 * @returns {{ok:boolean, entries:string[], error?:string}}
 */
function inspectZip(zipPath, requiredEntry) {
  try {
    const { entries } = readZipEntries(zipPath)
    if (!entries.length) return { ok: false, entries, error: '压缩包内没有任何条目' }
    if (requiredEntry && !entries.includes(requiredEntry)) {
      return { ok: false, entries, error: `压缩包内未找到 ${requiredEntry}` }
    }
    return { ok: true, entries }
  } catch (e) {
    return { ok: false, entries: [], error: (e && e.message) || '压缩包无法解析' }
  }
}

/** 递归求目录字节大小 */
function dirSize(dir) {
  let total = 0
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else {
        try {
          total += fs.statSync(p).size
        } catch (e) { /* ignore */ }
      }
    }
  }
  try {
    walk(dir)
  } catch (e) {
    return 0
  }
  return total
}

// ---------- 零依赖 ZIP 打包(与解压对称:deflate 压缩 + 手写 zip 结构) ----------

/** CRC32 查表 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** Date → ZIP 的 DOS 时间字段 */
function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear())
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

/**
 * 把 srcDir 目录打包为 zip(分片让出事件循环,可取消)。
 * 调用方负责写临时路径并在成功后 rename,失败时清理 —— 本函数不保证失败后 zip 可用。
 *
 * @param {string} srcDir 源目录
 * @param {string} zipPath 目标 zip 文件(应为临时路径)
 * @param {{
 *   onProgress?: (p:{phase:string,done:number,total:number,current:string,bytes:number}) => void,
 *   includeCache?: boolean,
 *   exclude?: (name:string,isDir:boolean) => boolean,
 *   level?: 1|6|9,
 *   token?: object,
 *   phase?: string
 * }} [opts] includeCache=false 时跳过 .godot;exclude 命中则跳过该目录
 * @returns {Promise<{fileCount:number, bytes:number}>}
 */
async function createZip(srcDir, zipPath, opts) {
  const o = opts || {}
  const includeCache = o.includeCache !== false
  const exclude = o.exclude
  const level = o.level === 1 || o.level === 9 ? o.level : 6

  const files = []
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (exclude && exclude(ent.name, ent.isDirectory())) continue
      if (!includeCache && ent.isDirectory() && ent.name === '.godot') continue
      const abs = path.join(dir, ent.name)
      const relPath = rel ? rel + '/' + ent.name : ent.name
      if (ent.isDirectory()) walk(abs, relPath)
      else if (ent.isFile()) files.push({ abs, rel: relPath })
    }
  }
  walk(srcDir, '')
  const total = files.length

  const fd = fs.openSync(zipPath, 'w')
  const central = []
  let offset = 0
  try {
    await forEachSliced(files, (f, i) => {
      const data = fs.readFileSync(f.abs)
      const deflated = zlib.deflateRawSync(data, { level })
      const useDeflate = deflated.length < data.length
      const payload = useDeflate ? deflated : data
      const method = useDeflate ? 8 : 0
      const { time, date } = dosDateTime(fs.statSync(f.abs).mtime)
      const nameBuf = Buffer.from(f.rel, 'utf8')
      const crc = crc32(data)

      const lfh = Buffer.alloc(30)
      lfh.writeUInt32LE(0x04034b50, 0) // local file header 签名
      lfh.writeUInt16LE(20, 4) // version needed
      lfh.writeUInt16LE(0x0800, 6) // UTF-8 文件名标志
      lfh.writeUInt16LE(method, 8)
      lfh.writeUInt16LE(time, 10)
      lfh.writeUInt16LE(date, 12)
      lfh.writeUInt32LE(crc, 14)
      lfh.writeUInt32LE(payload.length, 18)
      lfh.writeUInt32LE(data.length, 22)
      lfh.writeUInt16LE(nameBuf.length, 26)
      // 注意:preload 环境无 fs.promises.write,统一用同步写(与解压侧同步 API 一致)
      fs.writeSync(fd, lfh)
      fs.writeSync(fd, nameBuf)
      fs.writeSync(fd, payload)

      central.push({ nameBuf, crc, method, time, date, compSize: payload.length, rawSize: data.length, offset })
      offset += 30 + nameBuf.length + payload.length
      if (o.onProgress) {
        o.onProgress({
          phase: o.phase || 'packing',
          done: i + 1,
          total,
          current: f.rel,
          bytes: offset
        })
      }
    }, { token: o.token, sliceFiles: o.sliceFiles, sliceMs: o.sliceMs })

    // central directory(cdSize 必须按实际写入字节累加,标准解压工具按该长度读取)
    const cdStart = offset
    let cdSize = 0
    for (const c of central) {
      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(0x02014b50, 0)
      cd.writeUInt16LE(20, 4) // version made by
      cd.writeUInt16LE(20, 6) // version needed
      cd.writeUInt16LE(0x0800, 8) // UTF-8 文件名标志
      cd.writeUInt16LE(c.method, 10)
      cd.writeUInt16LE(c.time, 12)
      cd.writeUInt16LE(c.date, 14)
      cd.writeUInt32LE(c.crc, 16)
      cd.writeUInt32LE(c.compSize, 20)
      cd.writeUInt32LE(c.rawSize, 24)
      cd.writeUInt16LE(c.nameBuf.length, 28)
      cd.writeUInt32LE(c.offset, 42)
      fs.writeSync(fd, cd)
      fs.writeSync(fd, c.nameBuf)
      cdSize += 46 + c.nameBuf.length
    }

    // EOCD
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(central.length, 8)
    eocd.writeUInt16LE(central.length, 10)
    eocd.writeUInt32LE(cdSize, 12)
    eocd.writeUInt32LE(cdStart, 16)
    fs.writeSync(fd, eocd)
    // 返回总字节数(本地数据 + central directory + EOCD),供备份记录显示
    return { fileCount: total, bytes: cdStart + cdSize + 22 }
  } finally {
    fs.closeSync(fd)
  }
}

module.exports = {
  ensureDir,
  dirSize,
  extractZip,
  inspectZip,
  readZipEntries,
  createZip
}
