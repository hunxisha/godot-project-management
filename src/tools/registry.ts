// 工具注册表:一张表描述所有体检工具,UI 不认识任何具体工具(spec §2.1)。
// P0a 登记 3 个只读工具;P0b-B10a 补 uid/addons/ini/orphans/imports/format 六条;
// P1 第一批补 scripts/scenes/inputMap/i18n 四条(全部只读,见 docs/tools-page-plan.md 第三部分)。
import type { Capability, Tool } from './types'
import { run as runSize } from './inspectors/size'
import { run as runCache } from './inspectors/cache'
import { run as runBrokenRefs } from './inspectors/brokenRefs'
import { run as runUid } from './inspectors/uid'
import { run as runAddons } from './inspectors/addons'
import { run as runIni } from './inspectors/ini'
import { run as runScripts } from './inspectors/scripts'
import { run as runScenes } from './inspectors/scenes'
import { run as runInputMap } from './inspectors/inputMap'
import { run as runI18n } from './inspectors/i18n'
import { run as runOrphans } from './inspectors/orphans'
import { run as runImports } from './inspectors/imports'
import { run as runFormat } from './inspectors/format'

/**
 * 数组顺序就是全量体检(useTools.runAll 直接遍历本数组)的执行顺序,这条决定是刻意的
 * (spec 待确认 #8):**先只读、后可写** —— 批量动盘面最大的三项(orphans/imports/format)
 * 排在最后,前面的卡片只报告或只做小范围处置。反过来排会出什么事:前一个工具的修复
 * 改变了后一个工具的输入(批量删掉的资源让 orphans 之后的体检「变干净」、改写过的 .gd
 * 让 format 再排一遍版),同一轮体检的结论就不再对应同一份磁盘状态。
 * 断言在 useTools.test.mjs 第 1 节(按 index 显式比,不靠本注释)。
 */
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
  },
  {
    id: 'uid',
    name: 'UID 体检',
    summary: '重复 uid、孤儿 .uid、脚本缺 .uid 边车',
    phase: 'P0',
    needs: ['tree', 'text', 'trash'],
    run: runUid
  },
  {
    id: 'addons',
    name: 'addons 体检',
    summary: '插件配置字段、入口脚本、启用状态与磁盘是否一致',
    phase: 'P0',
    needs: ['tree', 'text'],
    run: runAddons
  },
  {
    id: 'ini',
    name: '配置校验',
    summary: 'project.godot 的重复键、畸形行、点名的文件不存在',
    phase: 'P0',
    needs: ['tree', 'text'],
    run: runIni
  },
  {
    id: 'scripts',
    name: '脚本体检',
    summary: 'class_name 重复、继承成环、按路径继承的目标不存在',
    phase: 'P1',
    needs: ['tree', 'text'],
    run: runScripts
  },
  {
    id: 'scenes',
    name: '场景体检',
    summary: '同名兄弟节点、头部 load_steps 与实数不符、节点挂的脚本丢了',
    phase: 'P1',
    needs: ['tree', 'text'],
    run: runScenes
  },
  {
    id: 'inputMap',
    name: '输入映射体检',
    summary: '代码与场景里用到的动作名没在 [input] 定义、动作名只差大小写',
    phase: 'P1',
    needs: ['tree', 'text'],
    run: runInputMap
  },
  {
    id: 'i18n',
    name: '本地化体检',
    summary: '配置点名的翻译文件不存在、翻译 csv 首列键重复',
    phase: 'P1',
    needs: ['tree', 'text'],
    run: runI18n
  },
  {
    id: 'orphans',
    name: '未引用资源',
    summary: '没人引用的导入资产(静态分析,可批量清理)',
    phase: 'P0',
    needs: ['tree', 'text', 'trash'],
    run: runOrphans
  },
  {
    id: 'imports',
    name: '.import 一致性',
    summary: '失效边车、资源缺边车、导入器与扩展名不匹配',
    phase: 'P0',
    needs: ['tree', 'text', 'trash'],
    run: runImports
  },
  {
    id: 'format',
    name: '代码格式化',
    summary: 'GDScript 文本卫生(缩进、行尾、空行、末尾换行、换行符),默认逐条不选',
    phase: 'P0',
    needs: ['tree', 'text', 'write'],
    run: runFormat
  }
]

export function toolById(id: string): Tool | undefined {
  return TOOLS.find((t) => t.id === id)
}

/** 宿主是否提供齐该工具需要的原语 */
export function isSupported(t: Tool, caps: Record<Capability, boolean>): boolean {
  return t.needs.every((c) => caps[c] === true)
}
