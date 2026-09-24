// useAddonSelection 回归测试:已装插件的多选与批量确认状态。
//
// 两条规则原本只能靠肉眼:刷新后清掉已不存在的选择、批量卸载是「点两次」的二次确认。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../../.gpm-test/out')

for (const name of ['useaddonselection', 'vueshim']) {
  if (!existsSync(path.join(OUT, `${name}.mjs`))) {
    console.error(`找不到打包产物: ${path.join(OUT, `${name}.mjs`)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

const { ref } = await import(pathToFileURL(path.join(OUT, 'vueshim.mjs')).href)
const { useAddonSelection } = await import(pathToFileURL(path.join(OUT, 'useaddonselection.mjs')).href)

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}  → ${extra}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const A = (dir, over = {}) => ({ dirName: dir, name: dir, enabled: true, hasCfg: true, ...over })

async function main() {
  // ---------- 1. 基本选择 ----------
  section('1. 单选 / 全选')
  {
    const addons = ref([A('d1'), A('d2'), A('d3')])
    const s = useAddonSelection(addons)
    ok(s.checked.value.length === 0, '初始未选中')
    ok(s.allChecked.value === false, '初始不是全选')
    ok(s.selAddons.value.length === 0, '初始无选中项')

    s.toggleCheck('d1')
    ok(s.checked.value.join(',') === 'd1', '勾选一项')
    ok(s.selAddons.value.length === 1 && s.selAddons.value[0].dirName === 'd1', 'selAddons 解析出对象')
    s.toggleCheck('d3')
    ok(s.checked.value.length === 2, '再勾一项')
    s.toggleCheck('d1')
    ok(s.checked.value.join(',') === 'd3', '再次点击取消勾选', s.checked.value.join(','))

    s.toggleAll()
    ok(s.checked.value.length === 3, '全选')
    ok(s.allChecked.value === true, 'allChecked 为真')
    s.toggleAll()
    ok(s.checked.value.length === 0, '再点全选变取消')

    // 空列表:allChecked 不能为真(否则按钮状态反了)
    const empty = useAddonSelection(ref([]))
    ok(empty.allChecked.value === false, '空列表时 allChecked 为 false')
    empty.toggleAll()
    ok(empty.checked.value.length === 0, '空列表全选后仍为空')
  }

  // ---------- 2. 启用/禁用混合判断 ----------
  section('2. hasEnabledSel / hasDisabledSel')
  {
    const addons = ref([A('d1', { enabled: true }), A('d2', { enabled: false }), A('d3', { enabled: true })])
    const s = useAddonSelection(addons)
    s.toggleCheck('d1')
    ok(s.hasEnabledSel.value === true && s.hasDisabledSel.value === false, '只选已启用 → 只能禁用')
    s.toggleCheck('d2')
    ok(s.hasEnabledSel.value === true && s.hasDisabledSel.value === true, '混合选择 → 两个按钮都可用')
    s.toggleCheck('d1')
    ok(s.hasEnabledSel.value === false && s.hasDisabledSel.value === true, '只选未启用 → 只能启用')
  }

  // ---------- 3. 二次确认 ----------
  section('3. 批量卸载的二次确认状态')
  {
    const addons = ref([A('d1')])
    const s = useAddonSelection(addons, { confirmMs: 5 })
    ok(s.confirmingBatch.value === false, '初始不在待确认态')
    s.armBatchConfirm()
    ok(s.confirmingBatch.value === true, 'arm 后进入待确认')
    await sleep(25)
    ok(s.confirmingBatch.value === false, '超时后自动解除(不会一直停在红色确认态)')

    s.armBatchConfirm()
    s.disarmBatchConfirm()
    ok(s.confirmingBatch.value === false, '可手动解除')

    // 选择变化会让待确认作废(用户改了选择,原确认不该继续有效)
    s.armBatchConfirm()
    s.toggleCheck('d1')
    ok(s.confirmingBatch.value === false, '勾选变化后待确认被解除')
    s.armBatchConfirm()
    s.toggleAll()
    ok(s.confirmingBatch.value === false, '全选后待确认被解除')

    // arm 重复调用会重置计时器,不应出现「提前解除」
    s.armBatchConfirm()
    await sleep(3)
    s.armBatchConfirm()
    await sleep(3)
    ok(s.confirmingBatch.value === true, '重复 arm 会重置计时(不会提前解除)')
    s.disarmBatchConfirm()
  }

  // ---------- 4. prune ----------
  section('4. prune:清掉列表中已不存在的选择')
  {
    const addons = ref([A('d1'), A('d2'), A('d3')])
    const s = useAddonSelection(addons)
    s.toggleCheck('d2')
    s.toggleCheck('d3')
    // 模拟卸载掉 d3
    addons.value = [A('d1'), A('d2')]
    s.prune()
    ok(s.checked.value.join(',') === 'd2', '只保留仍存在的选择', s.checked.value.join(','))

    // 全部消失
    addons.value = []
    s.prune()
    ok(s.checked.value.length === 0, '列表空时清空选择')

    // 未选中时调用安全
    s.prune()
    ok(s.checked.value.length === 0, '未选中时 prune 安全')
  }

  // ---------- 5. clear ----------
  section('5. clear')
  {
    const addons = ref([A('d1'), A('d2')])
    const s = useAddonSelection(addons)
    s.toggleAll()
    ok(s.checked.value.length === 2, '前置:已全选')
    s.clear()
    ok(s.checked.value.length === 0, 'clear 清空选择')
    ok(s.allChecked.value === false, 'clear 后 allChecked 为 false')
  }

  // ---------- 结果 ----------
  console.log(`\n${'='.repeat(56)}`)
  console.log(`PASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) {
    console.log('失败项:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('全部通过')
}

main().catch((e) => {
  console.error('\n未捕获异常:', e)
  process.exit(1)
})
