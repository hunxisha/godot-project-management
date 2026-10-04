// P0 工具 #5：UID 体检（spec §3.1 #5、§6 风险表「UID 语义复杂」行、简报判据 1-8）。
//
// 第一期只判三类保守情形：**重复 uid**（error）、**孤儿 `.uid`**（warn + trash 修复）、
// **`.gd` 缺 `.uid`**（warn，双闸门）。不判「`.uid` 边文与头部 uid 不一致」、不判 token 格式错误、
// 不读 `.import`（那是 B6 的 importFile.ts）—— §6 那一行明写「不自动重分配 uid」，
// 多一条判据就多一次误删的机会。
//
// 三种 uid 出现位置里只有两种是**所有权声明**（判据 1）：
//   · `X.uid` 边文：Godot 4.4+ 给脚本/资源生成的旁路文件，内容一行 `uid://<token>`，归给 `X`；
//   · `.tscn/.tres` **头部第一行**的 `uid="..."`，归给该场景/资源自己。
// `[ext_resource ... uid="..."]` 里的 uid 是**引用**（引用方在说「我要用那个 uid 的东西」），
// 一次都不能算进重复判定 —— 一个场景可以实例化一万次，那是引用一万次而不是拥有一万次。
//
// 与 B3 的 `refIndex.ts` 不冲突：那边把 `.import`/`.uid` 边车排除在**引用来源**之外
// （`refIndex.ts:121-128`，否则每个资产都被自己「引用」），这边把同一批文件当**所有权声明**读，
// 是另一个角色。本模块**不调用** `buildRefIndex`（判据 6：不为 uid 检查建整项目引用索引，
// 那要读 `.gd/.json/…`，比这里的读取面大一圈），只复用它的 token 形状判据 `isUidToken`。
//
// 措辞红线：孤儿结论只挂 `fix: { kind:'trash', label, payload:{rels} }`。动词（「移入回收站」/
// 「永久删除」）、风险句、预览清单全部由 `fixPlan.ts` 按平台与 kind 给（`fixPlan.ts:227-256`、
// 动词分叉在 `:240`），检查器里再写一遍「移入回收站」就是 B1 建这条管线要防的漂移 ——
// 简报判据 3 给的那句示例 label 里带「移入回收站」，按这条红线把它换成中性的「移除」。
//
// 红线：纯函数，只吃 ToolContext —— 不碰 window / services / vue / DOM；唯一 IO 是 await ctx.readText。
import type { Finding, ToolContext } from '../types'
import { truncatedFinding } from '../finding'
import { isUidToken } from '../refIndex'
import { SCENE_EXT, attr } from '../parsers/sceneRefs'
import { dirOf, gdignoredDirs, hasRelCI, isCache, isGdignored, lowerRelSet, relSet } from '../treeUtils'

/** 边车尾缀：归属一律用它切（`X.a.b.uid` 的源是 `X.a.b`，用 dirOf/basename 重拼会拼错） */
const UID_SUFFIX = '.uid'

/** 孤儿/重复的展示上限：与 size.ts 的 BIG_LIST=20 同一口径（刷屏控制，不影响 rels 全量） */
const LIST_CAP = 20

/** 一个 rel 对某个 uid 的所有权声明渠道：自身头部 / 哪些边文指着它 */
interface Owner {
  rel: string
  header: boolean
  sidecars: string[]
}

/**
 * 字典序比较一律用 `<`/`>`（UTF-16 码元），不用 `localeCompare`：
 * locale 会跟着宿主环境变，而 finding 的排序、`related` 与 id 都要跨机器逐字节一致（判据 8）。
 */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 判据 5：边文内容 → token。Godot 写的就是单行 `uid://<token>`，所以只取**第一行非空**并 trim
 * （CRLF、前后空格、后面多出来的行都在这里吸收）；第一行不是合法 uid 就当没有声明 ——
 * 不往后捞（多行文件不是引擎产物，捞出来的东西不能替用户当真）、也不报「格式错误」（本期不判）。
 */
function sidecarToken(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    return isUidToken(t) ? t : ''
  }
  return ''
}

/**
 * 判据 1：**只看第一行**。场景第二行往后是 `[ext_resource]`（那是引用，判据 1 明写不能算所有权），
 * 手滑把整篇文本丢给属性读取就会把引用收成声明 —— 于是「一个场景被引用一万次」长成「一万个重复」。
 * 第一行不是 `gd_scene`/`gd_resource`（例如文件以空行开头）时读不到 uid，当作没有声明（保守）。
 * 属性读法一律走 `sceneRefs.attr()`（B4 评审挂账、B6 收口：这里原来另抄了一条
 * `/\buid="([^"]*)"/`，与 attr() 是同规则的两份写法）；uid 串的**形状**判据仍只有
 * `refIndex.isUidToken` 一份（判据 5）。
 */
function headerUid(text: string): string {
  const head = text.split(/\r?\n/, 1)[0] || ''
  const uid = attr(head, 'uid')
  return isUidToken(uid) ? uid : ''
}

/** 判据 2：detail 要写明这个 uid 与**每一条**声明者的关系（边文还是头部），因为用户要看懂谁会掉引用 */
function ownerText(o: Owner): string {
  const ch: string[] = []
  if (o.header) ch.push('自身头部 uid=')
  for (const s of o.sidecars) ch.push(`边车 ${s}`)
  return `${o.rel}（${ch.join(' + ')}）`
}

export async function run(ctx: ToolContext): Promise<Finding[]> {
  const out: Finding[] = []
  const tree = Array.isArray(ctx.tree) ? ctx.tree : []
  // 判据 3：存在性判定（孤儿 `.uid`、`.gd` 缺边文、项目闸门）只在清单完整时做 ——
  // 与 brokenRefs.ts:25-35 同一口径：清单不全时「查不到源文件」不是证据。
  // 重复判定不吃存在性：它的证据是「两个读得到的文件各自写了同一个 uid」，
  // 清单不全只会**少列**几个声明者（少报），不会凭空造出一个重复（错报），所以截断时照常做。
  const complete = !ctx.truncated
  if (ctx.truncated) {
    out.push(truncatedFinding(
      'uid',
      '重复 uid 的判定只看「两个读得到的文件都声明了同一个 uid」，清单不完整不会让它变成假证据，本次照常做；' +
        '但孤儿 .uid（源文件不在清单里）与 .gd 缺 .uid（同目录比对）都拿整份清单比存在性，' +
        '清单不全时「查不到」不是证据，所以这两条本次不做。请把 maxEntries 调高或做一次完整重扫后再看。',
      '文件清单被截断，本次不做孤儿 .uid 与缺 .uid 判定'
    ))
  }

  const have = relSet(tree)
  // 大小写异体闸（与 imports.ts / orphans.ts 共用 treeUtils 的那一份小写像，B6 评审裁定 2）：
  // Windows 文件系统不敏感，`Scripts/Player.GD` 与 `scripts/player.gd.uid` 在盘上配的就是同一对文件。
  // 原来这里两处 `have.has(rel + UID_SUFFIX)` 走精确查表，于是同一个问题 uid 报「缺边车」、
  // imports 报「不缺」—— 两条工具在同一类检查上不许各说各话，统一走 hasRelCI(lower, …)。
  // ⚠ 方向：这一侧只会把「缺失」主张**藏掉**（多认一份边车存在 = 少一条 warn），单调安全；
  //   反过来**不**放宽的是 :155 那条 `rel.endsWith(UID_SUFFIX)` —— 那是「这个条目算不算边车」的自我介绍，
  //   放宽它会把 `X.GD.UID` 这类手改名字当成边车**读进来并计入项目闸门**，方向是**多出主张**，
  //   不在本轮「只藏不加」的授权范围内（imports.ts 的 isSidecar 注释记着对称的那一半理由）。
  const lower = lowerRelSet(tree)
  // `.gdignore` 屏蔽的目录：引擎按设计不扫，那种目录里的脚本永远不会拿到 `.uid` 边车，
  // 报「缺边车」+「把脚本在编辑器里重新保存一次通常会补上边车」是一条做不到的建议（B6 评审 Important 1
  // 说这同一个洞在两份工具里都在，helper 收进 treeUtils 后两边一起adopt）。
  const ignoredDirs = gdignoredDirs(tree)
  /** uid → (声明者 rel → 声明渠道)。按 rel 归并，所以同一文件的边文与头部同 uid 天然不算重复（判据 2） */
  const claims = new Map<string, Map<string, Owner>>()
  const orphans: string[] = []
  const gdRels: string[] = []
  let sidecarCount = 0
  /** 判据 4 的候选里被 `.gdignore` 屏蔽掉的那些，计数写进结论 detail（B5 口径：排除要看得见） */
  let ignoredGd = 0

  const addClaim = (uid: string, ownerRel: string, header: boolean, viaRel: string) => {
    let owners = claims.get(uid)
    if (!owners) {
      owners = new Map()
      claims.set(uid, owners)
    }
    let o = owners.get(ownerRel)
    if (!o) {
      o = { rel: ownerRel, header: false, sidecars: [] }
      owners.set(ownerRel, o)
    }
    if (header) o.header = true
    else if (!o.sidecars.includes(viaRel)) o.sidecars.push(viaRel)
  }

  // 一趟遍历同时收齐「声明」「孤儿候选」「待比对的 .gd」；读取只发生在 `.uid` 与 `.tscn/.tres` 上（判据 6）。
  for (const f of tree) {
    const rel = f && typeof f.rel === 'string' ? f.rel : ''
    if (!rel || isCache(rel)) continue // 判据 1：.godot/** 一律不采集，uid_cache.bin 也不是边车
    const ext = f && typeof f.ext === 'string' ? f.ext : ''
    if (ext === 'gd') {
      // 判据 4 只看 tree 里有没有那份 .uid，不读 .gd 的内容（判据 6）。
      // `.gdignore` 屏蔽的目录不进候选，也不进同目录比对的分组（连同级一起算，别拿被屏蔽的同伴当参照）。
      if (isGdignored(ignoredDirs, rel)) { ignoredGd++; continue }
      gdRels.push(rel)
      continue
    }
    if (ext === 'uid' && rel.endsWith(UID_SUFFIX)) {
      sidecarCount++
      const src = rel.slice(0, -UID_SUFFIX.length)
      if (!src) continue // 源名切空（畸形 rel）时既没法判存在性、也没法归属性，整条跳过
      // 源在不在清单里同样按小写像读：`A.tscn.uid` 配着盘上的 `a.tscn` 时它**不是**孤儿，
      // 而这条结论带删除入口 —— 报错了就是把还在用的边车送走（方向：只会少报孤儿，不会多报）。
      if (complete && !hasRelCI(lower, src)) orphans.push(rel)
      const { text } = await ctx.readText(rel)
      // 判据 6：readText 给不出 text 就是「读不到」（缺文件 / 超 maxBytes / 二进制 / 非法路径），
      // 该文件的声明当作未知跳过 —— 不报错、也不计入重复（漏读不得变假阳性）。
      // 注意存在性判定已经在上面做完了：那是 tree 的事实，与这份文件能不能读无关。
      const token = typeof text === 'string' ? sidecarToken(text) : ''
      if (token) addClaim(token, src, false, rel)
      continue
    }
    if (SCENE_EXT.has(ext)) {
      const { text } = await ctx.readText(rel)
      if (typeof text !== 'string') continue
      const uid = headerUid(text)
      if (uid) addClaim(uid, rel, true, rel)
    }
  }

  // ---------- 判据 2：重复 uid = error ----------
  const dups: { uid: string; owners: Owner[] }[] = []
  for (const [uid, owners] of claims) {
    // 判据 2：同一 rel 既是边文又有头部声明同一个 uid 不算重复 —— 归并键是 rel，两个渠道会落到同一个 Owner
    if (owners.size < 2) continue
    dups.push({ uid, owners: [...owners.values()].sort((a, b) => byText(a.rel, b.rel)) })
  }
  dups.sort((a, b) => byText(a.uid, b.uid))
  for (const d of dups.slice(0, LIST_CAP)) {
    // 主证据优先挑「树里真看得到」的声明者:边文的声明归给它的源,而那个源可能正是被删掉的文件,
    // 拿它当 rel 会让 B10 的「打开所在目录/跳转文件」指点到一个不存在的名字。都不在/都在时
    // 退回码元序第一个(owners 已按 byText 排好),所以这个选择本身逐字节确定。
    const primary = d.owners.find((o) => have.has(o.rel)) || d.owners[0]
    out.push({
      // id = uid 本身（证据），不带下标也不带声明者清单 —— 同一 uid 再长出一个声明者仍是同一条结论，
      // 折叠状态与「忽略这条」的记忆不会因此换键（判据 8）
      id: `uid:dup:${d.uid}`,
      severity: 'error',
      title: `重复 uid ${d.uid}：${d.owners.length} 个文件都声明拥有它`,
      detail: `${d.uid} 的声明者：${d.owners.map(ownerText).join('、')}。` +
        '编辑器只会保留一个声明，另一个会被改写成新 uid —— 指向它的引用（场景副本、拷贝出去的目录）可能就此丢链接。' +
        '请确认哪个才是原件，把另一个在编辑器里重新保存。',
      rel: primary.rel,
      related: d.owners.filter((o) => o !== primary).map((o) => o.rel)
    })
  }
  const hiddenDups = dups.length - Math.min(dups.length, LIST_CAP)
  if (hiddenDups > 0) {
    out.push({
      // 与 size.ts 的 size:bigTail 同形：id 不带数量（数量每次扫描都变，带进 key 会让折叠记忆漂移）
      id: 'uid:dupTail',
      severity: 'error',
      title: `另有 ${hiddenDups} 组重复 uid 未列出`,
      detail: `重复 uid 共 ${dups.length} 组，这里按 uid 字典序只列前 ${LIST_CAP} 组（刷屏控制）。` +
        '想看全量请把 maxEntries 调高后完整重扫。'
    })
  }

  // ---------- 判据 3：孤儿 .uid = warn + trash 修复 ----------
  if (complete && orphans.length) {
    const rels = orphans.slice().sort(byText)
    const shown = rels.slice(0, LIST_CAP)
    const hidden = rels.length - shown.length
    out.push({
      // 聚合：一次大删除能长出几千个孤儿边车，逐文件成条会刷屏（判据 7），所以一条结论带全量清单。
      // id 用常量键：这条的证据本来就是「那一批文件」，取任何单个 rel 都会让「删掉第一个」
      // 把整条结论换个记账键（size.ts:64-73 的 bigTail 是同个理由）。
      id: 'uid:orphan:all',
      severity: 'warn',
      title: `孤儿 .uid 边车 ${rels.length} 个：没有对应的源文件`,
      detail: `${shown.join('、')}${hidden ? ` 等 ${rels.length} 个` : ''} —— 这些 .uid 边车没有对应的源文件` +
        `（把边车名的 ${UID_SUFFIX} 尾缀去掉就是源文件路径），多半是删掉或改名源文件后留下的残留。` +
        (hidden
          ? ` 这里按 rel 只列前 ${shown.length} 个，另有 ${hidden} 个未列出；下面的建议仍按全部 ${rels.length} 个执行。`
          : ''),
      rel: rels[0],
      related: shown,
      // 只有 kind/label/payload：动词、风险句、预览清单都是 fixPlan.ts 的活（见文件头措辞红线）。
      // label 里不写「移入回收站」—— 非 Windows 宿主是真删（fixPlan.ts:240 按 isWin 分叉）。
      // payload.rels 一律全量：planFix 的预览 items 就是由它生成（fixPlan.ts:87-112 → :238-251），
      // 所以上面的展示裁切不会裁掉确认框的完整清单（spec §5.3 规则 3）。
      fix: { kind: 'trash', label: `移除 ${rels.length} 个孤儿 .uid`, payload: { rels } }
    })
  }

  // ---------- 判据 4：.gd 缺 .uid（项目闸门 + 目录闸门） ----------
  if (complete) {
    if (sidecarCount === 0) {
      // 项目闸门：4.4 之前的项目根本没有 .uid，「缺 .uid」在那种项目里不是问题（一条 info 收口）
      out.push({
        id: 'uid:gate:no-uid',
        severity: 'info',
        title: '本项目没有 .uid 边车，本次不做「缺 .uid」判定',
        detail: 'Godot 4.4 之前不生成 .uid 边车，所以「缺 .uid」在这种项目里不是问题，一条都不报。' +
          '重复 uid 的判定不受这个闸门影响（它只看读得到的文件内容）。'
      })
    } else {
      const byDir = new Map<string, string[]>()
      for (const rel of gdRels) {
        const dir = dirOf(rel)
        const arr = byDir.get(dir)
        if (arr) arr.push(rel)
        else byDir.set(dir, [rel])
      }
      const hits: string[] = []
      for (const rel of gdRels) {
        if (hasRelCI(lower, rel + UID_SUFFIX)) continue // 自己已有边文（任意大小写写法），永不报缺失
        const dir = dirOf(rel)
        const siblings = (byDir.get(dir) || []).filter((x) => x !== rel).sort(byText)
        // 目录闸门：同目录里只要还有一个 .gd 也没边文，那就是目录级的既有状态，不报。
        // ⚠ 空集时这个全称判定**成立**（目录里就它一个 .gd）—— 这是刻意的读法，不是漏网：
        //   spec §3.1 #5 原文写的就是「仅当同目录其他 `.gd` 都有时」，量词域是「其他」，
        //   空集上的全称命题为真；而「孤零零一个 .gd 没有边文、项目别处却都在生成边车」
        //   恰好是绕过编辑器拷贝文件的典型形状，报出来有价值。
        //   （简报测试清单曾写过「a.gd 有、b.gd 没有 → 不报 b.gd」的括注,与这条量词写法相反。
        //     控制方 2026-10-04 裁定按字面量词执行,简报已订正 —— 后续轮次别把它改回去。）
        //   这里同样按小写像读同伴的边车：同伴的边车写成 `A.GD.UID` 就是「有」，闸门该放行。
        if (siblings.some((s) => !hasRelCI(lower, s + UID_SUFFIX))) continue
        hits.push(rel)
      }
      for (const rel of hits.sort(byText)) {
        const siblings = (byDir.get(dirOf(rel)) || []).filter((x) => x !== rel).sort(byText)
        const dir = dirOf(rel) || '（项目根）'
        // 「跟谁比」点名要给出完整 rel（与树同形，用户能直接点开），不裁成 basename
        const why = '项目里已存在 .uid 边车，说明这个项目在 Godot 4.4+ 下工作过（4.4 之前不生成 .uid），' +
          '这类缺口通常来自绕过编辑器的拷贝或改名；把该脚本在编辑器里重新保存一次通常会补上边车' +
          '（别复制别人的 .uid 内容，那会造出一个重复 uid）。' +
          (ignoredGd ? ` 本次另有 ${ignoredGd} 个 .gd 位于 .gdignore 屏蔽的目录里，引擎按设计不扫那些目录，一条都没判。` : '')
        out.push({
          // 判据 4：一条 finding 只讲一个 .gd，id 直接落到那个文件
          id: `uid:missing:${rel}`,
          severity: 'warn',
          title: `脚本缺 ${UID_SUFFIX} 边车：${rel}`,
          detail: siblings.length
            ? `同目录 ${dir} 里其他 ${siblings.length} 个 .gd 都有 ${UID_SUFFIX} 边车` +
              `（${siblings.slice(0, 3).join('、')}${siblings.length > 3 ? ' 等' : ''}），只有 ${rel} 没有。${why}`
            : `${rel} 是 ${dir} 里唯一的 .gd，没有同级可比对，但${why}`,
          rel
        })
      }
    }
  }

  return out
}
