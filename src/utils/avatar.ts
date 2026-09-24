// 项目头像渐变:按项目名哈希取固定的渐变组(同名项目在任何页面上都是同一个颜色)。
//
// 原实现逐字相同地存在于 ProjectsView.vue 与 Dashboard.vue(两处 5 行),属于阶段 1 收敛掉的
// 同类缺陷 —— 这里合成唯一实现。设计上这组渐变刻意不随色板变化(见 docs/theme-system.md),
// 所以哈希算法一旦改动,所有项目的头像颜色都会变;有断言锁住它。
const GROUPS = ['a', 'b', 'c', 'd'] as const

/** 项目名 → 渐变组名(a/b/c/d),用于 `g-<组名>` 样式类 */
export function gradOf(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return GROUPS[h % GROUPS.length]
}
