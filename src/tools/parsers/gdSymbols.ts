// GDScript 顶层声明抽取(纯函数,可单测)。设计见 docs/tools-page-plan.md P1-4 #12。
//
// 这一层只回答一件事:**这个文件在顶格位置声明了什么**。跨文件的重复/继承环是 #12 检查器的事,
// 不在这里做 —— 解析件一旦开始读别人的内容就没法再当纯函数测。
//
// 为什么不自己扫字符串:scanGdScript(gdScript.ts:147)已经把「行内注释、多行字符串、缩进、
// 未闭合引号」判过一遍,它的 `code` 字段是「去掉前导空白与行尾注释、再右去空白后的代码文本;
// inString 时是空串」(gdScript.ts:82-83)。本件吃它就够了;再写一份引号状态机就是债 8 那份
// 「同义不同形」的第四例。
//
// 顶格(indent === '')这条约束不是洁癖:GDScript 的内部类/函数体里也能出现 `class_name`、`extends`
// 形态的文本,缩进位置上一律不是全局声明 —— 收进来 #12 就会把内部类报成「全局 class 重复」。

import { scanGdScript } from './gdScript'

/** 一个 .gd 文件的顶层声明;字段为空串 / 0 表示「没声明」,不臆造成 `extends RefCounted` */
export interface GdDecls {
  className: string
  /** 标识符形态的基类(`extends Node`)。与 basePath 互斥:一条声明只有一个基类 */
  base: string
  /** 路径形态的基类(`extends "res://a/b.gd"`)。原样保留 `res://`,归一是调用方的事 */
  basePath: string
  /** 1-based;0 = 未声明 */
  classNameLine: number
  baseLine: number
  basePathLine: number
  /**
   * 文本读不下去(未闭合引号一类)。**true 时四个值一律不可信**,检查器须整文件不判并计入 skipped
   * —— 半读的 .gd 上判「基类不存在」只会产出「你的配置坏了」式的假 error。
   */
  suspect: boolean
}

const CLASS_RE = /^class_name\s+([A-Za-z_][A-Za-z0-9_]*)/
// 基类写在行首,或跟在 `class_name X` 同一行后面(`class_name Foo extends Bar` 是合法写法)。
// 锚在这里而不是「整行找 extends」,是为了不吃进 `var x = extends_like_thing` 那类巧合形态。
const BASE_RE = /^(?:class_name\s+[A-Za-z_][A-Za-z0-9_]*\s+)?extends\s+([A-Za-z_][A-Za-z0-9_]*)\b/
// 路径形态:双引号或单引号(GDScript 两种都接受)。值原样给出,归一/存在性判定归检查器。
const BASE_PATH_RE = /^(?:class_name\s+[A-Za-z_][A-Za-z0-9_]*\s+)?extends\s+("[^"]*"|'[^']*')/

/**
 * 扫一份 .gd 文本,给出顶层 `class_name` / `extends` 各**第一条**。
 *
 * 「各取第一条」是刻意的:同一文件写两条 `class_name` 本身就是引擎不接受的形态,
 * 而 #12 要判的是跨文件重复 —— 让检查器拿到稳定形状,比在这里发明「第 N 条」语义有用。
 * 两个判据在**同一行**上都要试:`continue` 掉一条就会漏掉组合声明里的基类。
 */
export function scanGdDecls(text: string): GdDecls {
  const out: GdDecls = {
    className: '', base: '', basePath: '',
    classNameLine: 0, baseLine: 0, basePathLine: 0,
    suspect: false,
  }
  const scan = scanGdScript(text)
  if (scan.unterminated) out.suspect = true

  for (const l of scan.lines) {
    if (l.suspect) out.suspect = true
    if (l.isComment || l.inString || l.indent !== '') continue

    if (!out.className) {
      const m = CLASS_RE.exec(l.code)
      if (m) { out.className = m[1]; out.classNameLine = l.line }
    }
    if (!out.base && !out.basePath) {
      const m = BASE_RE.exec(l.code)
      if (m) { out.base = m[1]; out.baseLine = l.line }
      else {
        const p = BASE_PATH_RE.exec(l.code)
        if (p) {
          out.basePath = p[1].slice(1, -1) // 剥掉外层引号,内层不动
          out.basePathLine = l.line
        }
      }
    }
  }
  return out
}
