// 项目文件树的纯函数工具(spec §5.1)。全部不依赖宿主:进 TreeEntry[]、出统计,可单测。
//
// 红线:这里**不许**碰 window / services / DOM / vue —— 渲染层要能在 Node 里被打包测试,
// 而且同一批统计口径将来还会被 Tauri 端复用。rel 的形状由原语层保证(inspectfs.js /
// src-tauri 的 scan):正斜杠、相对项目根、保留原始大小写,ext 为小写无点(无点则空串)。
import type { TreeEntry } from '../types/godot'

/**
 * 是否 `.godot` 缓存目录下的条目。
 *
 * 按**路径段**逐段比对,而不是子串匹配:
 *   · 子串匹配(`rel.includes('.godot')`)会把 `project.godot` 误判成缓存 —— 每个 Godot
 *     项目根下都必有 project.godot,一旦误判,「缓存体积」和「源码体积」两条统计同时错。
 *   · 目录名叫 `res.godot`(或文件 `a.godot`)也不该算缓存,同理。
 *   · 与 Rust 侧同源:`src-tauri/src/inspectfs.rs` 的判据就是
 *     `rel.split('/').any(|c| c == ".godot")`,两端必须同语义,否则双端体检结果对不上。
 * 认任意层级(Godot 允许子目录里也有 .godot),也认裸的 `.godot` 这一段。
 */
export function isCache(rel: string): boolean {
  if (typeof rel !== 'string' || !rel) return false
  return rel.split('/').some((c) => c === '.godot')
}

/** 去掉缓存条目,只留源文件/资源(体积与数量统计的常用口径) */
export function noCache(tree: TreeEntry[]): TreeEntry[] {
  return tree.filter((f) => !isCache(f.rel))
}

export function sumBytes(tree: TreeEntry[]): number {
  return tree.reduce((a, f) => a + f.size, 0)
}

export interface ExtGroup { ext: string; bytes: number; count: number }

/** 按扩展名聚合(体积降序);ext 为空串时归入 `(无扩展名)`。传 n 则只取前 n 组 */
export function groupByExt(tree: TreeEntry[], n?: number): ExtGroup[] {
  const m = new Map<string, ExtGroup>()
  for (const f of tree) {
    const k = f.ext || '(无扩展名)'
    const g = m.get(k) || { ext: k, bytes: 0, count: 0 }
    g.bytes += f.size
    g.count += 1
    m.set(k, g)
  }
  const out = [...m.values()].sort((a, b) => b.bytes - a.bytes)
  return n ? out.slice(0, n) : out
}

export interface DirGroup { dir: string; bytes: number; count: number }

/** 按顶层目录聚合(体积降序);根目录文件归入 `(根目录)`。传 n 则只取前 n 组 */
export function groupByTopDir(tree: TreeEntry[], n?: number): DirGroup[] {
  const m = new Map<string, DirGroup>()
  for (const f of tree) {
    const i = f.rel.indexOf('/')
    const k = i < 0 ? '(根目录)' : f.rel.slice(0, i)
    const g = m.get(k) || { dir: k, bytes: 0, count: 0 }
    g.bytes += f.size
    g.count += 1
    m.set(k, g)
  }
  const out = [...m.values()].sort((a, b) => b.bytes - a.bytes)
  return n ? out.slice(0, n) : out
}

/** 体积最大的前 n 个文件(降序)。不改动入参:先复制再排序 */
export function topFiles(tree: TreeEntry[], n: number): TreeEntry[] {
  return [...tree].sort((a, b) => b.size - a.size).slice(0, Math.max(0, n))
}

/** rel 查表集:断链检查按 rel 判存在性,O(1) */
export function relSet(tree: TreeEntry[]): Set<string> {
  return new Set(tree.map((f) => f.rel))
}

/** rel 的目录部分(含尾斜杠);根目录文件返回空串 */
export function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i + 1)
}

/** 字节数 → 人类可读。负数 / NaN / Infinity 一律给 `0 B`,不在界面上显示 'NaN KB' */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1)
  const v = n / Math.pow(1024, i)
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${u[i]}`
}

/** 毫秒 → 人类可读(扫描耗时展示) */
export function fmtMs(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 ms'
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`
}
