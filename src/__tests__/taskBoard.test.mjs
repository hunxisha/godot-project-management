// 任务看板纯函数测试:建板、列与卡片的增删改移、标签汇总、过滤与截止日状态。
// 全部走打包产物(.gpm-test/out/taskboard.mjs),npm run test:renderer 会先跑打包。
//
// 用法:node src/__tests__/taskBoard.test.mjs
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../.gpm-test/out')
const BUNDLE = path.join(OUT, 'taskboard.mjs')

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const B = await import(pathToFileURL(BUNDLE).href)

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

/** 固定 id 的测试板:两列,[A] 在列1;时间戳固定便于断言 */
function fixture() {
  const board = {
    schema: 1,
    columns: [
      { id: 'c1', title: '待办', cards: [card('A', '任务A'), card('B', '任务B')] },
      { id: 'c2', title: '进行中', cards: [card('C', '任务C')] }
    ],
    updatedAt: 100
  }
  return board
}
function card(id, title, extra = {}) {
  return { id, title, createdAt: 1, updatedAt: 1, ...extra }
}
const titles = (b, colId) => (b.columns.find((c) => c.id === colId)?.cards ?? []).map((c) => c.title)

async function main() {
  section('createDefaultBoard:默认三列')
  const def = B.createDefaultBoard(1234)
  ok(def.schema === 1, 'schema = 1')
  ok(def.updatedAt === 1234, 'updatedAt 用注入时间')
  ok(def.columns.length === 3, '默认 3 列', def.columns.length)
  ok(JSON.stringify(def.columns.map((c) => c.title)) === '["待办","进行中","已完成"]', '默认列名 待办/进行中/已完成')
  ok(def.columns.every((c) => c.cards.length === 0 && c.id), '每列有 id 且为空')

  section('addCard:追加到列尾')
  const b1 = B.addCard(fixture(), 'c1', { title: '  新任务  ', priority: 'high', due: '2030-01-02', tags: ['x', ' y ', 'x'] })
  ok(b1 !== undefined && b1 !== null, '返回新板')
  ok(titles(b1, 'c1').join(',') === '任务A,任务B,新任务', '追加到列尾并裁剪标题', titles(b1, 'c1'))
  const nc = b1.columns[0].cards[2]
  ok(nc.priority === 'high' && nc.due === '2030-01-02', '优先级与截止日写入')
  ok(JSON.stringify(nc.tags) === '["x","y"]', '标签去重裁剪', nc.tags)
  ok(nc.createdAt > 0 && nc.updatedAt >= nc.createdAt, '时间戳已生成')
  ok(b1.updatedAt >= nc.createdAt, '板 updatedAt 同步')
  ok(B.addCard(fixture(), 'c1', { title: '   ' }).columns[0].cards.length === 2, '空标题不改动')
  ok(B.addCard(fixture(), 'nope', { title: 'x' }).columns[0].cards.length === 2, '列不存在不改动')

  section('updateCard:patch 出现的键才生效')
  const b2 = B.updateCard(fixture(), 'A', { title: '改名', notes: '备注', tags: ['t1'] })
  const a2 = b2.columns[0].cards[0]
  ok(a2.title === '改名' && a2.notes === '备注' && a2.tags?.join() === 't1', '字段更新', a2)
  ok(a2.due === undefined && a2.priority === undefined, '未出现的键保持原值')
  ok(b2.columns[0].cards[1].updatedAt === 1, '其他卡片不动')
  ok(B.updateCard(fixture(), 'A', { title: '  ' }).columns[0].cards[0].title === '任务A', '空标题不采纳')
  ok(B.updateCard(fixture(), 'A', { notes: '  ' }).columns[0].cards[0].notes === undefined, '空备注清空')
  ok(B.updateCard(fixture(), 'A', { due: '' }).columns[0].cards[0].due === undefined, '空截止日清空')
  ok(B.updateCard(fixture(), 'A', { tags: [] }).columns[0].cards[0].tags === undefined, '空标签数组清空')
  ok(B.updateCard(fixture(), 'nope', { title: 'x' }) !== undefined, '卡片不存在不崩溃')
  ok(B.updateCard(fixture(), 'A', { priority: 'normal' }).columns[0].cards[0].priority === 'normal', '优先级可改')
  ok(B.updateCard(fixture(), 'A', { done: true }).columns[0].cards[0].done === true, 'done 可标记')
  const doneBoard = { schema: 1, columns: [{ id: 'c1', title: '待办', cards: [card('A', '任务A', { done: true })] }], updatedAt: 1 }
  ok(B.updateCard(doneBoard, 'A', { done: false }).columns[0].cards[0].done === undefined, '取消完成不残留 false')
  ok(B.updateCard(fixture(), 'A', { color: 'blue' }).columns[0].cards[0].color === 'blue', '色板内颜色可设')
  ok(B.updateCard(fixture(), 'A', { color: 'rainbow' }).columns[0].cards[0].color === undefined, '非法色板 key 视为清色')

  section('removeCard')
  const b3 = B.removeCard(fixture(), 'A')
  ok(titles(b3, 'c1').join() === '任务B', '摘除指定卡片', titles(b3, 'c1'))
  ok(B.removeCard(fixture(), 'nope').columns[0].cards.length === 2, '不存在的卡片不改动')

  section('duplicateCard:副本插在原卡之后')
  const d1 = B.duplicateCard(fixture(), 'A')
  ok(titles(d1, 'c1').join() === '任务A,任务A(副本),任务B', '副本紧随原卡', titles(d1, 'c1'))
  const dup = d1.columns[0].cards[1]
  ok(!!dup.id && dup.id !== 'A', '副本有新 id')
  ok(dup.createdAt >= 1 && dup.updatedAt >= dup.createdAt, '副本时间戳刷新')
  const rich = {
    schema: 1,
    columns: [{ id: 'c1', title: '待办', cards: [card('A', '富卡片', { notes: 'n', priority: 'high', due: '2030-01-02', tags: ['t'], done: true, color: 'red' })] }],
    updatedAt: 1
  }
  const rc = B.duplicateCard(rich, 'A').columns[0].cards[1]
  ok(rc.notes === 'n' && rc.priority === 'high' && rc.due === '2030-01-02' && rc.tags?.join() === 't' && rc.done === true && rc.color === 'red', '其余字段照搬')
  ok(B.duplicateCard(fixture(), 'nope').columns[0].cards.length === 2, '不存在的卡片不改动')

  section('restoreCard:撤销删除的插回')
  const orig = fixture()
  const snap = orig.columns[0].cards[0]
  const gone = B.removeCard(orig, 'A')
  const back = B.restoreCard(gone, 'c1', 0, snap)
  ok(titles(back, 'c1').join() === '任务A,任务B', '插回原下标', titles(back, 'c1'))
  ok(back.columns[0].cards[0].id === 'A', 'id 不变')
  ok(titles(B.restoreCard(gone, 'c1', 99, snap), 'c1').join() === '任务B,任务A', '越界下标钳到列尾')
  ok(B.restoreCard(gone, 'nope', 0, snap) === gone, '列不存在不改动')

  section('cardPosition')
  ok(JSON.stringify(B.cardPosition(fixture(), 'C')) === '{"columnId":"c2","index":0}', '跨列定位', B.cardPosition(fixture(), 'C'))
  ok(B.cardPosition(fixture(), 'nope') === null, '找不到 → null')

  section('moveCard:跨列与列内')
  const m1 = B.moveCard(fixture(), 'A', 'c2', 0)
  ok(titles(m1, 'c1').join() === '任务B' && titles(m1, 'c2').join() === '任务A,任务C', '跨列移动到列首', [titles(m1, 'c1'), titles(m1, 'c2')])
  const m2 = B.moveCard(fixture(), 'A', 'c2', 99)
  ok(titles(m2, 'c2').join() === '任务C,任务A', '越界下标钳到列尾', titles(m2, 'c2'))
  const m3 = B.moveCard(fixture(), 'A', 'c1', 2) // 原坐标:插到 B 之后
  ok(titles(m3, 'c1').join() === '任务B,任务A', '同列后移(消化摘出偏移)', titles(m3, 'c1'))
  const m4 = B.moveCard(fixture(), 'B', 'c1', 0)
  ok(titles(m4, 'c1').join() === '任务B,任务A', '同列前移', titles(m4, 'c1'))
  const m5 = B.moveCard(fixture(), 'A', 'c1', 1) // 插到原下标1(B)之前 = 原位不动
  ok(titles(m5, 'c1').join() === '任务A,任务B', '同列原位', titles(m5, 'c1'))
  ok(B.moveCard(fixture(), 'nope', 'c1', 0).columns[0].cards.length === 2, '卡片不存在不改动')
  ok(B.moveCard(fixture(), 'A', 'nope', 0).columns[0].cards.length === 2, '目标列不存在不改动')

  section('列操作:add/rename/remove/clear/move')
  const c1 = B.addColumn(fixture(), ' 评审 ')
  ok(c1.columns.length === 3 && c1.columns[2].title === '评审', '新建列追加到末尾并裁剪')
  ok(B.addColumn(fixture(), '  ').columns.length === 2, '空列名不改动')
  const c2 = B.renameColumn(fixture(), 'c1', '收件箱')
  ok(c2.columns[0].title === '收件箱', '重命名列')
  ok(B.renameColumn(fixture(), 'c1', '').columns[0].title === '待办', '空名不改动')
  const colColor = B.updateColumn(fixture(), 'c1', { color: 'cyan' })
  ok(colColor.columns[0].color === 'cyan', '列颜色可设')
  ok(B.updateColumn(colColor, 'c1', { color: undefined }).columns[0].color === undefined, '列颜色可清')
  ok(B.updateColumn(fixture(), 'c1', { color: 'rainbow' }).columns[0].color === undefined, '列非法色板 key 视为清色')
  ok(B.updateColumn(fixture(), 'nope', { color: 'cyan' }).columns.length === 2, '列不存在不改动')
  const c3 = B.removeColumn(fixture(), 'c1')
  ok(c3.columns.length === 1 && c3.columns[0].id === 'c2', '删除列')
  const c4 = B.clearColumn(fixture(), 'c1')
  ok(c4.columns.length === 2 && c4.columns[0].cards.length === 0, '清空列保留列本身')
  ok(B.clearColumn(c4, 'c1') === c4, '清空已空列返回原板(调用方不写库)')
  ok(B.clearColumn(fixture(), 'c2').columns[1].cards.length === 0, '清空有卡列')
  const c5 = B.moveColumn(fixture(), 'c2', 0)
  ok(c5.columns.map((x) => x.id).join() === 'c2,c1', '列前移', c5.columns.map((x) => x.id))
  const c6 = B.moveColumn(fixture(), 'c1', 2)
  ok(c6.columns.map((x) => x.id).join() === 'c2,c1', '列后移消化偏移', c6.columns.map((x) => x.id))
  ok(B.moveColumn(fixture(), 'c1', 99).columns.map((x) => x.id).join() === 'c2,c1', '列越界钳到末尾')

  section('boardTags / countCards')
  const t1 = B.boardTags({
    schema: 1,
    columns: [
      { id: 'c1', title: 'a', cards: [card('A', 'x', { tags: ['ui', 'bug'] }), card('B', 'y', { tags: ['ui'] })] },
      { id: 'c2', title: 'b', cards: [card('C', 'z', { tags: ['audio'] })] }
    ],
    updatedAt: 1
  })
  ok(JSON.stringify(t1) === '["audio","bug","ui"]', '标签去重排序', t1)
  ok(B.countCards(fixture()) === 3, '卡片总数')

  section('dueState / todayStr / addDays')
  const today = B.todayStr()
  ok(/^\d{4}-\d{2}-\d{2}$/.test(today), 'todayStr 格式', today)
  ok(B.dueState(undefined) === null, '未设置 → null')
  ok(B.dueState('2030-12-31', '2030-06-01') === null, '未来日期 → null')
  ok(B.dueState('2030-06-01', '2030-06-01') === 'today', '今天 → today')
  ok(B.dueState('2030-05-31', '2030-06-01') === 'overdue', '过去日期 → overdue')
  ok(B.dueState('2030-06-02', '2030-06-01') === 'soon', '明天 → soon')
  ok(B.dueState('2030-06-04', '2030-06-01') === 'soon', '第 3 天 → soon(窗口含边)')
  ok(B.dueState('2030-06-05', '2030-06-01') === null, '第 4 天 → null(窗口外)')
  ok(B.addDays('2030-01-30', 3) === '2030-02-02', 'addDays 跨月进位')
  ok(B.addDays('2030-12-31', 1) === '2031-01-01', 'addDays 跨年进位')
  ok(B.addDays('2030-6-1', 1) === '2030-6-1', '格式不合法原样返回')

  section('matchCard:关键词(含标签文本)+ 标签 + 优先级 + 仅逾期')
  const probe = card('A', '实现存档系统 API', { notes: '记得处理加密', tags: ['ui'], priority: 'high', due: '2000-01-01' })
  ok(B.matchCard(probe, {}) === true, '无条件全过')
  ok(B.matchCard(probe, { query: '存档' }) === true, '标题命中')
  ok(B.matchCard(probe, { query: '加密' }) === true, '备注命中')
  ok(B.matchCard(probe, { query: 'ui' }) === true, '标签文本命中')
  ok(B.matchCard(probe, { query: 'api' }) === true, '大小写不敏感')
  ok(B.matchCard(probe, { query: 'ABC' }) === false, '未命中')
  ok(B.matchCard(probe, { tags: ['ui'] }) === true, '标签命中')
  ok(B.matchCard(probe, { tags: ['net'] }) === false, '标签未命中')
  ok(B.matchCard(probe, { query: '存档', tags: ['net'] }) === false, '关键词过但标签不过')
  ok(B.matchCard(probe, { priority: 'high' }) === true, '优先级命中')
  ok(B.matchCard(probe, { priority: 'low' }) === false, '优先级不过')
  ok(B.matchCard(card('B', '未设优先级'), { priority: 'normal' }) === true, '未设置按 normal 匹配')
  ok(B.matchCard(probe, { overdueOnly: true }) === true, '仅逾期:逾期未完成卡通过')
  ok(B.matchCard(card('C', '未来卡', { due: '2099-12-31' }), { overdueOnly: true }) === false, '仅逾期:未逾期不通过')
  ok(B.matchCard(card('D', '今日到期', { due: B.todayStr() }), { overdueOnly: true }) === false, '仅逾期:今日不算逾期')
  ok(B.matchCard(card('E', '已完成', { due: '2000-01-01', done: true }), { overdueOnly: true }) === false, '仅逾期:已完成被排除')

  section('normalizeBoard:宽容读取')
  ok(B.normalizeBoard(null) === null, '空文档 → null')
  ok(B.normalizeBoard(undefined) === null, 'undefined → null')
  const good = fixture()
  ok(B.normalizeBoard(good).columns.length === 2, '合法文档原样通过')
  const messy = B.normalizeBoard({
    columns: [
      { id: 'c1', title: 'ok', cards: [card('A', 'x'), { title: '无id' }, null, { id: 'z', title: '  ' }] },
      { title: '无id列', cards: [] },
      null,
      'bad'
    ]
  })
  ok(messy.columns.length === 2, '剔除坏列', messy.columns.length)
  ok(messy.columns[0].cards.length === 1, '剔除坏卡片')
  ok(messy.columns[1].id && messy.columns[1].title === '无id列', '缺 id 列补生成')
  ok(messy.schema === 1 && messy.updatedAt === 0, '缺省字段给默认值')
  const emptyCols = B.normalizeBoard({ schema: 1, columns: [], updatedAt: 5 })
  ok(emptyCols !== null && emptyCols.columns.length === 0, '列被删光是合法状态(不是缺失)')
  const withMeta = B.normalizeBoard({
    columns: [
      {
        id: 'c1',
        title: 'ok',
        color: 'red',
        cards: [card('A', 'x', { done: true, color: 'cyan' }), card('B', 'y', { done: false, color: 'rainbow' })]
      }
    ]
  })
  ok(withMeta.columns[0].color === 'red', '列颜色保留')
  ok(withMeta.columns[0].cards[0].done === true && withMeta.columns[0].cards[0].color === 'cyan', '卡片 done/color 合法值保留')
  ok(withMeta.columns[0].cards[1].done === undefined && withMeta.columns[0].cards[1].color === undefined, 'done=false / 非法色剔除')
  ok(B.normalizeBoard(fixture()).columns[0].cards[0].done === undefined, '老数据(无新字段)视为未完成、无色')

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
