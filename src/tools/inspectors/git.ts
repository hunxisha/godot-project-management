// P1 工具 #11:版本控制卫生(spec §3.2 #11,拆解见 docs/tools-page-plan.md 第四部分)。
//
// **本工具不跑 git、不解析 `.git/index`**(待确认 #21 由我在 2026-10-05 拍板:不开执行面)。
// 知道「谁真的被跟踪」只有那两条路,都要把同一逻辑往 Rust + shim 再抄一遍,违反 §2.2 的最小 IO 原则。
// 替代做法:用 `.gitignore` 把**已被规则排除**的大文件从候选里摘掉(#22 的保守子集实现),
// 剩下的按「磁盘上大」报,并在卡面自首「是否被跟踪判不了」。
//
// 判据与定级:
//   · 不是 git 仓库(清单里没有 `.git` 条目)→ info,并**停在这里**:后面的 `.gitignore` 一类问题在无仓库时全是噪声;
//   · 是仓库但没有 `.gitignore` → warn;此时**不再**重复报「.godot 没被忽略」(同一条病报两处只会让人怀疑工具);
//   · `.gitignore` 没覆盖 `.godot` → warn。Godot 项目的头号污染:缓存动辄上万个文件,提交进去后每次重扫都刷一片 diff。
//   · 缺 `.editorconfig` / `.gitattributes` → info(官方新建项目模板会写两份,缺了不影响运行)。
//   · 大文件(>20MB 且没被忽略规则覆盖)→ info,逐个点名带体积。
//
// ⚠ gitignore 语义只做**保守子集**(见下 `parseIgnoreRule`):认不出的规则一律当「不覆盖」处理,
// 方向是多报一条 info / 多一条 warn,绝不是少报。完整实现要匹配 git 的转义与优先级,不是一个体检项的量。
// 只读**根级那一份** `.gitignore` —— 子目录里的 `.gitignore` 在 git 里也生效,那是本工具的已知盲区。
//
// 截断时 `.git` 有可能整体没进清单 —— 那时**不能**判「不是仓库」,只能说「清单残缺,这轮不判」。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM,不起子进程。
import type { Finding, ToolContext } from '../types'
import { LIST_CAP } from '../finding'
import { byText, fmtBytes, isCache, isVcs, rootRelOf } from '../treeUtils'

/** 单文件超过这个体积就点名(20MB:Godot 项目里通常是视频/音频/未压纹理) */
const BIG_FILE_BYTES = 20 * 1024 * 1024

/**
 * 一条能判的忽略规则。
 *
 * `null`(解析不出来)= 这条规则**不参与判定**,调用方按「未覆盖」处理 ——
 * 认不出就多报,不认不出就少报,方向钉死在前者。
 */
interface IgnoreRule {
  neg: boolean
  dirOnly: boolean
  /** 从仓库根锚定匹配(含斜杠的规则、或以 `/` 开头的规则都是这种) */
  anchored: boolean
  segs: string[]
}

/** 单个路径段的匹配:精确名,或 `*.ext` 形态的后缀。其余通配形态一律不认 */
function segmentMatches(pat: string, seg: string): boolean {
  if (pat.startsWith('*.')) {
    const suffix = pat.slice(1) // '*.zip' → '.zip'
    return seg.length > suffix.length && seg.endsWith(suffix)
  }
  return pat === seg
}

/** 这条段模式我们认不认(支持精确与 `*.ext`,别的通配/字符类全归「认不出」) */
function segParsable(pat: string): boolean {
  if (!pat) return false
  if (pat.includes('[') || pat.includes(']') || pat.includes('?') || pat.includes('\\')) return false
  if (!pat.includes('*')) return true
  return pat.startsWith('*.') && pat.indexOf('*') === pat.lastIndexOf('*') && !pat.slice(2).includes('*')
}

/**
 * 解析一行 .gitignore。返回 null = 这条规则本工具判不了(字符类、`?`、中缀 `*`、`**` 出现在非前导位置等)。
 */
function parseIgnoreRule(line: string): IgnoreRule | null {
  let body = line
  const neg = body.startsWith('!')
  if (neg) body = body.slice(1)
  const dirOnly = body.endsWith('/')
  if (dirOnly) body = body.slice(0, -1)
  body = body.trim()
  if (!body) return null
  const anchored0 = body.startsWith('/')
  if (anchored0) body = body.slice(1)
  // `**/x` 前导递归段等价于「任意层级」;其余位置的 `**` 不认。
  while (body.startsWith('**/')) body = body.slice(3)
  if (body.includes('**')) return null
  const segs = body.split('/')
  if (!segs.every(segParsable)) return null
  // git 的规则语义:含斜杠(或带前导 `/`)的模式从仓库根锚定;不含斜杠的裸名在任意层级的同名段上生效。
  // 前导 `**/` 只是「任意层级」的另一种写法,与裸名同一类。
  return { neg, dirOnly, anchored: anchored0 || segs.length > 1, segs }
}

/** 一条 rel 是否命中某条规则 */
function ruleHits(rule: IgnoreRule, relSegs: string[]): boolean {
  if (!rule.anchored) {
    // 裸名规则:匹配任意一个路径段(目录规则要求该段之后还有下文)
    const pat = rule.segs[0]
    for (let i = 0; i < relSegs.length; i++) {
      if (!segmentMatches(pat, relSegs[i])) continue
      if (!rule.dirOnly || i < relSegs.length - 1) return true
    }
    return false
  }
  if (relSegs.length < rule.segs.length) return false
  for (let i = 0; i < rule.segs.length; i++) {
    if (!segmentMatches(rule.segs[i], relSegs[i])) return false
  }
  // 段数相等时:非目录规则命中的就是这条路径本身。
  // rel 更深时:git 里「匹配到一个目录」等于「匹配它下面的一切」,dirOnly 与否都算命中。
  return relSegs.length > rule.segs.length || !rule.dirOnly
}

/**
 * .gitignore 会不会忽略这条路径?规则**按文件顺序**逐条套用,后命中的赢(git 同向 —— 所以 `!foo` 写在
 * `*.foo` 之后能把它捞回来,写在之前则无效)。没有规则命中 = 未覆盖。
 */
function isIgnored(rel: string, rules: IgnoreRule[]): boolean {
  const relSegs = rel.split('/')
  let ignored = false
  for (const r of rules) {
    if (ruleHits(r, relSegs)) ignored = !r.neg
  }
  return ignored
}

/** 把 .gitignore 文本解析成规则表;注释与空行跳过,认不出的规则直接丢 */
function parseGitignore(text: string): IgnoreRule[] {
  const out: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const r = parseIgnoreRule(line)
    if (r) out.push(r)
  }
  return out
}

/**
 * 清单里有没有 `.git`:目录条目(`.git/HEAD`)与 submodule 的 gitdir 指针文件(裸 `.git`)都算。
 * 判据共享在 treeUtils.isVcs —— 体积卡与本页必须对「什么是 VCS 元数据」说同一句话。
 */
function hasGitEntry(tree: ToolContext['tree']): boolean {
  return tree.some((f) => !!f && typeof f.rel === 'string' && isVcs(f.rel))
}

/** 拿来问「.godot 目录下的文件会不会被忽略」的代表路径(不是真实条目,只是判据的探针) */
const GODOT_PROBE = '.godot/imported/probe.cache'

export async function run(ctx: ToolContext): Promise<Finding[]> {
  if (!hasGitEntry(ctx.tree)) {
    return [{
      id: 'git:not-repo',
      severity: 'info',
      title: ctx.truncated ? '文件清单被截断,本次不判版本控制卫生' : '项目目录里没有 .git(还没有初始化版本控制)',
      detail: ctx.truncated
        ? '文件清单被截断:宿主在 maxEntries 处停了,`.git/**` 可能只是没进清单,而不是项目真的没有 git。' +
          ' 这时判「没在版本控制里」是假阴性方向的谎话,所以整轮不发判定。请把 maxEntries 调高或做一次完整重扫。'
        : '本轮不做任何版本控制判定 —— 没有仓库时「.gitignore 缺失」一类结论都只是噪声。' +
          ' 要把项目纳入版本控制:编辑器「项目管理器」新建项目时会写官方模板,或自己 `git init` 后补一份 Godot 的 `.gitignore`。'
    }]
  }

  const out: Finding[] = []
  const ignRel = rootRelOf(ctx.tree, '.gitignore')
  let rules: IgnoreRule[] = []
  let unread = 0

  if (!ignRel) {
    out.push({
      id: 'git:no-ignore',
      severity: 'warn',
      title: '仓库里没有 .gitignore',
      detail: '项目已经在版本控制里,却没有一份忽略表 —— Godot 的 `.godot/` 缓存、`*.import` 之外的生成物' +
        ' 都会跟着进提交。编辑器新建项目时会写一份官方模板,已有项目补一份也行。',
      rel: '.gitignore'
    })
  } else {
    const { text } = await ctx.readText(ignRel)
    if (typeof text !== 'string') unread++
    else {
      rules = parseGitignore(text)
      if (!isIgnored(GODOT_PROBE, rules)) {
        out.push({
          id: 'git:godot-not-ignored',
          severity: 'warn',
          title: '.gitignore 里没有会忽略 .godot 的规则',
          detail: '读过的规则里没有能覆盖 `.godot/` 目录下文件的写法。`.godot/` 是编辑器生成的缓存' +
            '(导入产物、类名缓存、着色器缓存),文件数量动辄上千,提交进去后每次重扫都会刷出一片 diff。' +
            ' 加一行 `.godot/` 即可。' +
            ' ⚠ 本工具只认几种常见写法(精确名、目录前缀、前导 `/` 锚点、`**/` 前导、`*.ext` 后缀、`!` 取反),' +
            ' 字符类 `[abc]`、`?`、中缀通配这类判不出来 —— 那种情况下这条 warn 属于误报,可以直接忽略。',
          rel: ignRel
        })
      }
    }
  }

  if (!rootRelOf(ctx.tree, '.editorconfig')) {
    out.push({
      id: 'git:no-editorconfig',
      severity: 'info',
      title: '缺 .editorconfig(编辑器统一的缩进/换行约定)',
      detail: 'Godot 官方新建项目模板会写一份。缺了不影响运行,影响的是多人协作时的缩进与行尾一致性。' +
        ' 本工具只报缺失,不替你生成。'
    })
  }
  if (!rootRelOf(ctx.tree, '.gitattributes')) {
    out.push({
      id: 'git:no-gitattributes',
      severity: 'info',
      title: '缺 .gitattributes(换行符与二进制文件的处理规则)',
      detail: '官方模板会写一份。没有它时跨平台协作容易出现 CRLF/LF 打架,`.import`/纹理这类文件也没有明确的 binary 声明。'
    })
  }

  // 大文件候选:排除缓存与 VCS 元数据,再按 .gitignore 摘掉「规则已覆盖」的那些(#21 拍板后的降噪路径)。
  // excluded 的条数必须说出口 —— 静默少报与把判据藏进实现是同一件事。
  let excluded = 0
  const bigs = ctx.tree
    .filter((f) => {
      if (!f || typeof f.rel !== 'string' || !f.rel) return false
      if (isCache(f.rel) || isVcs(f.rel)) return false
      if (typeof f.size !== 'number' || f.size <= BIG_FILE_BYTES) return false
      if (rules.length && isIgnored(f.rel, rules)) { excluded++; return false }
      return true
    })
    .sort((a, b) => b.size - a.size || byText(a.rel, b.rel))
  if (bigs.length) {
    const shown = bigs.slice(0, LIST_CAP)
    out.push({
      id: 'git:big-files',
      severity: 'info',
      title: `清单里有 ${bigs.length} 个大于 20MB 的未忽略文件`,
      detail: shown.map((f) => `${f.rel}(${fmtBytes(f.size)})`).join('、') +
        (bigs.length > shown.length ? ` 等 ${bigs.length} 个(这里点名前 ${LIST_CAP} 个)` : '') +
        (excluded ? `。已按 .gitignore 排除 ${excluded} 个被规则命中的大文件,不计进上面这份名单` : '') +
        '。⚠ 这只说明磁盘上这些文件大 —— 是否真的被 git 跟踪,本工具判不了(不跑 `git`,也不解析 `.git/index`)。' +
        ' 要确认请在仓库里跑 `git ls-files` 或 `git count-objects -v`。' +
        ' 未压缩纹理与音频通常应该走 LFS 或留在导入源之外。',
      rel: shown[0].rel
    })
  }

  if (unread) {
    for (const f of out) f.detail += ' 本次未判定:.gitignore 读不出文本(超体积上限 / 被判二进制),忽略行无从比对。'
    if (!out.length) {
      out.push({
        id: 'git:skip-count',
        severity: 'info',
        title: '.gitignore 读不到文本',
        detail: '本次未判定:.gitignore 读不出文本(超体积上限 / 被判二进制)。没有它,忽略覆盖情况与忽略规则都无从判起。'
      })
    }
  }

  return out
}
