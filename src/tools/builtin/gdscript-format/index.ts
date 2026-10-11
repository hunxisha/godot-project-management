// GDScript 代码格式化 · 插件入口(§5.1 / §5.4 的 action + ui:'schema' / A-11)。
//
// 这是第 1 批的**第一个真实使用者**:manifest 的字段够不够、三段式的接口形状对不对、
// 账本记不记得下来,全靠它压一遍。内置工具与第三方插件走同一个 `registerTool()`(DEV-4),
// 所以这里写的每一行都在同一套契约之下 —— 没有「内置特例」。
//
// 导出面就是 entry 契约(§F 纯契约补充):`schema` + `plan`。
// 正文在 `plan` 里算好放进 `payload.text` ⇒ 预览阶段就能出 diff;
// 因此这个工具**不实现 apply**(实现了也不会有第二条通道来调它)。
//
// `reason` 里为什么同时装着「没做什么」:DEV-7 定了框架不复述插件的话、也不自己另写判断,
// 而旧体检层那条「少做了 N 行必须上卡面」的判据不能因为换了框架就消失 ——
// Change 只有 label 与 reason 两个文本槽,拒因属于「这一条为什么是这个样子」,归 reason。

import type { Change } from '../../../toolkit/change'
import type { FieldDesc } from '../../../toolkit/schema'
import { countToken, formatGdText, indentTargetText, optsFrom } from './format'

/**
 * 参数表(§5.7 那张单子的原样落地)。
 *
 * 键名与 `format.ts` 的 `optsFrom` 一一对应;`DEFAULT_OPTS` 与这里的 `def` 必须同值,
 * 表单显示的默认值与实际执行的默认值分成两套是这类工具最容易被用户当成 bug 的地方(测试钉住)。
 */
export const schema: FieldDesc[] = [
  {
    key: 'targets',
    type: 'files',
    label: '要格式化的脚本',
    help: '只显示项目内的 .gd;勾中的文件由框架作为 plan() 的第二个参数交进来',
    required: true,
    def: [],
    min: null,
    max: null,
    options: [],
    exts: ['gd'],
    multiple: true,
    placeholder: ''
  },
  {
    key: 'indent',
    type: 'select',
    label: '缩进',
    help: '只折算整行前导空白:空格数不是整倍数、或同一行里 tab 与空格混着的,那些行一律不动',
    required: false,
    def: 'tab',
    min: null,
    max: null,
    options: [
      { value: 'keep', label: '保持原样' },
      { value: 'tab', label: 'Tab' },
      { value: 'space2', label: '空格(2)' },
      { value: 'space4', label: '空格(4)' }
    ],
    exts: [],
    multiple: false,
    placeholder: ''
  },
  {
    key: 'trailing',
    type: 'boolean',
    label: '去除行尾空格',
    help: '只删行尾的空格与 tab;\\f、\\v、不换行空格这些非 ASCII 空白算内容,不动',
    required: false,
    def: true,
    min: null,
    max: null,
    options: [],
    exts: [],
    multiple: false,
    placeholder: ''
  },
  {
    key: 'final_newline',
    type: 'boolean',
    label: '补齐文件末尾换行',
    help: '只在真的欠一个换行时补;不删已有的末尾空行(少动的一侧)',
    required: false,
    def: true,
    min: null,
    max: null,
    options: [],
    exts: [],
    multiple: false,
    placeholder: ''
  },
  {
    key: 'endings',
    type: 'select',
    label: '换行符',
    help: '只改代码区的终止符;多行字符串里混着另一种换行符时整条放弃(那是内容)',
    required: false,
    def: 'lf',
    min: null,
    max: null,
    options: [
      { value: 'keep', label: '保持' },
      { value: 'lf', label: 'LF' },
      { value: 'crlf', label: 'CRLF' }
    ],
    exts: [],
    multiple: false,
    placeholder: ''
  },
  {
    key: 'collapse_blank',
    type: 'boolean',
    label: '折叠连续空行',
    help: '只折代码区的空行;多行字符串里的空行是内容,不动',
    required: false,
    def: true,
    min: null,
    max: null,
    options: [],
    exts: [],
    multiple: false,
    placeholder: ''
  },
  {
    key: 'max_blank',
    type: 'number',
    label: '折叠为最多几行空行',
    help: '0 表示一段都不留;需要配合上面的开关',
    required: false,
    def: 1,
    min: 0,
    max: 4,
    options: [],
    exts: [],
    multiple: false,
    placeholder: ''
  }
]

/** 这一句同时是 label 的前缀与 reason 的正文骨架(措辞只在这里有一份) */
const SCOPE_TXT = '只动排版,不改语法:删行尾空白、折算整行前导缩进、折叠连续空行、统一换行符、补齐末尾换行。'

/**
 * 只算不写:每个选中文件读一次,格式化后**只在正文真的变了**时产一条 change。
 *
 * 三种「不产条」都是有意的:没变化(不占条也就不需要备份、不进账本)、
 * 没拿到完整正文(`truncated` / `skippedBinary` 是「调用成功但没给正文」,拿它改写等于把半个文件写回去)、
 * 读取本身失败(原因进 ctx.log,不静默)。
 */
export async function plan(ctx: {
  cancelled: boolean
  readText(rel: string): Promise<{ text: string, truncated: boolean, skippedBinary: boolean, bytes: number, error: string }>
  log(level: string, msg: string): void
}, files: unknown, params: unknown): Promise<Change[]> {
  const read = optsFrom(params)
  const opts = read.opts
  const changes: Change[] = []
  const list = Array.isArray(files) ? files : []

  for (const item of list) {
    if (ctx.cancelled) break
    const rel = item && typeof item === 'object' ? String((item as { rel?: unknown }).rel ?? '') : ''
    if (!rel) continue
    const r = await ctx.readText(rel)
    if (r.error) {
      ctx.log('warn', `读不到 ${rel}:${r.error}`)
      continue
    }
    if (r.truncated || r.skippedBinary) {
      ctx.log('warn', `${rel}:${r.truncated ? '超出读取上限,只拿到部分内容' : '被认成二进制'},不改写`)
      continue
    }
    const fmt = formatGdText(r.text, opts)
    if (fmt.out === r.text) continue
    changes.push({
      rel,
      kind: 'rewrite',
      risk: 'low',
      label: `文本卫生:${countToken(fmt.counts)}`,
      reason: SCOPE_TXT +
        ` 缩进目标「${indentTargetText(opts.indent)}」。` +
        ` 碰过多行字符串或续行的行一个字节都不改。写盘前先落备份,可一键还原。` +
        (fmt.skips.length ? ` 这个文件没做:${fmt.skips.join(';')}。` : '') +
        (read.skips.length ? ` 参数问题:${read.skips.join(';')}。` : ''),
      payload: { text: fmt.out }
    })
  }
  return changes
}
