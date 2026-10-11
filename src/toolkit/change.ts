// 工具箱 · `Change` 契约类型(取代旧体检层的 `FixPlan`)。
//
// 这一份与 manifest.ts 同属**会在 apiVersion 上冻结**的合同:第 2 批的批量重命名、第 3 批的画布工具
// 都要按这个形状产出,第三方插件也是。所以每个字段都要回答「谁生产、谁消费」,
// 不留「将来可能用得上」的空位(§3 自己反对臆想字段),也不把判据塞进渲染层。
//
// 三条来源分得很清,别混:
//   · `rel / kind / label / risk / reason / to / bytes / payload` —— **插件给**(它才知道自己要干什么);
//   · `outOfScope / creates / defaultSelected` —— **框架判定后覆盖**(§2.7 Q28:越界与默认勾选插件说了不算);
//   · `id` —— 插件可给;没给时框架按 `${toolId}:${kind}:${rel}` 补一个**稳定键**
//     (不含时间戳、不含序号:预览→勾选→执行三步之间要认得出「还是那一条」,旧 Finding.id 同一动机)。

/** 三种动盘形态。rename 在第 1 批只允许出现在预览里,执行通道第 2 批接(见 orchestrate.ts 的 RENAMED_UNSUPPORTED) */
export type ChangeKind = 'rewrite' | 'rename' | 'trash'

/** 插件自报的风险档。框架只会把它**升**到 high(越界),从不降级 */
export type ChangeRisk = 'low' | 'high'

/** 插件 `plan()` 该返回的形状。TS 里必填,运行时按未校验数据处理 */
export interface Change {
  /** 稳定键(可缺省,框架补) */
  id?: string
  /** 相对项目根、正斜杠 —— 对外只有 rel 这一个键,绝对路径由原语拼 */
  rel: string
  kind: ChangeKind
  /** 这一条要干什么,一句话(预览列表的行文案) */
  label: string
  risk: ChangeRisk
  /** 为什么是这个风险档:UI 悬停要显示,插件**必须**给 */
  reason: string
  /** kind:'rename' 的新名(相对项目根);非 rename 给了也忽略 */
  to?: string
  /** 体积:预览说「已选 N 个 / 共 X KB」用。不知道就别填,框架不臆造成 0 */
  bytes?: number
  /** apply 时才用得上的数据;'rewrite' 的正文可以放这里(payload.text) */
  payload?: unknown
}

/** 框架归一后的形状:id 与三个判定字段都有担保,渲染层可以直接信 */
export interface PlannedChange extends Change {
  id: string
  /** rel 不在用户选中范围内(§5.4 的头号兜底:选了 3 个 .gd,40 个 .tscn 不能跟着改) */
  outOfScope: boolean
  /** 框架据此走「新建没有备份」那句措辞;不是判据,只影响文案档 */
  creates: boolean
  /** 默认勾选规则:`risk==='low' && !outOfScope` */
  defaultSelected: boolean
}

/** 归一阶段被丢掉的条(宁可少动,但丢了几条、为什么丢必须说得出) */
export interface RejectedChange {
  /** 在插件返回数组里的下标(0-based,+1 显示) */
  index: number
  why: string
}

/** 一次 `plan()` 的完整结果。planError 与 changes 是互斥的两张嘴 */
export interface ChangePlan {
  toolId: string
  /** 完整清单:只按勾选裁子集,永远不裁「显示不下」(gate.ts 的纪律原样继承) */
  changes: PlannedChange[]
  /** `plan()` 没实现 / 抛异常 / 返回非数组的原因;空数组不算失败 */
  planError: string
  rejected: RejectedChange[]
  /** 用户选中的文件 rel(越界判据的那一侧,UI 要能复述它) */
  selectedRels: string[]
  /** 框架有没有拿到项目清单:拿不到时 `creates` 一律按 true 判,措辞退到最保守那一档 */
  treeKnown: boolean
}

/** 插件 `apply()` 的返回值。只描述这一条,不描述整批 */
export interface ApplyOutcome {
  ok: boolean
  /** kind:'rewrite' 的新正文。框架**只认字符串**:拿到 undefined 就不写(旧 gate.ts 的同一个教训) */
  text?: string
  /** ok:false 时给人看的原因;没给就用兜底串,不许留空 */
  error?: string
}

/** 单条执行的落点记录 */
export interface ExecutedItem {
  id: string
  rel: string
  kind: ChangeKind
  ok: boolean
  /** 失败原因,或 '已取消' */
  error?: string
  /** 写盘成功时原语回报的备份名(回滚要靠它) */
  backupRel?: string
}

/** 一次执行的回执:账本的一条、UI 回执卡的同一份数据 */
export interface ApplyReceipt {
  toolId: string
  projectId: string
  /** 时间戳只在**账本**里出现,不进 Change.id(稳定键纪律) */
  at: number
  items: ExecutedItem[]
  written: string[]
  moved: string[]
  failed: ExecutedItem[]
  backups: { rel: string; backupRel: string }[]
  /** 用户中途取消:剩余条目标 '已取消',已做的不回滚(回滚是账本的独立动作) */
  cancelled: boolean
  /** 零失败才算成功 */
  ok: boolean
}
