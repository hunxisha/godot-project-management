// 工具页 P0b-B10a:按条勾选门(spec §5.3 规则 3 的欠账,B1/B5/B9 三轮都记了这笔)。
//
// 「高危动作(trash 批量、rewrite 改写)在确认框里逐条默认不选」要落地,就得有人回答两个问题:
//   ① 这条修复要不要逐条确认 —— gateKind;
//   ② 用户勾了这几条之后,这次执行的清单与账目是什么 —— subsetPlan。
// 两个答案都必须是**纯函数判据**:它们决定往用户的盘上删哪几个文件、改哪几个文件,
// 写进 .vue 就跑不进 Node harness,而这里的错话没有回滚键(与 outcomeOf、planFix 两次抽出来同一理由)。
//
// 分工红线:
//   · 措辞(verb/warn/reason 文案)归 fixPlan.ts —— 门只**沿用**父计划的判据字段,一个字的措辞都不另写
//     (B1 建 planFix 就是为了「说错话只可能发生在一处」;在门里再写一遍动词就是第二条会漂移的规则)。
//   · 渲染归 FixConfirmDialog.vue —— 它只问 gateKind,不自己判「能不能选」。
//   · 执行归 useTools.applyFix —— 它拿 subsetPlan 的返回值过原有的两道短路,不绕过 plan.empty。
//
// 安全方向(九个检查器每一轮评审都重复的那句:**宁可少报,不许说错**):
//   · plan.items 永远是要动的**完整**清单,门只按勾选裁子集,裁掉的必须是「用户没选的」而不是「显示不下的」;
//   · 空选择必须**带着原因被拒**,不许静默什么都不做(§5.3 规则 3 的反面就是「点了没反应」);
//   · 勾选集合里父计划没有的 rel 一律忽略 —— 门不许凭空造出一条要删/要写的记录;
//   · 子集顺序按父计划顺序,不按点选顺序:Finding.id 记账与两个宿主原语的报数口径都要求 payload 确定
//     (与 uid.ts / orphans.ts / format.ts 的 byText 同一套确定性纪律)。
//
// 红线:纯函数。不碰 window、不碰 DOM、不碰 vue,没有异步。
import type { FixPlan, FixPlanItem } from './fixPlan'

/**
 * 空选择的拒绝理由。
 * 父计划自己有理由时(清单本来就空、payload 认不出、缺新内容)**沿用父的那句**——它比这句更精确;
 * 只有在「父计划本来能执行、是用户一条都没勾」这种情况下才用这句,否则回执会指着一条不存在的原因。
 */
export const NO_SELECTION_REASON = '没有勾选任何文件,已拒绝执行(至少要选中一条)'

/**
 * 哪些条需要用户逐条确认才算被选中:trash 与 rewrite 都是动盘动作,一律默认不选。
 *
 * 判据**只看 service**,不看 kind:kind='trash' 但 payload 认不出来的计划 service 为 null
 * (fixPlan.ts:229-237),它永远不会被执行,给它 per-item 等于摆一排勾了也没用的复选框,
 * 而 canRun 的「至少选中一条」会把一张本来就该显示 reason 的卡变成一条走不到的死路。
 * 反过来 service 非空就一定动盘(movePathsToTrash / writeProjectText 是两个动盘原语的全部名字),
 * 没有第三种执行通道 —— 新增通道时这里要跟着改,而不是在视图里补判据。
 */
export function gateKind(plan: FixPlan): 'per-item' | 'whole' {
  return plan.service === 'movePathsToTrash' || plan.service === 'writeProjectText' ? 'per-item' : 'whole'
}

/**
 * 全选(供「全选」按钮用),返回全部 rel。
 * 取 items 而不是 rels:改写通道的 rels 恒为空数组(fixPlan.ts:277-288 只填 files),
 * 用 rels 会让「全选」在格式化那张卡上返回 0 条 —— items 才是两个通道共同的完整清单。
 * 不裁长度:视图的 RENDER_CAP 只裁**画出来的行**,裁到这里就等于把删除 payload 缩水成前 200 个。
 */
export function allRels(plan: FixPlan): string[] {
  return plan.items.map((it) => it.rel)
}

/**
 * 从父计划与「已勾选的 rel 集合」产出子计划:items/rels/files/bytes/empty 重算,
 * verb/warn/service/kind 沿用同一套判据(措辞归 fixPlan.ts)。
 *
 * 逐条对应关系照 toItems(fixPlan.ts:172-209)的口径**重走一遍 items**,而不是自己再算一趟:
 * 父计划里那条 FixPlanItem 原样进子集 —— size 有就有、没有就没有(补 0 会让预览说「0 B」而原语随后
 * 报「文件不存在」),note(越界会拒 / 清单外 / 会新建没备份)跟着走,预览与执行仍然同源。
 *
 * @param selected 已勾选的 rel 集合。视图必须显式传(FixConfirmDialog 勾选状态 → ToolsView → applyFix);
 *                 非数组/非字符串元素按「没勾」处理,不抛异常 —— 门的判断结果要进磁盘动作,宁可少删不可多删。
 */
export function subsetPlan(plan: FixPlan, selected: string[]): FixPlan {
  const wanted = new Set<string>()
  if (Array.isArray(selected)) {
    for (const s of selected) {
      // 只收非空字符串:空串/undefined 之类的脏元素当「没勾」,而不是当一条要删的空路径记录
      if (typeof s === 'string' && s) wanted.add(s)
    }
  }

  const items: FixPlanItem[] = []
  const picked: string[] = []
  let bytes = 0
  // 按 items(=父计划顺序)遍历而不是按 selected(=点选顺序):payload 顺序必须与点选顺序无关。
  // Set 判定天然去重,同一个 rel 点两次只留一条(与 toItems 的首次优先去重同一口径)。
  for (const it of plan.items) {
    if (!wanted.has(it.rel)) continue
    items.push(it)
    picked.push(it.rel)
    if (typeof it.size === 'number') bytes += it.size
  }

  // 改写通道的新内容按 **rel** 取,不按行号对齐:父计划的 items 与 files 同序同键同长度,
  // 但门只认 rel 这一个键 —— 用行号就把「两条数组必须等长」变成了判据的一部分。
  // 拿不到新内容的那条**不进 files**:宁可少写一个文件,也不交出 text 为 undefined 的写入请求
  // (writeProjectText 会照它把文件覆成空内容,而那不在「用户勾了这条」的授权范围内)。
  const textOf = new Map<string, string>()
  for (const f of plan.files) {
    if (f && typeof f.text === 'string' && !textOf.has(f.rel)) textOf.set(f.rel, f.text)
  }
  const files: { rel: string; text: string }[] = []
  if (plan.service === 'writeProjectText') {
    for (const it of items) {
      const text = textOf.get(it.rel)
      if (typeof text === 'string') files.push({ rel: it.rel, text })
    }
  }

  const empty = items.length === 0
  return {
    verb: plan.verb,
    warn: plan.warn,
    items,
    empty,
    service: plan.service,
    // 空选择必须带原因:applyFix 的第一道短路就是 `plan.service === null || plan.empty`(useTools.ts:419),
    // 它把 reason 原样上浮成回执 —— 留空串就等于「点了没反应」。
    reason: empty ? plan.reason || NO_SELECTION_REASON : '',
    // trash 通道要交给原语的就是勾选后的 rels;rewrite 通道 rels 恒空(要动的东西在 files 里),
    // 与父计划同形,不让回执的 rels 字段在两条通道之间说出两种话。
    rels: plan.service === 'movePathsToTrash' ? picked : [],
    files,
    bytes,
    kind: plan.kind
  }
}
