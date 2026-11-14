// 引擎使用热力图的纯函数聚合:日 key / 色阶 / 网格构建 / 汇总统计。
// 数据源是 godot/usage/day/* 文档,minutes 的采集语义见 src-ztools/preload/lib/usage.js
// (工坊窗口存活期间的进程采样)。dayKeyOf 在 preload 侧有一份同构实现,两边必须
// 保持一致的格式 —— 本地时区 'YYYY-MM-DD'。

/** 本地时区 'YYYY-MM-DD'(与 preload/lib/usage.js 的 dayKeyOf 保持同构) */
export function dayKeyOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 当日使用分钟 → 色阶 0-4(0=无记录;>0 / ≥30 / ≥90 / ≥180 逐档加深)。
 * 阈值刻意放得低:1 档只要「碰过引擎」,后三档才有「用了一阵 / 半天 / 一整天」的观感差。
 */
export function levelOf(minutes: number): 0 | 1 | 2 | 3 | 4 {
  if (!minutes || minutes <= 0) return 0
  if (minutes >= 180) return 4
  if (minutes >= 90) return 3
  if (minutes >= 30) return 2
  return 1
}

/** 分钟 → 人话:45 → 「45 分钟」;75 → 「1 小时 15 分」;120 → 「2 小时」(fmtDuration 面向毫秒/秒,这里是分钟口径) */
export function fmtMinutes(m: number): string {
  const total = Math.max(0, Math.round(m))
  if (total < 60) return `${total} 分钟`
  const h = Math.floor(total / 60)
  const mm = total % 60
  return mm ? `${h} 小时 ${mm} 分` : `${h} 小时`
}

/** 热力图单格 */
export interface HeatCell {
  /** 本地时区 'YYYY-MM-DD' */
  key: string
  date: Date
  minutes: number
  level: 0 | 1 | 2 | 3 | 4
  /** 今天之后的格子:渲染上隐掉,但保留占位对齐 */
  future: boolean
}

/** 一列(一周,周一起始);monthLabel 为该列月份刻度(无则 null) */
export interface HeatColumn {
  cells: HeatCell[]
  monthLabel: string | null
}

/**
 * 构建周一起始的热力图网格:末列对齐本周,weeks 列往前推;
 * 月份刻度取每列中间格(周四)的月份,与上一列不同才标 —— 近似 GitHub 的刻度位置。
 * @param days dayKey → 分钟
 * @param opts.weeks 列数(默认 26 ≈ 半年)
 * @param opts.now 注入的当前时刻(测试用;缺省 Date.now())
 */
export function buildHeatmapGrid(
  days: Record<string, number>,
  opts?: { weeks?: number, now?: number }
): HeatColumn[] {
  const weeks = Math.max(1, Math.floor(opts?.weeks ?? 26))
  const now = opts?.now ?? Date.now()
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  // 周一=0 … 周日=6(JS getDay() 周日=0,先折算)
  const todayIdx = (today.getDay() + 6) % 7
  const weekStart = new Date(today)
  weekStart.setDate(weekStart.getDate() - todayIdx) // 本周一
  const gridStart = new Date(weekStart)
  gridStart.setDate(gridStart.getDate() - (weeks - 1) * 7)

  const columns: HeatColumn[] = []
  let prevMonth = -1
  for (let w = 0; w < weeks; w++) {
    const cells: HeatCell[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(gridStart)
      d.setDate(d.getDate() + w * 7 + i)
      const key = dayKeyOf(d.getTime())
      const minutes = days[key] || 0
      cells.push({
        key,
        date: d,
        minutes,
        level: levelOf(minutes),
        future: d.getTime() > today.getTime()
      })
    }
    const mid = cells[3].date
    const month = mid.getMonth()
    const label = month !== prevMonth ? `${month + 1}月` : null
    prevMonth = month
    columns.push({ cells, monthLabel: label })
  }
  return columns
}

/** 本周合计(本周一起,含今天) */
export function weekMinutes(days: Record<string, number>, now?: number): number {
  const nowTs = now ?? Date.now()
  const today = new Date(nowTs)
  today.setHours(0, 0, 0, 0)
  const monday = new Date(today)
  monday.setDate(monday.getDate() - ((today.getDay() + 6) % 7))
  let sum = 0
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday)
    d.setDate(d.getDate() + i)
    if (d.getTime() > today.getTime()) break
    sum += days[dayKeyOf(d.getTime())] || 0
  }
  return sum
}

/**
 * 连续使用天数:从今天往回数「分钟 > 0」的天;今天还没用不算断,从昨天继续数。
 * @returns 连续天数(没有任何记录时 0)
 */
export function streakOf(days: Record<string, number>, now?: number): number {
  const nowTs = now ?? Date.now()
  const cur = new Date(nowTs)
  cur.setHours(0, 0, 0, 0)
  let streak = 0
  for (let i = 0; i < 3650; i++) {
    const key = dayKeyOf(cur.getTime())
    const m = days[key] || 0
    if (m > 0) {
      streak++
    } else if (i === 0) {
      // 今天还没用:不断签,从昨天接着数
    } else {
      break
    }
    cur.setDate(cur.getDate() - 1)
  }
  return streak
}

/** 全部日子的累计分钟 */
export function totalMinutes(days: Record<string, number>): number {
  return Object.values(days).reduce((a, b) => a + (b || 0), 0)
}

/** 日期 → 「11月14日 周六」(tooltip 用) */
export function fmtDayLabel(d: Date): string {
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return `${d.getMonth() + 1}月${d.getDate()}日 ${wd[d.getDay()]}`
}
