// 自编译模板 · 模板库的闸门(docs/tpllib-plan.md §7)。
//
// 桩法:db 用 Map 桩(getDoc/putDoc/removeDoc/listDocs),目录用真 tmp 树(rename/cp 真跑),
// trashPath / dirSize / now 注入;moveSync 的 rename 走注入缝,可造 EXDEV(跨盘回退)与
// 单点失败(换入回滚)。每条断言带「拿掉什么会红」的变异故事。
// 用法: node src-ztools/preload/lib/__tests__/tpllib.test.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const L = require('../tpllib')

let pass = 0
const failures = []
const ok = (c, l, e) => { if (c) { pass++; console.log(`  PASS  ${l}`) } else { failures.push(l); console.log(`  FAIL  ${l}${e !== undefined ? '  → ' + e : ''}`) } }

const VD = '4.7.2.stable'

function makeDeps(o = {}) {
  const db = new Map(o.docs || [])
  const calls = { trash: [], cp: [], rm: [], moves: [] }
  let clock = 1000
  const deps = {
    existsSync: (p) => fs.existsSync(p),
    readdirSync: (p) => fs.readdirSync(p),
    cpSync: (s, d) => { calls.cp.push([s, d]); if (o.cpFail) throw new Error('cpFail'); fs.cpSync(s, d, { recursive: true }) },
    rmSync: (p) => { calls.rm.push(p); fs.rmSync(p, { recursive: true, force: true }) },
    renameSync: (s, d) => {
      calls.moves.push([s, d])
      if (o.renameFailSrc && s === o.renameFailSrc) { const e = new Error('EACCES stub'); e.code = 'EACCES'; throw e }
      if (o.renameExdev) { const e = new Error('EXDEV stub'); e.code = 'EXDEV'; throw e }
      fs.renameSync(s, d)
    },
    trashPath: (p) => { calls.trash.push(p); if (o.trashFail) throw new Error('trashFail') },
    dirSize: (p) => (fs.existsSync(p) ? fs.readdirSync(p).length : 0),
    getDoc: (id) => db.get(id) || null,
    putDoc: (id, data) => { db.set(id, { ...data }); return true },
    removeDoc: (id) => { db.delete(id); return true },
    listDocs: (prefix) => [...db.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v),
    now: () => clock++
  }
  return { deps, calls, db }
}

function scene() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-tpllib-'))
  const base = path.join(tmp, 'export_templates')
  fs.mkdirSync(base, { recursive: true })
  return { tmp, base, root: path.join(tmp, 'tplpack') }
}

function mkDir(p, marker) {
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, 'windows_release_x86_64.exe'), marker)
}

const readMarker = (p) => fs.readFileSync(path.join(p, 'windows_release_x86_64.exe'), 'utf8')

function main() {
  console.log('=== 1. 列表:versionDir 过滤 + active 标 + createdAt 倒序 + 路径运行时解析 ===')
  {
    const { base } = scene()
    const docs = [
      ['godot/tplpack/p1', { packId: 'p1', versionId: 'v1', tag: '4.7.2-stable', versionDir: VD, source: 'selfbuild', dir: 'p1', bytes: 3, createdAt: 10, writtenFlags: ['disable_3d'], mode: 'default-on' }],
      ['godot/tplpack/p2', { packId: 'p2', versionId: 'v2', tag: '4.7.2-stable', versionDir: VD, source: 'adopted', dir: '', bytes: 4, createdAt: 20, writtenFlags: [], mode: '' }],
      ['godot/tplpack/p3', { packId: 'p3', versionId: 'v3', tag: '4.6-stable', versionDir: '4.6.stable', source: 'adopted', dir: '', bytes: 1, createdAt: 30, writtenFlags: [], mode: '' }]
    ]
    const { deps } = makeDeps({ docs })
    const r = L.listTemplatePacks({ base, versionDir: VD }, deps)
    ok(r.ok === true && r.packs.length === 2 && r.packs[0].packId === 'p2' && r.packs[0].active === true &&
      r.packs[1].active === false && r.packs[1].path === path.join(path.dirname(base), 'tplpack', 'p1'),
      '★列表按 versionDir 过滤(别版本串不混入)、dir=\'\' 标 active、倒序、槽路径运行时解析(改任一条 → 红)',
      JSON.stringify(r.packs))
  }

  console.log('\n=== 2. 自动存档:独立副本进槽 + 记录 dir=槽名 ===')
  {
    const s = scene()
    const dest = path.join(s.base, VD)
    mkDir(dest, 'A')
    const { deps, db } = makeDeps()
    const r = L.archiveFromInstall({ base: s.base, dest, versionId: 'v1', tag: '4.7.2-stable', versionDir: VD, archive: { source: 'selfbuild', writtenFlags: ['disable_3d'], mode: 'default-on' } }, deps)
    const rec = db.get('godot/tplpack/' + r.packId)
    ok(!!r.packId && readMarker(path.join(s.root, r.packId)) === 'A' && readMarker(dest) === 'A' &&
      rec.dir === r.packId && rec.source === 'selfbuild' && rec.writtenFlags[0] === 'disable_3d',
      '★存档是独立副本(生效位原样不动)、记录 dir=槽名带构建快照(改成引用不复制 → 红:下次覆盖安装存档跟着没)',
      JSON.stringify(rec))
  }

  console.log('\n=== 3. 收编:只记不搬 ===')
  {
    const s = scene()
    const dest = path.join(s.base, VD)
    mkDir(dest, 'A')
    const { deps, db } = makeDeps()
    const r = L.adoptTemplatePack({ base: s.base, versionId: 'v1', tag: '4.7.2-stable', versionDir: VD }, deps)
    const rec = r.ok ? db.get('godot/tplpack/' + r.packId) : null
    ok(r.ok === true && rec.dir === '' && fs.existsSync(dest) && readMarker(dest) === 'A',
      '★收编登记 dir=\'\' 且生效位文件一个没动(收编就搬 → 红:用户没要求却动了生效目录)', JSON.stringify(rec))
    const r2 = L.adoptTemplatePack({ base: s.base, versionId: 'v1', tag: '4.7.2-stable', versionDir: VD }, deps)
    ok(r2.ok === false && /重复收编/.test(r2.error), '★已有 dir=\'\' 记录时拒重复收编', r2.error)
    const s3 = scene()
    const r3 = L.adoptTemplatePack({ base: s3.base, versionId: 'v1', tag: '4.7.2-stable', versionDir: VD }, deps)
    ok(r3.ok === false && /无从收编/.test(r3.error), '★没有生效目录时收编如实拒', r3.error)
  }

  console.log('\n=== 4. 切换:两次 move + 记录与安装 doc 齐更新 ===')
  {
    const s = scene()
    const dest = path.join(s.base, VD)
    mkDir(dest, 'A')
    mkDir(path.join(s.root, 'pB'), 'B')
    const docs = [
      ['godot/tplpack/pB', { packId: 'pB', versionId: 'v1', tag: '4.7.2-stable', versionDir: VD, source: 'selfbuild', dir: 'pB', bytes: 1, createdAt: 5, writtenFlags: [], mode: '' }],
      ['godot/templates/v1', { versionId: 'v1', versionDir: VD, path: dest, fileCount: 1 }]
    ]
    const { deps, db, calls } = makeDeps({ docs })
    const r = L.activateTemplatePack({ base: s.base, versionId: 'v1', versionDir: VD, packId: 'pB' }, deps)
    const adoptRecs = [...db.entries()].filter(([k]) => k.startsWith('godot/tplpack/') && k !== 'godot/tplpack/pB')
    ok(r.ok === true && r.moved === true && readMarker(dest) === 'B' &&
      adoptRecs.length === 1 && readMarker(path.join(s.root, adoptRecs[0][1].dir)) === 'A' &&
      db.get('godot/tplpack/pB').dir === '' && db.get('godot/templates/v1').path === dest,
      '★换出(生效位→新收编槽)与换入(存档槽→生效位)两次 move 都真发生,两侧记录与安装 doc 齐更新(删任一次 move → 红)',
      JSON.stringify({ moves: calls.moves.length, adoptRecs: adoptRecs.map(([k]) => k) }))
  }

  console.log('\n=== 5. 切换的三个早退/拒 ===')
  {
    const s = scene()
    const dest = path.join(s.base, VD)
    mkDir(dest, 'A')
    const docs = [['godot/tplpack/pA', { packId: 'pA', versionId: 'v1', tag: '4.7.2-stable', versionDir: VD, source: 'adopted', dir: '', bytes: 1, createdAt: 1, writtenFlags: [], mode: '' }]]
    const { deps, calls } = makeDeps({ docs })
    const r0 = L.activateTemplatePack({ base: s.base, versionId: 'v1', versionDir: VD, packId: 'pA' }, deps)
    ok(r0.ok === true && r0.moved === false && calls.moves.length === 0,
      '★已 active 早退不搬(搬了 → 红:无谓的两次 move 还可能踩编辑器占用)', JSON.stringify(r0))
    const r1 = L.activateTemplatePack({ base: s.base, versionId: 'v1', versionDir: '4.6.stable', packId: 'pA' }, deps)
    ok(r1.ok === false && /版本串/.test(r1.error), '★跨 versionDir 拒(编辑器按版本串找模板,跨串换入是静默失效)', r1.error)
    const docs2 = [['godot/tplpack/pGone', { packId: 'pGone', versionId: 'v1', tag: '4.7.2-stable', versionDir: VD, source: 'selfbuild', dir: 'pGone', bytes: 1, createdAt: 1, writtenFlags: [], mode: '' }]]
    const { deps: d2 } = makeDeps({ docs: docs2 })
    const r2 = L.activateTemplatePack({ base: s.base, versionId: 'v1', versionDir: VD, packId: 'pGone' }, d2)
    ok(r2.ok === false && /已不在/.test(r2.error), '★存档槽目录缺失(记录陈旧)如实拒', r2.error)
  }

  console.log('\n=== 6. 换入失败回滚换出 ===')
  {
    const s = scene()
    const dest = path.join(s.base, VD)
    mkDir(dest, 'A')
    mkDir(path.join(s.root, 'pB'), 'B')
    const docs = [['godot/tplpack/pB', { packId: 'pB', versionId: 'v1', tag: '4.7.2-stable', versionDir: VD, source: 'selfbuild', dir: 'pB', bytes: 1, createdAt: 5, writtenFlags: [], mode: '' }]]
    const { deps, db } = makeDeps({ docs, renameFailSrc: path.join(s.root, 'pB') })
    const r = L.activateTemplatePack({ base: s.base, versionId: 'v1', versionDir: VD, packId: 'pB' }, deps)
    ok(r.ok === false && /回滚/.test(r.error) && fs.existsSync(dest) && readMarker(dest) === 'A' &&
      db.get('godot/tplpack/pB').dir === 'pB',
      '★换入失败:换出搬回去、记录复原、生效位内容还是 A(删回滚 → 红:用户生效模板凭空消失)', r.error)
  }

  console.log('\n=== 7. 跨盘 EXDEV:moveSync 回退复制+删 ===')
  {
    const s = scene()
    const dest = path.join(s.base, VD)
    mkDir(dest, 'A')
    mkDir(path.join(s.root, 'pB'), 'B')
    const docs = [['godot/tplpack/pB', { packId: 'pB', versionId: 'v1', tag: '4.7.2-stable', versionDir: VD, source: 'selfbuild', dir: 'pB', bytes: 1, createdAt: 5, writtenFlags: [], mode: '' }]]
    const { deps, calls } = makeDeps({ docs, renameExdev: true })
    const r = L.activateTemplatePack({ base: s.base, versionId: 'v1', versionDir: VD, packId: 'pB' }, deps)
    ok(r.ok === true && readMarker(dest) === 'B' && calls.cp.length >= 2 && calls.rm.length >= 2,
      '★rename 全 EXDEV 时回退复制+删,切换仍然完成(删回退 → 红:AppData 被重定向的机器切换全灭)', JSON.stringify({ cp: calls.cp.length }))
  }

  console.log('\n=== 8. 删除:槽目录进回收站 / dir=\'\' 只除名 / 回收站失败不除名 ===')
  {
    const s = scene()
    mkDir(path.join(s.root, 'pX'), 'X')
    const docs = [
      ['godot/tplpack/pX', { packId: 'pX', versionId: 'v1', tag: '4.7.2-stable', versionDir: VD, source: 'selfbuild', dir: 'pX', bytes: 1, createdAt: 1, writtenFlags: [], mode: '' }],
      ['godot/tplpack/pLive', { packId: 'pLive', versionId: 'v1', tag: '4.7.2-stable', versionDir: VD, source: 'adopted', dir: '', bytes: 1, createdAt: 2, writtenFlags: [], mode: '' }]
    ]
    const { deps, calls, db } = makeDeps({ docs })
    const r1 = L.deleteTemplatePack({ base: s.base, packId: 'pX' }, deps)
    ok(r1.ok === true && calls.trash.length === 1 && calls.trash[0] === path.join(s.root, 'pX') && !db.has('godot/tplpack/pX'),
      '★删除存档:槽目录进回收站 + 记录除名(直接 rm → 红:用户失去回收站退路)', JSON.stringify(calls.trash))
    const dest = path.join(s.base, VD)
    mkDir(dest, 'A')
    const r2 = L.deleteTemplatePack({ base: s.base, packId: 'pLive' }, deps)
    ok(r2.ok === true && calls.trash.length === 1 && !db.has('godot/tplpack/pLive') && fs.existsSync(dest),
      '★删除 dir=\'\' 只除名不动生效位(连生效位一起删 → 红:除名变成卸载)', String(r2.ok))
    const { deps: d3, db: db3 } = makeDeps({ docs: [['godot/tplpack/pY', { packId: 'pY', versionId: 'v1', tag: '4.7.2-stable', versionDir: VD, source: 'selfbuild', dir: 'pY', bytes: 1, createdAt: 1, writtenFlags: [], mode: '' }]], trashFail: true })
    mkDir(path.join(s.root, 'pY'), 'Y')
    const r3 = L.deleteTemplatePack({ base: s.base, packId: 'pY' }, d3)
    ok(r3.ok === false && db3.has('godot/tplpack/pY'), '★回收站失败不除名(记录和目录还在,可重试)', r3.error)
  }

  console.log('\n=== 9. 记录只存 packId:换 base(根迁移)后列表仍可解析 ===')
  {
    const s = scene()
    const base2 = path.join(s.tmp, 'elsewhere', 'export_templates')
    fs.mkdirSync(base2, { recursive: true })
    const docs = [['godot/tplpack/p1', { packId: 'p1', versionId: 'v1', tag: '4.7.2-stable', versionDir: VD, source: 'selfbuild', dir: 'p1', bytes: 1, createdAt: 1, writtenFlags: [], mode: '' }]]
    const { deps } = makeDeps({ docs })
    const r = L.listTemplatePacks({ base: base2, versionDir: VD }, deps)
    ok(r.packs.length === 1 && r.packs[0].path === path.join(path.dirname(base2), 'tplpack', 'p1'),
      '★记录不含绝对路径:根随 base 解析(记录存死路径 → 红:换根/换自包含模式后存档全失联)', r.packs[0] && r.packs[0].path)
  }

  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
}

main()
