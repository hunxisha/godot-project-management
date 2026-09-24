/** 字节数 → 人类可读(1024 进制) */
export function fmtSize(n?: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** 时间戳 → `YYYY-MM-DD HH:mm` */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 时间戳 → 相对时间描述。
 * 1 分钟内「刚刚」、1 小时内「N 分钟前」、24 小时内「N 小时前」,更早显示日期。
 * @param fallback 时间戳缺失时的文案(项目用「从未打开」,备份用「从未」)
 */
export function formatRelative(ts?: number, fallback = '从未'): string {
  if (!ts) return fallback
  const diff = Date.now() - ts
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 毫秒 → 耗时描述(`1.2 秒` / `3 分 05 秒`) */
export function fmtDuration(ms?: number): string {
  if (!ms || ms < 0) return '—'
  if (ms < 1000) return `${ms} 毫秒`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(sec >= 10 ? 0 : 1)} 秒`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m} 分 ${String(s).padStart(2, '0')} 秒`
}

/**
 * 归一化版本号,用于显示与比较:去首尾空白 + 去掉前缀 `v`/`V`(连续多个也一并去掉)。
 *
 * 原实现分散在 `VersionPickerDialog.vue`(norm)与 `MarketplaceView.vue`(fmtVer),
 * 且两处**行为不一致**:一处 trim 且只去掉一个 `v`,另一处不 trim 且去掉连续多个 `v`。
 * 这是唯一实现 —— 不要在各视图里再写一份。
 *
 * @example normVersion(' v4.3') === '4.3' · normVersion('vv4.3') === '4.3'
 */
export function normVersion(v?: string): string {
  return String(v ?? '').trim().replace(/^v+/i, '')
}
