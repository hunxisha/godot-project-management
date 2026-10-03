// 工具注册表:一张表描述所有体检工具,UI 不认识任何具体工具(spec §2.1)。
// P0a 只登记 3 个只读工具;P0b 再放 ini/uid/orphans/addons/imports/format。
import type { Capability, Tool } from './types'
import { run as runSize } from './inspectors/size'
import { run as runCache } from './inspectors/cache'
import { run as runBrokenRefs } from './inspectors/brokenRefs'

export const TOOLS: Tool[] = [
  {
    id: 'size',
    name: '项目体积与大文件',
    summary: '按目录与类型统计占用,并列出最大的文件',
    phase: 'P0',
    needs: ['tree'],
    run: runSize
  },
  {
    id: 'cache',
    name: '.godot 缓存体检',
    summary: '缓存占用与是否比源文件陈旧;清理入口在项目页',
    phase: 'P0',
    needs: ['tree'],
    run: runCache
  },
  {
    id: 'brokenRefs',
    name: '资源引用完整性',
    summary: '场景与资源里声明的外部文件是否真的存在',
    phase: 'P0',
    needs: ['tree', 'text'],
    run: runBrokenRefs
  }
]

export function toolById(id: string): Tool | undefined {
  return TOOLS.find((t) => t.id === id)
}

/** 宿主是否提供齐该工具需要的原语 */
export function isSupported(t: Tool, caps: Record<Capability, boolean>): boolean {
  return t.needs.every((c) => caps[c] === true)
}
