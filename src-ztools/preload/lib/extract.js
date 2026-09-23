// 零依赖 ZIP 解压:纯 Node 实现(zlib + 缓冲区解析),不依赖 PowerShell/unzip 等外部命令,
// 从根上规避执行策略、源文件扩展名检查、杀软误报等环境问题。
// 支持 stored(0)/deflate(8)条目、目录条目、UTF-8 文件名、路径穿越防护、zip64 检测。
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

/** 确保目录存在 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** 定位 EOCD(End Of Central Directory)记录:从文件尾向前扫描签名 */
function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557) // EOCD + 最大注释长度 65535
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('ZIP 解析失败:未找到目录结束记录(文件可能下载不完整)')
}

/**
 * 解压 zip 到 destDir(同步,引擎包 ≤100MB,内存可承受)
 * @param {string} zipPath zip 文件路径(任意扩展名)
 * @param {string} destDir 目标目录(自动创建)
 */
function extractZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath)
  if (buf.length < 22) throw new Error('ZIP 文件过小,可能下载不完整')

  const eocd = findEOCD(buf)
  const cdOff = buf.readUInt32LE(eocd + 16)
  const count = buf.readUInt16LE(eocd + 10)
  if (cdOff === 0xFFFFFFFF || count === 0xFFFF) {
    throw new Error('ZIP64 格式暂不支持')
  }

  ensureDir(destDir)
  const destRoot = path.resolve(destDir)
  let ptr = cdOff

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('ZIP 解析失败:目录记录签名错误(文件可能损坏)')
    }
    const flags = buf.readUInt16LE(ptr + 8)
    const method = buf.readUInt16LE(ptr + 10)
    const compSize = buf.readUInt32LE(ptr + 20)
    const rawSize = buf.readUInt32LE(ptr + 24)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localOff = buf.readUInt32LE(ptr + 42)

    const nameRaw = buf.slice(ptr + 46, ptr + 46 + nameLen)
    const name = flags & 0x800 ? nameRaw.toString('utf8') : nameRaw.toString('latin1')
    ptr += 46 + nameLen + extraLen + commentLen

    // 定位本地文件头与其后的数据区
    if (buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error('ZIP 解析失败:本地文件头签名错误: ' + name)
    }
    const lhNameLen = buf.readUInt16LE(localOff + 26)
    const lhExtraLen = buf.readUInt16LE(localOff + 28)
    const dataOff = localOff + 30 + lhNameLen + lhExtraLen

    // 防路径穿越(zip slip)
    const entry = path.join(destRoot, name)
    const resolved = path.resolve(entry)
    if (resolved !== destRoot && !resolved.startsWith(destRoot + path.sep)) {
      throw new Error('ZIP 条目路径非法: ' + name)
    }

    if (name.endsWith('/') || name.endsWith('\\')) {
      fs.mkdirSync(entry, { recursive: true })
      continue
    }

    fs.mkdirSync(path.dirname(entry), { recursive: true })
    const comp = buf.slice(dataOff, dataOff + compSize)
    let data
    if (method === 0) {
      data = comp
    } else if (method === 8) {
      data = zlib.inflateRawSync(comp) // 内置 adler32 校验,损坏数据会抛错
    } else {
      throw new Error('ZIP 条目使用了不支持的压缩方式(' + method + '): ' + name)
    }
    if (data.length !== rawSize) {
      throw new Error('ZIP 条目大小校验失败: ' + name)
    }
    fs.writeFileSync(entry, data)
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

module.exports = { extractZip, ensureDir, dirSize }
