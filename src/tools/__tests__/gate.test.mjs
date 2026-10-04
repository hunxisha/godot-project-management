// 工具页 P0b-B10a:按条勾选门(src/tools/gate.ts)的断言。
//
// 为什么这套判据必须是纯函数并且单独成文件(spec §5.3 规则 3):
// 高危动作(批量进回收站、批量改写源文件)从这里开始**逐条默认不选**,
// 「哪些条被选中」与「选中那几条要付出什么代价」是用户对盘上文件做处置的依据,
// 写进 .vue 就跑不进 Node harness —— 与 outcomeOf(Task 15 修复轮)、planFix(Task B1)同一先例。
// FixConfirmDialog 只渲染本文件的返回值,useTools.applyFix 只照 subsetPlan 给的清单调原语。
//
// 夹具直接吃 planFix 的真实产物(不手搓 FixPlan):门不许另写措辞,
// 那么「判据沿用父计划」这条硬要求只有拿真的父计划来比才测得出来。
//
// 用法(npm script 会先跑打包步骤):
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/gate.test.mjs
import { existsSync, readFileSync } from 'node:fs'
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

/** ext 推导与原语两端逐字一致(照 tools.test.mjs / orphans.test.mjs 同一份实现) */
function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}
function tree(specs) {
  const base = Date.UTC(2026, 0, 1)
  return specs.map(([rel, size, off = 0]) => ({ rel, size, mtimeMs: base + off * 86400000, ext: extOf(rel) }))
}

const TREE = tree([
  ['orphan/a.png', 1200],
  ['orphan/b.png', 300],
  ['orphan/c.png', 50],
  ['x.gd', 3],
  ['y.gd', 4],
  ['z.gd', 5]
])

/** 回收站通道的父计划:三条有体积 + 一条清单外(体积未知、带说明) + 一条越界(会被原语拒) */
const TRASH_RELS = ['orphan/a.png', 'orphan/b.png', 'orphan/c.png', 'gone/d.png', '/etc/passwd']
const trashFinding = (rels) => ({
  id: 'orphans:all',
  severity: 'warn',
  title: '未引用资源',
  fix: { kind: 'trash', label: '移除', payload: { rels } }
})
/** 改写通道的父计划:三条清单内 + 一条清单外(改写会新建、没有备份) */
const REWRITE_FILES = [
  { rel: 'x.gd', text: 'X' },
  { rel: 'y.gd', text: 'Y' },
  { rel: 'z.gd', text: 'Z' },
  { rel: 'new/w.gd', text: 'W' }
]
const rewriteFinding = (files) => ({
  id: 'format:all',
  severity: 'info',
  title: '代码格式化',
  fix: { kind: 'rewrite', label: '格式化', payload: { files } }
})

const P_TRASH = T.planFix(trashFinding(TRASH_RELS), TREE, true)
const P_TRASH_MAC = T.planFix(trashFinding(TRASH_RELS), TREE, false)
const P_REWRITE = T.planFix(rewriteFinding(REWRITE_FILES), TREE, true)
const P_NONE = T.planFix({ id: 'size:x', severity: 'info', title: 't' }, TREE, true)
const P_EXISTING = T.planFix(
  { id: 'cache:x', severity: 'info', title: 't', fix: { kind: 'existing', label: '去项目页清理', service: 'cleanProjectCache' } },
  TREE, true)
const P_BADPAYLOAD = T.planFix(trashFinding([{ nope: 1 }]), TREE, true)

const FIELDS = ['verb', 'warn', 'items', 'empty', 'service', 'reason', 'rels', 'files', 'bytes', 'kind']
/** 逐字段比(FixPlan 是十个字段的扁平对象;整体 JSON 比会随键序假红) */
const diffFields = (a, b) => FIELDS.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
const relsOf = (p) => p.rels.join(',')
const itemRels = (p) => p.items.map((i) => i.rel).join(',')

async function main() {
  // ---------- 0. 导出形状与纯函数红线 ----------
  section('0. 导出形状与纯函数红线')
  ok(typeof T.gateKind === 'function' && typeof T.subsetPlan === 'function' && typeof T.allRels === 'function',
    '三个判据都从 barrel 导出(harness 与视图取的是同一份实现)')
  ok(T.gateKind.length === 1 && T.subsetPlan.length === 2 && T.allRels.length === 1,
    '签名与简报一致:gateKind(plan) / subsetPlan(plan, selected) / allRels(plan)',
    `${T.gateKind.length}/${T.subsetPlan.length}/${T.allRels.length}`)
  const src = readFileSync(path.join(ROOT, 'src', 'tools', 'gate.ts'), 'utf8')
  // 只查**调用形状**,不查裸词(文件头注释里就写着「不碰 window / DOM / vue」,按裸词匹配会把注释算成违规)
  ok(!/\bwindow\.[a-zA-Z]|\bglobalThis\b|document\.|\bservices\.[a-zA-Z]|from ['"]vue['"]|from ['"]node:|require\(|readFileSync|writeFileSync/.test(src),
    '纯函数红线:gate.ts 没有 window/DOM/services/vue/Node 的调用形状',
    JSON.stringify((src.match(/\bwindow\.[a-zA-Z]|document\.|\bservices\.[a-zA-Z]|from ['"]vue['"]/g) || []).slice(0, 4)))
  ok(!/await|\.then\(|new Promise/.test(src), '纯函数红线:门里没有异步(判据要能同步进渲染路径与 harness)')

  // ---------- 1. gateKind:动盘动作一律逐条 ----------
  section('1. gateKind')
  ok(T.gateKind(P_TRASH) === 'per-item', 'trash 计划(移入回收站)默认逐条确认', T.gateKind(P_TRASH))
  ok(T.gateKind(P_REWRITE) === 'per-item', 'rewrite 计划(改写文件)默认逐条确认', T.gateKind(P_REWRITE))
  ok(T.gateKind(P_NONE) === 'whole', '只报告的计划没有勾选可言 → whole', T.gateKind(P_NONE))
  ok(T.gateKind(P_EXISTING) === 'whole', 'existing(跳转)→ whole', T.gateKind(P_EXISTING))
  // 判据只看 service,**不看 kind**:kind='trash' 但 payload 认不出(service=null)的计划永远执行不了,
  // 给它 per-item 就是摆一排勾了也没用的复选框(而 canRun 会因「至少选中一条」永远差最后一步)。
  ok(P_BADPAYLOAD.service === null && T.gateKind(P_BADPAYLOAD) === 'whole',
    '★kind=trash 但 service=null(执行不了)→ whole:gateKind 判的是 service 不是 kind',
    `${P_BADPAYLOAD.service}/${T.gateKind(P_BADPAYLOAD)}`)
  ok(T.gateKind(P_TRASH_MAC) === 'per-item', '非 Windows 的「永久删除」同样是逐条(风险更高,不是更低)', T.gateKind(P_TRASH_MAC))

  // ---------- 2. allRels:全选必须拿到全量(裁显示可以,裁 payload 不行) ----------
  section('2. allRels')
  ok(T.allRels(P_TRASH).join(',') === TRASH_RELS.join(','), 'trash 全选 = 父计划全部 rel,顺序就是父顺序', T.allRels(P_TRASH).join(','))
  ok(T.allRels(P_REWRITE).join(',') === 'x.gd,y.gd,z.gd,new/w.gd', 'rewrite 全选 = 全部 rel(含清单外那条会新建的)', T.allRels(P_REWRITE).join(','))
  ok(T.allRels(P_TRASH).length === P_TRASH.items.length && T.allRels(P_TRASH).length === 5,
    '条数与 items 一致(不是与渲染裁过的 shownItems 一致)', T.allRels(P_TRASH).length)
  const BIG = trashFinding(Array.from({ length: 250 }, (_, i) => `assets/o${String(i).padStart(3, '0')}.png`))
  const pBig = T.planFix(BIG, TREE, true)
  ok(T.allRels(pBig).length === 250, '★250 条时 allRels 仍给全量(视图的 RENDER_CAP 只裁画出来的行,不裁要删的账)',
    T.allRels(pBig).length)
  ok(T.allRels(P_NONE).length === 0 && Array.isArray(T.allRels(P_NONE)), 'whole/空计划 → 空数组而不是 undefined',
    JSON.stringify(T.allRels(P_NONE)))
  const rev = T.allRels(P_TRASH).join(',')
  ok(rev === TRASH_RELS.join(',') && T.allRels(P_TRASH).join(',') === rev,
    '同一份计划两次 allRels 逐字节一致(门不改动入参,也不按调用顺序换结果)', rev)

  // ---------- 3. subsetPlan 不得改变判据(措辞归 fixPlan.ts) ----------
  section('3. 判据沿用父计划:verb / warn / service / kind')
  const s1 = T.subsetPlan(P_TRASH, ['orphan/b.png'])
  ok(s1.verb === P_TRASH.verb && s1.warn === P_TRASH.warn && s1.service === P_TRASH.service && s1.kind === P_TRASH.kind,
    'trash 子集四个判据字段逐字等于父计划(门里另写措辞就是 B1 要防的漂移)', JSON.stringify(diffFields(P_TRASH, s1)))
  const s1mac = T.subsetPlan(P_TRASH_MAC, ['orphan/b.png'])
  ok(s1mac.verb === '永久删除' && s1mac.warn === P_TRASH_MAC.warn,
    '★非 Windows 的子集动词与风险句逐字沿用父计划的那句「永久删除…无法还原」(门不许把措辞改回可还原)',
    `${s1mac.verb}|${s1mac.warn}`)
  ok(!/可从回收站还原|随时还原|可撤销/.test(s1mac.warn),
    '子集里不出现任何还原承诺:把不可还原说成可还原会让用户以为能撤回而真的删掉东西', s1mac.warn)
  const s2 = T.subsetPlan(P_REWRITE, ['y.gd'])
  ok(s2.verb === P_REWRITE.verb && s2.warn === P_REWRITE.warn && s2.service === P_REWRITE.service && s2.kind === P_REWRITE.kind,
    'rewrite 子集同样只换清单不换判据', JSON.stringify(diffFields(P_REWRITE, s2)))
  ok(s1.reason === '' && s2.reason === '', '选中非空时 reason 保持空串(父计划本来就没有要拒绝的理由)', `${s1.reason}|${s2.reason}`)

  // ---------- 4. 空选择必须被拒(绝不静默什么都不做) ----------
  section('4. 空选择:empty + reason')
  const s0 = T.subsetPlan(P_TRASH, [])
  ok(s0.empty === true, 'selected 为空 → empty: true(执行层的 plan.empty 短路会拒掉它)', s0.empty)
  ok(typeof s0.reason === 'string' && s0.reason.length > 0 && /选|勾/.test(s0.reason),
    '★空选择带可读原因:不允许「点了没反应」(spec §5.3 规则 3 的反面)', JSON.stringify(s0.reason))
  ok(s0.items.length === 0 && relsOf(s0) === '' && s0.files.length === 0 && s0.bytes === 0,
    '空选择子集四条清单全空(不是把父计划原样交出去)', JSON.stringify([s0.items.length, s0.rels.length, s0.files.length, s0.bytes]))
  ok(s0.service === P_TRASH.service && s0.verb === P_TRASH.verb,
    '空选择不改判据:拒绝靠 empty+reason,而不是把计划伪装成「本管线执行不了」', `${s0.service}/${s0.verb}`)
  const s0r = T.subsetPlan(P_REWRITE, [])
  ok(s0r.empty === true && !!s0r.reason && s0r.files.length === 0,
    'rewrite 的空选择同样被拒(一个文件都不写)', JSON.stringify([s0r.empty, s0r.reason, s0r.files.length]))
  // 父计划自己就空/执行不了时,保留**父的理由**(比门的通用句更精确),不许覆盖成「没勾选」
  const sBad = T.subsetPlan(P_BADPAYLOAD, [])
  ok(sBad.empty === true && sBad.reason === P_BADPAYLOAD.reason,
    '父计划本来不可执行 → 沿用父 reason(不把「认不出修复数据」降级成「你没勾」)', JSON.stringify(sBad.reason))

  // ---------- 5. 去重与保序:点选顺序不许进 payload ----------
  section('5. 去重与保序')
  const byParent = T.subsetPlan(P_TRASH, ['orphan/b.png', 'orphan/a.png', 'orphan/c.png'])
  ok(itemRels(byParent) === 'orphan/a.png,orphan/b.png,orphan/c.png',
    '★乱序点选 → items 按父计划顺序(Finding.id 记账与两个宿主原语的报数口径都要求 payload 顺序确定)',
    itemRels(byParent))
  ok(relsOf(byParent) === 'orphan/a.png,orphan/b.png,orphan/c.png',
    '交给 movePathsToTrash 的 rels 同样按父顺序重排', relsOf(byParent))
  ok(byParent.bytes === 1200 + 300 + 50, 'bytes 按选中集合算(与顺序无关)', byParent.bytes)
  const dup = T.subsetPlan(P_TRASH, ['orphan/b.png', 'orphan/b.png', 'orphan/b.png'])
  ok(dup.items.length === 1 && relsOf(dup) === 'orphan/b.png' && dup.bytes === 300,
    '同一个 rel 点两次只算一条(重复计入会让预览说 2 个文件而盘上删 1 个)', JSON.stringify([dup.items.length, dup.bytes]))
  const full = T.subsetPlan(P_TRASH, T.allRels(P_TRASH))
  ok(diffFields(P_TRASH, full).length === 0,
    '★全选子集与父计划逐字段相同(allRels→subsetPlan 这条回路必须不改变任何东西)', JSON.stringify(diffFields(P_TRASH, full)))
  const fullRw = T.subsetPlan(P_REWRITE, T.allRels(P_REWRITE))
  ok(diffFields(P_REWRITE, fullRw).length === 0, 'rewrite 全选同样与父计划逐字段相同', JSON.stringify(diffFields(P_REWRITE, fullRw)))

  // ---------- 6. 陌生 rel 一律忽略:门不许凭空造出一条要删/要写的记录 ----------
  section('6. 父计划里没有的 rel')
  const ghost = T.subsetPlan(P_TRASH, ['orphan/a.png', 'never/mentioned.png'])
  ok(!itemRels(ghost).includes('never/mentioned.png') && !relsOf(ghost).includes('never/mentioned.png'),
    '★陌生 rel 不进 items 也不进 rels(凭空造记录 = 删一个用户从没勾选、计划里也从没有的文件)',
    `${itemRels(ghost)}|${relsOf(ghost)}`)
  ok(ghost.items.length === 1 && ghost.bytes === 1200, '陌生 rel 不占条数也不占体积', JSON.stringify([ghost.items.length, ghost.bytes]))
  const allGhost = T.subsetPlan(P_TRASH, ['nope/1.png', 'nope/2.png'])
  ok(allGhost.empty === true && !!allGhost.reason && relsOf(allGhost) === '',
    '全是陌生 rel → 与空选择同样被拒(而不是「执行了 0 项」的成功回执)', JSON.stringify([allGhost.empty, allGhost.reason]))
  const rwGhost = T.subsetPlan(P_REWRITE, ['x.gd', 'new/never.gd'])
  ok(rwGhost.files.length === 1 && rwGhost.files[0].rel === 'x.gd',
    'rewrite 的陌生 rel 不会变成一次凭空的新建', JSON.stringify(rwGhost.files))
  // selected 的形状不可信(视图给的是 string[],但门不能假设)
  const junk = T.subsetPlan(P_TRASH, [undefined, null, 42, '', 'orphan/c.png'])
  ok(itemRels(junk) === 'orphan/c.png' && junk.bytes === 50,
    '非字符串/空串元素一律忽略,只认父计划真有的那条', `${itemRels(junk)}|${junk.bytes}`)
  const notArray = T.subsetPlan(P_TRASH, undefined)
  ok(notArray.empty === true && !!notArray.reason,
    'selected 缺失(不是数组)→ 按空选择拒绝,不抛异常也不静默全删', JSON.stringify([notArray.empty, notArray.reason]))

  // ---------- 7. rewrite 子集:files 与 items 同序同键同长度(B1 的 Important 2) ----------
  section('7. rewrite 子集的 items / files 对齐')
  const rs = T.subsetPlan(P_REWRITE, ['z.gd', 'x.gd'])
  ok(itemRels(rs) === 'x.gd,z.gd', 'files 与 items 都按父顺序(z 先点也排后面)', itemRels(rs))
  ok(rs.files.length === rs.items.length && rs.files.every((f, i) => f.rel === rs.items[i].rel),
    '★items 与 files 同序同键同长度:预览说改 2 个,盘上就只落这 2 个的写',
    JSON.stringify([rs.items.length, rs.files.length, rs.files.map((f) => f.rel)]))
  ok(rs.files.map((f) => f.text).join('|') === 'X|Z',
    '新内容原样取自父计划(门不重新生成文本,也不许把 Y 的内容配到 Z 上)', rs.files.map((f) => f.text).join('|'))
  const one = T.subsetPlan(P_REWRITE, ['new/w.gd'])
  ok(one.files.length === 1 && one.files[0].text === 'W' && one.bytes === 0,
    '清单外那条(会新建、没有备份)可以被勾选,体积不臆造', JSON.stringify([one.files.length, one.bytes]))
  const ts = T.subsetPlan(P_TRASH, ['orphan/a.png', 'orphan/b.png'])
  ok(ts.files.length === 0 && ts.items.length === 2 && relsOf(ts) === 'orphan/a.png,orphan/b.png',
    'trash 子集 files 恒空(要删的东西在 rels 里,与父计划同形)', JSON.stringify([ts.files.length, ts.items.length]))

  // ---------- 8. bytes 只算选中的、size 与 note 不臆造 ----------
  section('8. 体积与说明的诚实性')
  const pick = T.subsetPlan(P_TRASH, ['orphan/a.png', 'orphan/c.png'])
  ok(pick.bytes === 1250 && pick.bytes < P_TRASH.bytes,
    'bytes = 选中项已知体积之和(1250 而不是整单的 1550)', `${pick.bytes}/${P_TRASH.bytes}`)
  const ghostItem = T.subsetPlan(P_TRASH, ['gone/d.png'])
  ok(ghostItem.items.length === 1 && ghostItem.items[0].size === undefined && !!ghostItem.items[0].note,
    '★清单外那条进子集后仍然「体积未知 + 带说明」(补 0 就是预览说 0 B 而原语随后报文件不存在)',
    JSON.stringify(ghostItem.items[0]))
  ok(ghostItem.bytes === 0 && ghostItem.empty === false, '未知体积不进 bytes,但照样是有效选择(原语自己去问磁盘)',
    `${ghostItem.bytes}/${ghostItem.empty}`)
  const rejected = T.subsetPlan(P_TRASH, ['/etc/passwd'])
  ok(rejected.items.length === 1 && rejected.items[0].note === T.REJECT_NOTE && relsOf(rejected) === '/etc/passwd',
    '越界那条被勾选时:原样保留 rel + 「原语会拒」的说明,不改写成项目内路径(绕过 resolveRel 的闸)',
    JSON.stringify(rejected.items[0]))
  ok(rejected.bytes === 0, '被拒项不计入合计体积', rejected.bytes)
  ok(P_TRASH.items.every((it, i) => {
    const sub = T.subsetPlan(P_TRASH, [it.rel])
    return sub.items.length === 1 && sub.items[0].rel === it.rel &&
      sub.items[0].size === it.size && sub.items[0].note === it.note
  }), '逐条单独勾选:每条的 rel/size/note 都与父计划那一条一致(5 条全查)')

  // ---------- 9. 不改动入参 ----------
  section('9. 纯计算:门不改动父计划')
  const before = JSON.stringify(P_TRASH)
  const beforeRewrite = JSON.stringify(P_REWRITE)
  T.subsetPlan(P_TRASH, ['orphan/a.png'])
  T.subsetPlan(P_REWRITE, ['x.gd', 'y.gd'])
  T.allRels(P_TRASH)
  ok(JSON.stringify(P_TRASH) === before, 'trash 父计划序列化前后逐字节相同(子集就地改 items 会让下一次预览少一条)', before === JSON.stringify(P_TRASH))
  ok(JSON.stringify(P_REWRITE) === beforeRewrite, 'rewrite 父计划同样没被动过', JSON.stringify(P_REWRITE) === beforeRewrite)
  ok(P_TRASH.items.length === 5 && P_REWRITE.files.length === 4,
    '父计划的 items/files 条数不变(门只读)', `${P_TRASH.items.length}/${P_REWRITE.files.length}`)
}

main().catch((e) => {
  console.error(`\n测试脚本抛错: ${e && e.stack ? e.stack : e}`)
  process.exit(1)
}).then(() => {
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
})
