// Godot 官方启动器标签联动的前端侧:显示文字与配色规则都对齐官方,两边观感一致。
//
// 依据(godot 仓库 editor/project_manager/project_tag.cpp + core/string/ustring.cpp 实测):
//   · 存储在 project.godot 的 [application] config/tags=PackedStringArray("a", "b")(4.3+),
//     读写都走宿主 services(renameProject / setProjectTags),这里只管展示;
//   · 官方色相 = String.hash(标签) × 10001(各自 32 位环绕)mod (2³²-1) ÷ (2³²-1),
//     String.hash 是按 UTF-32 码点的 djb2(初值 5381,乘 33 加码点);
//   · 官方饱和度固定 0.8(OKHSL)。这里只精确复刻色相,OKHSL→sRGB 不做全量转换,
//     明暗取近似值交给 CSS 按明暗主题调整 —— 色相相同即观感同族,不必逐像素一致。
//   · 官方显示文字走 String.capitalize();这里复刻其常用子集(下划线转空格、词首大写)。

/** Godot String::hash():djb2,按 UTF-32 码点迭代,32 位环绕 */
export function godotStringHash(s: string): number {
  let h = 5381
  for (const ch of s) {
    h = (Math.imul(h, 33) + (ch.codePointAt(0) || 0)) >>> 0
  }
  return h
}

/** 官方 ProjectTag 色相(0~1,精确复刻 project_tag.cpp 的哈希取模链) */
export function godotTagHue(tag: string): number {
  const h = godotStringHash(tag)
  return ((Math.imul(h, 10001) >>> 0) % 4294967295) / 4294967295
}

/** 官方标签显示文字(String.capitalize() 的常用子集):下划线转空格、词首大写 */
export function godotTagLabel(tag: string): string {
  return tag
    .replace(/_/g, ' ')
    .split(' ')
    .filter((w) => w)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** 标签 chip 的样式变量:色相走官方公式,明暗自适应交给 CSS(--tag-h 为 0~360 的度数) */
export function tagChipVars(tag: string): { '--tag-h': string } {
  return { '--tag-h': String(Math.round(godotTagHue(tag) * 3600) / 10) }
}
