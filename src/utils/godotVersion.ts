// Godot 版本兼容判定(纯函数,无 Vue 依赖)。
//
// 从 MarketplaceView.vue 抽出:这段「项目引擎版本 ↔ 资产兼容范围」的换算原本内联在视图里,
// 既是纯逻辑又带着最容易出错的边界(未知版本、单边范围、major-only),放在视图里无法被断言。
// 现在它是可独立测试的一等模块。
import type { GodotProject, GodotVersion, MarketAsset } from '../types/godot'

/**
 * 版本串 → 可比较数值:`4.4` → 404、`4` → 400、`v4.4` → 404;无法解析返回 null。
 * 只取 major.minor,与商店的 `minGodot` / `maxGodot` 粒度一致。
 */
export function verNum(v?: string | null): number | null {
  if (!v) return null
  const m = /^v?(\d+)(?:\.(\d+))?/.exec(v.trim())
  if (!m) return null
  return Number(m[1]) * 100 + Number(m[2] || 0)
}

/**
 * 目标项目的 Godot 版本(major.minor)。
 * 优先取绑定引擎的 tag(如 `4.7.2-stable` → `4.7`),回退 project.godot 里声明的 engineVersion。
 */
export function projectGodotVersion(
  project: Pick<GodotProject, 'versionId' | 'engineVersion'> | null | undefined,
  versions: (GodotVersion & { _id?: string })[]
): string {
  if (!project) return ''
  const bound = versions.find((x) => x._id === project.versionId)
  const m = /^v?(\d+\.\d+)/.exec(bound?.tag || project.engineVersion || '')
  return m ? m[1] : ''
}

/**
 * 资产是否兼容目标 Godot 版本。
 * - 资产无版本要求、或项目版本未知 → `null`(无法判断,调用方按「不过滤」处理)
 * - 低于 min 或高于 max → `false`
 * - 其余 → `true`
 */
export function compatOf(a: Pick<MarketAsset, 'minGodot' | 'maxGodot'>, targetGodot: string): boolean | null {
  const min = verNum(a.minGodot)
  const max = verNum(a.maxGodot)
  const target = verNum(targetGodot)
  if ((min == null && max == null) || target == null) return null
  if (min != null && target < min) return false
  if (max != null && target > max) return false
  return true
}

/** 兼容范围展示文案:`Godot 4.2 ~ 4.4` / `Godot 4.2+` / `Godot ≤ 4.4` / 空串 */
export function godotRange(a: Pick<MarketAsset, 'minGodot' | 'maxGodot'>): string {
  const min = a.minGodot
  const max = a.maxGodot
  if (min && max) return `Godot ${min} ~ ${max}`
  if (min) return `Godot ${min}+`
  if (max) return `Godot ≤ ${max}`
  return ''
}

/**
 * 项目绑定的引擎版本 与 project.godot 里声明的引擎版本是否不一致。
 * 任一信息缺失(未绑定引擎、未声明版本、绑定记录已不存在)都返回 false —— 无法判断时**不报警**,
 * 否则刚添加的新项目会满屏「版本不匹配」。
 */
export function versionMismatch(
  project: Pick<GodotProject, 'engineVersion' | 'versionId'> | null | undefined,
  versions: (GodotVersion & { _id?: string })[]
): boolean {
  if (!project || !project.engineVersion || !project.versionId) return false
  const bound = versions.find((x) => x._id === project.versionId)
  if (!bound) return false
  const minor = project.engineVersion.split('.').slice(0, 2).join('.')
  return !bound.tag.startsWith(minor + '.') && !bound.tag.startsWith(minor + '-')
}
