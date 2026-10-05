// P1 工具 #11:版本控制卫生(spec §3.2 #11,拆解见 docs/tools-page-plan.md 第四部分)。
//
// **本工具不跑 git、不解析 `.git/index`。** 这两条路都能拿到「谁真的被跟踪」的准确答案,但都要开新执行面
// 或新二进制解析器,并把同一逻辑再往 Rust + shim 抄一遍 —— 违反 §2.2 的「最小通用原语 + 渲染层分析」。
// 所以这里只判**文件清单与文本能判死**的部分,并把判不了的那半条自首写进卡面措辞:
// 「清单里有大文件」不等于「这个大文件被 git 跟踪了」。
//
// 判据与定级:
//   · 不是 git 仓库(清单里没有 `.git` 条目)→ info,并**停在这里**:后面的 `.gitignore` 一类问题在无仓库时全是噪声;
//   · 是仓库但没有 `.gitignore` → warn;此时**不再**重复报「.godot 没被忽略」(同一条病,报两处只会让人怀疑工具);
//   · `.gitignore` 没覆盖 `.godot` → warn。这是 Godot 项目的头号污染:缓存几万几十个文件,一旦提交进去
//     每次重扫都是 diff。⚠ 只认下面列出的几种常见写法 —— gitignore 的完整语义(取反、字符类、递归锚点)
//     本工具不做,所以这条是 warn 而不是 error,措辞也必须承认覆盖面有限。
//   · 缺 `.editorconfig` / `.gitattributes` → info(官方新建项目模板会写两份,缺了不影响运行)。
//   · 大文件 → info,逐个点名带体积。
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
 * 认作「已忽略 .godot」的写法白名单。
 *
 * ⚠ 刻意只列这几条:它们覆盖 Godot 官方模板与编辑器实际写盘的样子
 * (新建项目的模板行就是 `.godot/`,见 projects.js:216 那份 GIT_IGNORE)。
 * 别的写法(`[Gg]odot` 加分隔符那种字符类、`!.godot/imported` 取反之类)判不出来 ——
 * 那种文件会**多**出一条 warn,所以这条判据一律 warn 不定 error,并把「只认这几种写法」写在 detail 里。
 */
const GODOT_IGNORE_FORMS = new Set(['.godot', '.godot/', '/.godot', '/.godot/', '**/.godot/', '**/.godot'])

/** 清单里有没有 `.git`:目录条目(`.git/HEAD`)与 submodule 的 gitdir 指针文件(裸 `.git`)都算。
判据本身共享在 treeUtils.isVcs —— 体积卡与本页必须对「什么是 VCS 元数据」说同一句话。 */
function hasGitEntry(tree: ToolContext['tree']): boolean {
  return tree.some((f) => !!f && typeof f.rel === 'string' && isVcs(f.rel))
}

/** .gitignore 里有没有一条**未被注释**的忽略行覆盖 .godot */
function ignoresGodot(text: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (GODOT_IGNORE_FORMS.has(line)) return true
  }
  return false
}

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
    else if (!ignoresGodot(text)) {
      out.push({
        id: 'git:godot-not-ignored',
        severity: 'warn',
        title: '.gitignore 里没看到针对 .godot 的忽略行',
        detail: `读过的忽略行里没有 ${[...GODOT_IGNORE_FORMS].slice(0, 3).join(' / ')} 这几种写法。` +
          ' `.godot/` 是编辑器生成的缓存(导入产物、类名缓存、着色器缓存),文件数量动辄上千,' +
          ' 提交进去以后每次重扫都会刷出一片 diff。在 .gitignore 里加一行 `.godot/` 即可。' +
          ' ⚠ 本工具只认上面列出的几种常见写法,不做完整 gitignore 语义(取反 `!`、字符类、递归锚点都不判)' +
          ' —— 如果你用了别的写法且确实覆盖了它,这条 warn 可以忽略。',
        rel: ignRel
      })
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

  const bigs = ctx.tree
    .filter((f) => !!f && typeof f.rel === 'string' && !!f.rel && !isCache(f.rel) && !isVcs(f.rel)
      && typeof f.size === 'number' && f.size > BIG_FILE_BYTES)
    .sort((a, b) => b.size - a.size || byText(a.rel, b.rel))
  if (bigs.length) {
    const shown = bigs.slice(0, LIST_CAP)
    out.push({
      id: 'git:big-files',
      severity: 'info',
      title: `清单里有 ${bigs.length} 个大于 20MB 的文件`,
      detail: shown.map((f) => `${f.rel}(${fmtBytes(f.size)})`).join('、') +
        (bigs.length > shown.length ? ` 等 ${bigs.length} 个(这里点名前 ${LIST_CAP} 个)` : '') +
        '。⚠ 这只说明磁盘上这些文件大 —— 是否真的被 git 跟踪,本工具判不了(不跑 `git`,也不解析 `.git/index`)。' +
        ' 要确认请在仓库里跑 `git ls-files` 或 `git count-objects -v`。' +
        ' 未压缩纹理与音频通常应该走 LFS 或留在导入源之外。',
      rel: shown[0].rel
    })
  }

  if (unread) {
    for (const f of out) f.detail += ` 本次未判定:${unread} 份 .gitignore 读不到文本,忽略行无从比对。`
    if (!out.length) {
      out.push({
        id: 'git:skip-count',
        severity: 'info',
        title: `${unread} 份 .gitignore 读不到文本`,
        detail: '本次未判定:.gitignore 读不出文本(超体积上限 / 被判二进制)。没有它,忽略覆盖情况无从判起。'
      })
    }
  }

  return out
}
