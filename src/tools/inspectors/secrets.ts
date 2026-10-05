// P2 工具 #18:敏感信息扫描(spec §3.3 #18,立项见 docs/tools-page-plan.md 第五部分)。
//
// 定位一句话:**找的是被写进项目文件的凭据**,不是「项目里有没有密码字段」。
// 判据、精度取舍与掩码规则全在 `parsers/secretPatterns.ts` —— 那一层刻意不把原文交出来,
// 所以本文件即使想泄露也没有素材可用。这不是防御性编程,是这张卡能不能上线的前提。
//
// 定级沿用解析层的三档:私钥块与厂商前缀 = error(撞上基本是真的),
// 关键词赋值 + 高熵值 = warn(变量名撞 `token` 的情况太多)。
//
// 截断时**照常判**,另出一条覆盖面警示(与 `brokenRefs`/`scripts` 的「截断就不判」相反):
// 安全类结论静默漏扫比误报危险得多 —— 一张什么都不报的卡会被读成「没有泄漏」。
//
// 修复动作:无。凭据泄漏的正确处置是去厂商侧吊销并轮换,删掉文件里那一行不够
// (它已经在历史提交里)。工具页不代删、不打码 —— 那会让人以为泄漏已经解决。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM。
import type { Finding, ToolContext } from '../types'
import { LIST_CAP, truncatedFinding } from '../finding'
import { scanSecretsInText, type SecretHit } from '../parsers/secretPatterns'
import { gdignoredDirs, isCache, isGdignored, isVcs } from '../treeUtils'

/**
 * 只扫「可能是文本」的扩展名(待确认 #24:宽度是我拍的默认值)。
 *
 * 刻意不含 `.md` / `.txt` / `.uid`:那些地方出现凭据的概率低而噪声高。
 * `.env` 是点文件,`ext` 判不出来(`.env` 的 `lastIndexOf('.')` 是 0),所以走 basename 那条分支。
 */
const TEXT_EXT = new Set([
  'gd', 'cs', 'cfg', 'tscn', 'tres', 'json', 'yml', 'yaml', 'ini', 'properties', 'godot',
  'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'py', 'php', 'pl', 'rb', 'js', 'mjs', 'ts', 'sql', 'xml',
  // 私钥/证书本体:pem 与 key 是文本块(crt 多为 DER 二进制,读不到时按「读不到」计数,不谎称干净)
  'pem', 'key', 'crt'
])

const KIND_CN: Record<SecretHit['kind'], string> = {
  'private-key': '私钥块',
  'known-prefix': '厂商格式的凭据',
  'keyword': '疑似凭据赋值'
}

function isCandidate(f: unknown): boolean {
  if (!f || typeof f !== 'object') return false
  const e = f as { rel?: unknown; ext?: unknown }
  if (typeof e.rel !== 'string' || !e.rel) return false
  if (isCache(e.rel) || isVcs(e.rel)) return false
  const base = e.rel.slice(e.rel.lastIndexOf('/') + 1)
  if (base === '.env' || base.startsWith('.env.')) return true
  return typeof e.ext === 'string' && TEXT_EXT.has(e.ext)
}

export async function run(ctx: ToolContext): Promise<Finding[]> {
  const out: Finding[] = []
  if (ctx.truncated) {
    out.push(truncatedFinding(
      'secrets',
      '清单被截断时本卡**照常报已发现的**,但没扫到的文件不等于干净文件 —— ' +
        '下面这份结论只覆盖已列出的部分,请把 maxEntries 调高后完整重扫再当「没有泄漏」用。'
    ))
  }

  const dirs = gdignoredDirs(ctx.tree)
  const hits: { rel: string; hit: SecretHit }[] = []
  let unread = 0

  for (const f of ctx.tree) {
    if (!isCandidate(f)) continue
    const rel = (f as { rel: string }).rel
    if (isGdignored(dirs, rel)) continue
    const { text } = await ctx.readText(rel)
    if (typeof text !== 'string') { unread++; continue }
    for (const h of scanSecretsInText(text)) hits.push({ rel, hit: h })
  }

  hits.sort((a, b) => (a.rel === b.rel ? a.hit.line - b.hit.line : a.rel.localeCompare(b.rel)))
  for (let i = 0; i < Math.min(hits.length, LIST_CAP); i++) {
    const { rel, hit } = hits[i]
    out.push({
      id: `secrets:${hit.kind}:${rel}:${hit.line}:${i}`,
      severity: hit.kind === 'keyword' ? 'warn' : 'error',
      title: `${rel}:${hit.line} 有${KIND_CN[hit.kind]}`,
      detail: `形态:${hit.label};值:${hit.masked}(只给掩码,原文不进入结论)。` +
        ' 正确处置是**先去厂商控制台吊销并轮换**这一份凭据,再把它从文件里拿掉 —— ' +
        '只删这一行不够:它已经在历史提交里,任何拿到仓库的人都能翻出来。' +
        ' 如果这是从模板抄来的占位符,请忽略本条。',
      rel,
      line: hit.line,
      related: [rel]
    })
  }

  const hidden = hits.length - Math.min(hits.length, LIST_CAP)
  if (hidden > 0) {
    out.push({
      id: 'secrets:tail',
      severity: 'info',
      title: `另有 ${hidden} 处未列出`,
      detail: `本次共命中 ${hits.length} 处,这里按文件顺序只列前 ${LIST_CAP} 处(刷屏控制)。` +
        ' 少列不影响判级 —— 需要全量时把项目缩小范围后单独跑一次。'
    })
  }

  const note = unread ? ` 本次未判定:${unread} 个文本文件读不到内容(缺失 / 超体积上限 / 被判二进制),没扫到不等于干净。` : ''
  if (unread && out.length) for (const f of out) f.detail += note
  if (unread && !hits.length) {
    out.push({
      id: 'secrets:skip-count',
      severity: 'info',
      title: `${unread} 个文本文件读不到,本次扫描不完整`,
      detail: `本次未判定:${unread} 个候选文件读不到内容(缺失 / 超体积上限 / 被判二进制)。` +
        ' 一份命中都没有 + 有文件没读到 = 不能得出「没有泄漏」。' +
        ' 想扫大文件请把 readText 的 maxBytes 调高后重跑。'
    })
  }

  return out
}
