// 任务看板数据层测试:useTasks(默认板创建/切板/变更落库/失败回读/记忆与回退)。
//
// 两条关键约束,都用 db 桩锁住:
//  · 上次浏览的板记在 settings.taskBoardId,项目被删后回退通用板;
//  · 变更 = 纯函数算新板 → putDoc → 成功采纳 / 失败回读(saveError 置位)。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../../.gpm-test/out')

for (const name of ['usetasks', 'taskboard']) {
  if (!existsSync(path.join(OUT, `${name}.mjs`))) {
    console.error(`找不到打包产物: ${path.join(OUT, `${name}.mjs`)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

// ---------- 桩:window.ztools.db(内存 Map) ----------

const docs = new Map()
let rev = 0
let failPut = false

const dbApi = {
  get: (id) => (docs.has(id) ? { ...docs.get(id) } : null),
  put: (doc) => {
    if (failPut) return { error: true, name: 'conflict', message: 'stub conflict' }
    if (!doc || !doc._id) return { error: 'no id' }
    rev++
    docs.set(doc._id, { ...doc, _rev: `r${rev}` })
    return { ok: true, id: doc._id }
  },
  remove: (doc) => {
    docs.delete(doc._id)
    return { ok: true }
  },
  allDocs: (prefix) => [...docs.values()].filter((d) => d._id.startsWith(prefix)).map((d) => ({ ...d }))
}

global.window = { ztools: { db: dbApi } }

const P1 = 'godot/project/p1'
const P2 = 'godot/project/p2'
function seedProjects() {
  docs.set(P1, { _id: P1, id: P1, name: '项目一', path: 'X:/p1', favorite: true })
  docs.set(P2, { _id: P2, id: P2, name: '项目二', path: 'X:/p2', favorite: false })
}
function resetDb() {
  docs.clear()
  failPut = false
  seedProjects()
}

let freshSeq = 0
/** useTasks 是模块级单例 —— 每个用例组用 cache-busting import 拿一个全新实例 */
async function freshModule() {
  freshSeq++
  return import(`${pathToFileURL(path.join(OUT, 'usetasks.mjs')).href}?fresh=${freshSeq}`)
}

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`)
  }
}
function section(t) {
  console.log(`\n=== ${t} ===`)
}

async function main() {
  section('init 首次:无任何板 → 建默认板并落库,记忆写回 global')
  resetDb()
  let { useTasks } = await freshModule()
  let t = useTasks()
  await t.init()
  ok(t.currentKey.value === 'global', '落到通用板', t.currentKey.value)
  ok(t.board.value !== null && t.board.value.columns.length === 3, '默认板已就绪(3 列)')
  const savedBoard = docs.get('godot/taskboard/global')
  ok(!!savedBoard && savedBoard.columns.length === 3, '默认板已写入 db')
  ok(docs.get('godot/settings')?.taskBoardId === 'global', 'taskBoardId 写回 global')
  ok(t.projects.value.length === 2 && t.projects.value[0].name === '项目一', '项目列表已加载且收藏优先')

  section('init 恢复:taskBoardId 指向存在的项目 → 直接进该项目的板')
  resetDb()
  docs.set('godot/settings', { _id: 'godot/settings', taskBoardId: P2 })
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  ok(t.currentKey.value === P2, '恢复到项目二看板', t.currentKey.value)
  ok(t.board.value !== null && t.board.value.columns.length === 3, '项目板缺省时自动建默认板')
  ok(!!docs.get(`godot/taskboard/${P2}`), '项目默认板已落库')

  section('init 回退:taskBoardId 指向已删除的项目 → 回到通用板')
  resetDb()
  docs.set('godot/settings', { _id: 'godot/settings', taskBoardId: 'godot/project/gone' })
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  ok(t.currentKey.value === 'global', '回退到通用板', t.currentKey.value)
  ok(docs.get('godot/settings')?.taskBoardId === 'global', '回退结果写回 settings')

  section('selectBoard:通用 ⇄ 项目,过滤状态随板切换')
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  await t.selectBoard(P1)
  ok(t.currentKey.value === P1, '切到项目一')
  await t.addCard(t.board.value.columns[0].id, { title: '项目一的任务' })
  ok(t.board.value.columns[0].cards.length === 1, '卡片进当前板')
  ok(docs.get(`godot/taskboard/${P1}`).columns[0].cards.length === 1, '卡片落到项目一的文档')
  ok((docs.get('godot/taskboard/global')?.columns[0].cards ?? []).length === 0, '通用板不受影响')
  await t.selectBoard('global')
  ok(t.currentKey.value === 'global' && t.cardCount.value === 0, '切回通用板(空)')
  await t.selectBoard(P1)
  ok(t.cardCount.value === 1, '再切回项目一,数据还在')

  section('变更落库:add/rename/moveColumn/saveCard 换列')
  resetDb()
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  const col0 = t.board.value.columns[0].id
  const col1 = t.board.value.columns[1].id
  await t.addCard(col0, { title: '写周报', tags: ['日常'], priority: 'high' })
  const cid = t.board.value.columns[0].cards[0].id
  await t.updateCard(cid, { notes: '周五前' })
  ok(t.board.value.columns[0].cards[0].notes === '周五前', 'updateCard 生效')
  await t.saveCard(cid, { title: '写周报(改)' }, col1)
  const after = t.board.value
  ok(after.columns[0].cards.length === 0 && after.columns[1].cards[0].title === '写周报(改)', 'saveCard 换列 = 追加到目标列尾')
  const docAfter = docs.get('godot/taskboard/global')
  ok(docAfter.columns[1].cards[0].tags?.join() === '日常', 'db 与内存一致')
  await t.addColumn('评审')
  ok(t.board.value.columns.length === 4 && t.board.value.columns[3].title === '评审', 'addColumn')
  await t.moveColumn(t.board.value.columns[3].id, 0)
  ok(t.board.value.columns[0].title === '评审', 'moveColumn')
  await t.renameColumn(t.board.value.columns[0].id, '终审')
  ok(t.board.value.columns[0].title === '终审', 'renameColumn')
  await t.clearColumn(t.board.value.columns[1].id)
  ok(t.board.value.columns[1].cards.length === 0, 'clearColumn')
  await t.removeColumn(t.board.value.columns[1].id)
  ok(t.board.value.columns.length === 3, 'removeColumn')
  await t.removeCard(after.columns.find((c) => c.title === '进行中')?.cards[0]?.id)
  ok(t.cardCount.value === 0, 'removeCard')

  section('保存失败:回读以库为准 + saveError 置位,恢复后清空')
  resetDb()
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  await t.addCard(t.board.value.columns[0].id, { title: '已保存的卡片' })
  failPut = true
  await t.addCard(t.board.value.columns[0].id, { title: '会失败的卡片' })
  ok(t.saveError.value !== '', 'saveError 已置位', t.saveError.value)
  ok(t.cardCount.value === 1 && t.board.value.columns[0].cards[0].title === '已保存的卡片', '内存回读为库中内容')
  failPut = false
  await t.addCard(t.board.value.columns[0].id, { title: '恢复后的写入' })
  ok(t.saveError.value === '' && t.cardCount.value === 2, '恢复后 saveError 清空')

  section('列删光再进:不重建默认板(合法状态)')
  resetDb()
  docs.set('godot/taskboard/global', { _id: 'godot/taskboard/global', schema: 1, columns: [], updatedAt: 1 })
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  ok(t.board.value !== null && t.board.value.columns.length === 0, '空列看板保留')
  const recheck = docs.get('godot/taskboard/global')
  ok(recheck.columns.length === 0, 'db 未被重建默认板')

  section('二次 init:当前项目板的项目被删除 → 自动回退通用板')
  resetDb()
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  await t.selectBoard(P2)
  docs.delete(P2)
  await t.init()
  ok(t.currentKey.value === 'global', '回退通用板', t.currentKey.value)

  section('removeCard → undoDelete:恢复到原列原下标')
  resetDb()
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  const undoCol = t.board.value.columns[0].id
  await t.addCard(undoCol, { title: '甲' })
  await t.addCard(undoCol, { title: '乙' })
  await t.addCard(undoCol, { title: '丙' })
  const midId = t.board.value.columns[0].cards[1].id
  await t.removeCard(midId)
  ok(t.cardCount.value === 2 && t.lastDelete.value?.card.title === '乙', '删除后进入可撤销状态')
  ok(t.lastDelete.value.columnId === undoCol && t.lastDelete.value.index === 1, '记录原坐标')
  await t.undoDelete()
  ok(t.cardCount.value === 3 && t.board.value.columns[0].cards[1].title === '乙', '撤销后回到原位')
  ok(t.lastDelete.value === null, '撤销后清空可撤销状态')

  section('保存失败的删除:卡片已回读还原,不进入可撤销状态')
  resetDb()
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  await t.addCard(t.board.value.columns[0].id, { title: '留着的' })
  const failDelId = t.board.value.columns[0].cards[0].id
  failPut = true
  await t.removeCard(failDelId)
  ok(t.saveError.value !== '' && t.cardCount.value === 1, '失败回读,卡片还在')
  ok(t.lastDelete.value === null, '失败不记撤销')
  failPut = false

  section('切板 / 删列 / 清列作废撤销条')
  resetDb()
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  await t.addCard(t.board.value.columns[0].id, { title: '甲' })
  await t.removeCard(t.board.value.columns[0].cards[0].id)
  ok(t.lastDelete.value !== null, '待撤销')
  await t.selectBoard(P1)
  ok(t.lastDelete.value === null, '切板作废')
  await t.selectBoard('global')
  await t.addCard(t.board.value.columns[0].id, { title: '乙' })
  await t.removeCard(t.board.value.columns[0].cards[0].id)
  ok(t.lastDelete.value !== null, '再次待撤销')
  await t.removeColumn(t.board.value.columns[0].id)
  ok(t.lastDelete.value === null, '删列作废')
  await t.addCard(t.board.value.columns[0].id, { title: '丙' })
  await t.removeCard(t.board.value.columns[0].cards[0].id)
  await t.clearColumn(t.board.value.columns[0].id)
  ok(t.lastDelete.value === null, '清列作废')

  section('duplicateCard / setCardDone:生效并落库')
  resetDb()
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  await t.addCard(t.board.value.columns[0].id, { title: '原件', tags: ['x'], priority: 'high' })
  const origId = t.board.value.columns[0].cards[0].id
  await t.duplicateCard(origId)
  const duo = t.board.value.columns[0].cards
  ok(duo.length === 2 && duo[1].title === '原件(副本)' && duo[1].id !== origId, '副本紧随原件')
  ok(duo[1].priority === 'high' && duo[1].tags?.join() === 'x', '字段照搬')
  ok(docs.get('godot/taskboard/global').columns[0].cards.length === 2, '副本已落库')
  await t.setCardDone(origId, true)
  ok(t.board.value.columns[0].cards[0].done === true, '完成标记生效')
  ok(docs.get('godot/taskboard/global').columns[0].cards[0].done === true, '完成标记已落库')
  await t.setCardDone(origId, false)
  ok(t.board.value.columns[0].cards[0].done === undefined, '取消完成不残留 false')

  section('setColumnColor:生效并落库,可清色')
  resetDb()
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  const colId = t.board.value.columns[0].id
  await t.setColumnColor(colId, 'purple')
  ok(t.board.value.columns[0].color === 'purple', '列颜色生效')
  ok(docs.get('godot/taskboard/global').columns[0].color === 'purple', '列颜色已落库')
  await t.setColumnColor(colId, undefined)
  ok(t.board.value.columns[0].color === undefined, '不传即清色')
  ok(docs.get('godot/taskboard/global').columns[0].color === undefined, '清色已落库')

  section('setCardDoneOnBoard:旁路写非当前板文档,当前板走内存路径')
  resetDb()
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  await t.selectBoard(P1)
  await t.addCard(t.board.value.columns[0].id, { title: '项目一的卡' })
  const remoteCardId = t.board.value.columns[0].cards[0].id
  await t.selectBoard('global')
  const okRemote = await t.setCardDoneOnBoard(P1, remoteCardId, true)
  ok(okRemote === true, '旁路写库返回 true')
  ok(docs.get(`godot/taskboard/${P1}`).columns[0].cards[0].done === true, '非当前板卡片已标完成(直写文档)')
  ok(t.cardCount.value === 0, '当前板内存不受旁路影响')
  await t.addCard(t.board.value.columns[0].id, { title: '当前板的卡' })
  const localCardId = t.board.value.columns[0].cards[0].id
  await t.setCardDoneOnBoard('global', localCardId, true)
  ok(t.board.value.columns[0].cards[0].done === true, '当前板路径生效')
  ok(docs.get('godot/taskboard/global').columns[0].cards[0].done === true, '当前板路径已落库')

  section('检查项 / 批量操作:生效并落库')
  resetDb()
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  const listCol = t.board.value.columns[0].id
  await t.addCard(listCol, { title: '清单卡', checklist: [{ text: '子项一' }, { text: '子项二' }] })
  const clCard = t.board.value.columns[0].cards[0]
  ok(clCard.checklist?.length === 2, '检查项随卡片创建')
  await t.setChecklistItemDone(clCard.id, clCard.checklist[0].id, true)
  ok(t.board.value.columns[0].cards[0].checklist[0].done === true, '勾选检查项生效')
  ok(docs.get('godot/taskboard/global').columns[0].cards[0].checklist[0].done === true, '勾选检查项已落库')
  await t.addCard(listCol, { title: '甲' })
  await t.addCard(listCol, { title: '乙' })
  const [idA, idB] = t.board.value.columns[0].cards.slice(1).map((c) => c.id)
  await t.setCardsDone([idA, idB], true)
  ok(t.board.value.columns[0].cards.slice(1).every((c) => c.done === true), '批量完成生效')
  ok(docs.get('godot/taskboard/global').columns[0].cards.slice(1).every((c) => c.done === true), '批量完成已落库')
  await t.moveCards([idA], t.board.value.columns[1].id)
  ok(
    !t.board.value.columns[0].cards.some((c) => c.id === idA) &&
      t.board.value.columns[1].cards.some((c) => c.id === idA),
    '批量移动生效'
  )
  ok(docs.get('godot/taskboard/global').columns[1].cards.some((c) => c.id === idA), '批量移动已落库')
  await t.removeCards([idB])
  ok(!t.board.value.columns[0].cards.some((c) => c.id === idB), '批量删除生效')
  ok(!docs.get('godot/taskboard/global').columns[0].cards.some((c) => c.id === idB), '批量删除已落库')

  section('归档箱:归档 / 恢复 / 删除 / 清空')
  resetDb()
  ;({ useTasks } = await freshModule())
  t = useTasks()
  await t.init()
  const archiveCol = t.board.value.columns[0].id
  await t.addCard(archiveCol, { title: '归档候选' })
  const archivedId = t.board.value.columns[0].cards[0].id
  await t.archiveCard(archivedId)
  ok(t.cardCount.value === 0 && t.archivedCards.value.length === 1, '归档移出看板')
  ok(t.archivedCards.value[0].archivedFrom === archiveCol, '记录来源列')
  ok(docs.get('godot/taskboard/global').archived?.some((c) => c.id === archivedId), '归档已落库')
  const okRestore = await t.restoreArchivedCard(archivedId)
  ok(okRestore && t.cardCount.value === 1 && t.board.value.columns[0].cards[0].id === archivedId, '恢复到原列')
  ok(t.archivedCards.value.length === 0 && docs.get('godot/taskboard/global').archived?.length === 0, '恢复已落库')
  await t.setCardDone(archivedId, true)
  const archivedDone = await t.archiveDoneCards()
  ok(archivedDone === 1 && t.archivedCards.value.length === 1, '一键归档已完成返回数量')
  ok(docs.get('godot/taskboard/global').archived?.[0].done === true, '已完成卡归档时保留完成标记')
  await t.removeArchivedCard(archivedId)
  ok(t.archivedCards.value.length === 0 && docs.get('godot/taskboard/global').archived?.length === 0, '彻底删除归档卡')
  await t.addCard(archiveCol, { title: '归档一' })
  await t.addCard(archiveCol, { title: '归档二' })
  const clearIds = t.board.value.columns[0].cards.map((c) => c.id)
  await t.archiveCards(clearIds)
  ok(t.archivedCards.value.length === 2 && t.cardCount.value === 0, '批量归档')
  await t.clearArchivedCards()
  ok(t.archivedCards.value.length === 0 && docs.get('godot/taskboard/global').archived?.length === 0, '清空归档箱已落库')

  console.log(`\n结果: ${pass} 通过, ${failures.length} 失败`)
  if (failures.length) {
    console.error('失败项:\n - ' + failures.join('\n - '))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
