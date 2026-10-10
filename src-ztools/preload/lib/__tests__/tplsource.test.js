// 自编译模板 · 代下载源码的闸门(docs/tplsource-plan.md §7)。
//
// 为什么能全桩:实现体的下载 / 旁证 / 探头 / 盘闸 / tar 五个外部接触点全是注入缝
// (downloadTemplateSourceWith 的 deps);哈希与 rename/unlink/rm 走真 fs,落在 mkdtemp 临时目录,
// 不碰网络、不碰真盘用户数据。每条断言带「拿掉什么会红」的变异故事。
// 用法: node src-ztools/preload/lib/__tests__/tplsource.test.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')

const S = require('../tplsource')
const { TAR_EXE } = require('../buildtools')

let pass = 0
const failures = []
const ok = (c, l, e) => { if (c) { pass++; console.log(`  PASS  ${l}`) } else { failures.push(l); console.log(`  FAIL  ${l}${e !== undefined ? '  → ' + e : ''}`) } }

const TAG = '4.7.2-stable'
const shaHex = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const ASSET = Buffer.from('godot-fake-asset-bytes')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tplsrc-'))
}

function fakeChild() {
  const ee = new EventEmitter()
  const child = {
    stderr: new EventEmitter(),
    on: (ev, cb) => { ee.on(ev, cb); return child },
    kill() { child.killed = true },
    close: (code) => ee.emit('close', code),
    boom: (e) => ee.emit('error', e)
  }
  return child
}

/**
 * 场景 deps:existsSync 只特判 TAR_EXE,其余全真 fs(spawn 桩真建文件,形态闸因此是真的);
 * 下载 / 旁证 / 盘闸 / tar 由场景给。
 */
function depsFor(dir, o = {}) {
  const calls = { dl: [], dlCancel: 0, texts: [], spawns: [] }
  let pendingCancel = null
  const deps = {
    existsSync: (p) => (p === TAR_EXE ? o.tarExists !== false : fs.existsSync(p)),
    downloadResumable: (url, dest, opts) => {
      calls.dl.push({ url, dest, opts })
      if (o.dlError) {
        if (o.dlPartial) fs.writeFileSync(dest, ASSET.subarray(0, 7))
        return { promise: Promise.reject(new Error(o.dlError)), cancel() { calls.dlCancel++ } }
      }
      if (o.dlHang) {
        return {
          promise: new Promise((res, rej) => { pendingCancel = () => rej(new Error('已取消')) }),
          cancel() { calls.dlCancel++; if (o.dlPartial) fs.writeFileSync(dest, ASSET.subarray(0, 7)); if (pendingCancel) pendingCancel() }
        }
      }
      fs.writeFileSync(dest, o.assetBytes || ASSET)
      if (opts.onProgress) opts.onProgress((o.assetBytes || ASSET).length, (o.assetBytes || ASSET).length)
      return { promise: Promise.resolve(), cancel() { calls.dlCancel++ } }
    },
    getText: (url) => {
      calls.texts.push(url)
      if (o.sidecarError) return Promise.reject(new Error(o.sidecarError))
      return Promise.resolve(o.sidecarText !== undefined ? o.sidecarText : `${shaHex(o.assetBytes || ASSET)}  godot-${TAG}.tar.xz\n`)
    },
    statfsSync: () => o.statfs || { bsize: 4096, bavail: 1e9 },
    spawn: (cmd, args) => {
      calls.spawns.push({ cmd, args })
      const c = fakeChild()
      if (o.spawnCreate !== false) {
        const top = path.join(dir, `godot-${TAG}`)
        fs.mkdirSync(top, { recursive: true })
        fs.writeFileSync(path.join(top, 'junk.txt'), 'x')
        if (o.spawnShape !== false) {
          fs.writeFileSync(path.join(top, 'SConstruct'), 'env = Environment()\n')
          fs.writeFileSync(path.join(top, 'version.py'), 'short_name = "godot"\n')
        }
      }
      if (o.spawnHold) {
        deps._heldChild = c
      } else {
        process.nextTick(() => {
          if (o.spawnStderr) c.stderr.emit('data', Buffer.from(o.spawnStderr))
          c.close(o.closeCode ?? 0)
        })
      }
      return c
    }
  }
  return { deps, calls }
}

const run = (dir, onProgress, deps) => S.downloadTemplateSourceWith({ tag: TAG, destDir: dir }, onProgress, deps)

async function main() {
  console.log('=== 1. 成功路径:下载 → 旁证比对 → 解包 → 回 srcDir ===')
  {
    const dir = tmpDir()
    const stages = []
    const { deps, calls } = depsFor(dir)
    const r = await run(dir, (p) => stages.push(p.stage), deps)
    ok(r.ok === true && r.srcDir === path.join(dir, `godot-${TAG}`) &&
      calls.dl.length === 1 && calls.dl[0].opts.attempts === 3 &&
      JSON.stringify(stages) === JSON.stringify(['downloading', 'hashing', 'extracting']) &&
      fs.existsSync(path.join(dir, `godot-${TAG}.tar.xz`)) && !fs.existsSync(path.join(dir, `godot-${TAG}.tar.xz.part`)),
      '★三阶段次序与 srcDir 形态对,下载带 3 次尝试,成功后 .part 收走(删掉任一阶段或改 attempts → 红)',
      JSON.stringify({ r, stages }))
  }

  console.log('\n=== 2. 下载失败:.part 留着供续传,不解包 ===')
  {
    const dir = tmpDir()
    const { deps, calls } = depsFor(dir, { dlError: 'ECONNRESET', dlPartial: true })
    const r = await run(dir, null, deps)
    ok(r.ok === false && /下载失败/.test(r.error) && /\.part/.test(r.error) &&
      fs.existsSync(path.join(dir, `godot-${TAG}.tar.xz.part`)) && calls.spawns.length === 0,
      '★下载失败如实报且 .part 保留(把失败路径的保留约定删掉 → 红:重试从零下,白烧流量)', r.error)
  }

  console.log('\n=== 3. 顶目录已存在:拒,不覆盖用户既有目录 ===')
  {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, `godot-${TAG}`))
    const { deps, calls } = depsFor(dir)
    const r = await run(dir, null, deps)
    ok(r.ok === false && /目标目录已存在/.test(r.error) && calls.dl.length === 0,
      '★顶目录进门闸:已在一律拒且不下流量(删闸 → 红:tar 解进用户既有目录)', r.error)
  }

  console.log('\n=== 4. sha256 不匹配:拒解 + 删整包 ===')
  {
    const dir = tmpDir()
    const { deps, calls } = depsFor(dir, { sidecarText: 'f'.repeat(64) + '  godot-x.tar.xz\n' })
    const r = await run(dir, null, deps)
    ok(r.ok === false && /sha256/.test(r.error) && calls.spawns.length === 0 &&
      !fs.existsSync(path.join(dir, `godot-${TAG}.tar.xz`)),
      '★sha 不匹配拒解且删整包(删比对或删 unlink → 红:坏包进编译 / 坏包被续传)', r.error)
  }

  console.log('\n=== 5. 旁证 404:拒解,下载物保留可重试 ===')
  {
    const dir = tmpDir()
    const { deps, calls } = depsFor(dir, { sidecarError: 'HTTP 404' })
    const r = await run(dir, null, deps)
    ok(r.ok === false && /旁证/.test(r.error) && calls.spawns.length === 0 &&
      fs.existsSync(path.join(dir, `godot-${TAG}.tar.xz`)),
      '★旁证拉不到 = 拒解但包留着(改成"旁证缺失就跳过校验" → 红:完整性是这条链的生命线)', r.error)
  }

  console.log('\n=== 6. tar 探头缺:如实回落,不起下载 ===')
  {
    const dir = tmpDir()
    const { deps, calls } = depsFor(dir, { tarExists: false })
    const r = await run(dir, null, deps)
    ok(r.ok === false && /tar\.exe/.test(r.error) && /手动准备/.test(r.error) && calls.dl.length === 0,
      '★缺 tar.exe 直接回落手动准备(删探头闸 → 红:下完 45 MB 才告诉用户解不了)', r.error)
  }

  console.log('\n=== 7. 重入闸:在途时第二条同步拒 ===')
  {
    const dir = tmpDir()
    const { deps } = depsFor(dir, { dlHang: true })
    const first = run(dir, null, deps)
    await new Promise((r) => setTimeout(r, 10))
    const r2 = await S.downloadTemplateSourceWith({ tag: TAG, destDir: tmpDir() }, null, depsFor(tmpDir()).deps)
    ok(r2.ok === false && /在途/.test(r2.error),
      '★在途锁:第二条代下载同步拒(删锁 → 红:两个 tar 解同父目录互相踩)', r2.error)
    S.cancelTemplateSourceDownload()
    const r1 = await first
    ok(r1.ok === false && /已取消/.test(r1.error), '收口:第一条被取消后如实回已取消', r1.error)
  }

  console.log('\n=== 8. 解前盘闸:剩余 < 4 GB 拒解 ===')
  {
    const dir = tmpDir()
    const { deps, calls } = depsFor(dir, { statfs: { bsize: 4096, bavail: 100 } })
    const r = await run(dir, null, deps)
    ok(r.ok === false && /4 GB/.test(r.error) && calls.spawns.length === 0 &&
      fs.existsSync(path.join(dir, `godot-${TAG}.tar.xz`)),
      '★盘闸在解包前(删闸 → 红:解一半把用户盘写爆)', r.error)
  }

  console.log('\n=== 9. 解包结果形态不符:不当作源码根 ===')
  {
    const dir = tmpDir()
    const { deps } = depsFor(dir, { spawnShape: false })
    const r = await run(dir, null, deps)
    ok(r.ok === false && /形态不符/.test(r.error),
      '★解完验 SConstruct + version.py(删验 → 红:把随便什么目录回填成 srcDir 喂给面板)', r.error)
  }

  console.log('\n=== 10. 下载期取消:留 .part,如实回已取消 ===')
  {
    const dir = tmpDir()
    const { deps, calls } = depsFor(dir, { dlHang: true, dlPartial: true })
    const p = run(dir, null, deps)
    await new Promise((r) => setTimeout(r, 10))
    S.cancelTemplateSourceDownload()
    const r = await p
    ok(r.ok === false && /已取消/.test(r.error) && calls.dlCancel === 1 &&
      fs.existsSync(path.join(dir, `godot-${TAG}.tar.xz.part`)),
      '★下载期取消:cancel 真传到下载管线且 .part 留续传(删 cancel 转发 → 红:取消按钮是死的)', r.error)
  }

  console.log('\n=== 11. 解包期取消:kill tar + 清本次自创顶目录 ===')
  {
    const dir = tmpDir()
    const { deps, calls } = depsFor(dir, { spawnHold: true })
    const stages = []
    const p = run(dir, (x) => stages.push(x.stage), deps)
    await new Promise((r) => setTimeout(r, 20))
    S.cancelTemplateSourceDownload()
    ok(deps._heldChild && deps._heldChild.killed === true, '★取消把 kill 真传到 tar 子进程(删 kill → 红:tar 在后台继续解)')
    deps._heldChild.close(1)
    const r = await p
    ok(r.ok === false && /已取消/.test(r.error) && !fs.existsSync(path.join(dir, `godot-${TAG}`)) &&
      fs.existsSync(path.join(dir, `godot-${TAG}.tar.xz`)),
      '★解包期取消:半成品顶目录清掉、下载物保留可重试(删 rmTree → 红:用户盘留半棵树)', r.error)
    void calls
  }

  console.log('\n=== 12. tar 非 0 退出:带 stderr 尾报失败 + 清半成品 ===')
  {
    const dir = tmpDir()
    const { deps } = depsFor(dir, { closeCode: 2, spawnStderr: 'tar: Error opening archive' })
    const r = await run(dir, null, deps)
    ok(r.ok === false && /退出码 2/.test(r.error) && /Error opening archive/.test(r.error) &&
      !fs.existsSync(path.join(dir, `godot-${TAG}`)) && fs.existsSync(path.join(dir, `godot-${TAG}.tar.xz`)),
      '★tar 失败带退出码与 stderr 尾、清半成品留下载物(删任一 → 红:失败原因成黑箱 / 残树留盘)', r.error)
  }

  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
}

main().catch((e) => { console.error(e); process.exit(1) })
