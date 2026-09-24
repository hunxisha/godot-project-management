// 商店标签分组(纯数据 + 纯函数,无 Vue 依赖)。
//
// 从 MarketplaceView.vue 抽出:商店返回的是自由标签 slug,界面上提供的是固定几个中文分类。
// 这层映射被浏览模式的聚合拉取(`fillPool`)与展示过滤(`displayAssets`)同时使用,
// 放在视图里两边都要引用同一份常量,容易漂移;抽成模块后只有一个来源。
import type { MarketAsset } from '../types/godot'

/** 界面上的标签分类 → 商店 slug 集合 */
export const MARKET_TAG_GROUPS: { label: string, slugs: string[] }[] = [
  { label: '2D', slugs: ['2d'] },
  { label: '3D', slugs: ['3d'] },
  { label: 'UI', slugs: ['ui', 'gui', 'userinterface'] },
  { label: 'AI', slugs: ['ai'] },
  { label: '工具', slugs: ['tool', 'tools', 'editortool', 'tooling'] },
  { label: '模板', slugs: ['template', 'templates'] },
  { label: '材质', slugs: ['material', 'materials'] },
  { label: '着色器', slugs: ['shader', 'shaders'] },
  { label: '编辑器', slugs: ['editor', 'editors'] }
]

/** 按分类名取 slug 集合(未匹配返回 null) */
export function tagSlugsOf(label: string): string[] | null {
  const g = MARKET_TAG_GROUPS.find((x) => x.label === label)
  return g ? g.slugs : null
}

/** 资产是否属于标签组(旧收藏没有 tagSlugs 时按分类名兜底) */
export function inGroup(
  a: Pick<MarketAsset, 'tagSlugs' | 'category'>,
  slugs: string[]
): boolean {
  if (a.tagSlugs?.length) return a.tagSlugs.some((s) => slugs.includes(s))
  return slugs.includes((a.category || '').toLowerCase())
}
