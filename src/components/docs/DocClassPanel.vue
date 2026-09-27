<!-- 类详情面板:对齐 Godot 编辑器内置帮助的结构(继承链/派生/描述/信号/成员/方法/枚举与常量/通知/运算符)。
     描述与所有说明文字经 BBRich 渲染,行内引用可点击跳转;同类的滚动定位,跨类的导航交给 DocsView。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import BBRich from './BBRich.vue'
import DocTreeNodeView from './DocTreeNode.vue'
import { useDocs } from '../../composables/useDocs'
import type { DocTreeNode } from '../../composables/useDocs'
import { copyText, notify, openExternal, showInFolder } from '../../services/bridge'
import { onlineDocsUrl } from '../../utils/godotDocs'
import type { DocClassDetail, DocClassExtras } from '../../types/godot'

const props = defineProps<{
  versionId: string
  className: string
  /** 来自搜索命中的定位锚点(如 method-add_child),消费后回调清空 */
  anchor?: string | null
}>()
const emit = defineEmits<{
  (e: 'navigate', className: string, anchor?: string): void
  (e: 'anchor-done'): void
}>()

const detail = ref<DocClassDetail | null>(null)
/** 教程链接(按需从官方 XML 补;离线/未命中为 null,不显示分节) */
const extras = ref<DocClassExtras | null>(null)
const flash = ref('')
const missing = computed(() => !detail.value)

const { favorites, toggleFavorite, pushHistory, derivedOf, inheritsChainOf, currentStatus, treeNode } = useDocs()

/** 当前库的引擎 tag(拼在线文档链接用) */
const currentTag = computed(() => currentStatus.value?.tag)

const chain = computed(() => inheritsChainOf(props.className))
const derived = computed(() => derivedOf(props.className))
const isFav = computed(() => favorites.value.includes(props.className))

// ---------- 继承树(懒加载展开,点击节点跳转) ----------

const treeOpen = ref(false)
const treeRoot = ref<DocTreeNode | null>(null)
/** 单个节点的直接派生展开上限(避免 Node 这类大类一次铺开几百行) */
const TREE_CHILD_CAP = 40

/** 当前类及其祖先链:树里高亮 */
const treePath = computed(() => new Set([props.className, ...chain.value.map((c) => c.name)]))

/** 建树并沿当前类路径逐级展开(打开即定位到当前类) */
function buildTree() {
  const chainNames = [...chain.value].reverse().map((c) => c.name)
  const root = treeNode(chainNames[0] ?? props.className)
  expandNode(root)
  let cur = root
  for (const name of [...chainNames.slice(1), props.className]) {
    const next = cur.children.find((c) => c.name === name)
    if (!next) break
    expandNode(next)
    cur = next
  }
  treeRoot.value = root
}

/** 展开节点:填充直接派生(按名排序,超上限截断) */
function expandNode(node: DocTreeNode) {
  if (node.expanded) return
  node.children = derivedOf(node.name)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, TREE_CHILD_CAP)
    .map((c) => treeNode(c.name))
  node.expanded = true
}

watch(treeOpen, (open) => {
  if (open) buildTree()
  else treeRoot.value = null
})

/** 切类时若树开着,重新定位 */
watch(() => props.className, () => {
  if (treeOpen.value) buildTree()
})


/** 通知(NOTIFICATION_*)单独成节,其余常量与枚举并列 */
const notifications = computed(() => detail.value?.constants.filter((c) => c.name.startsWith('NOTIFICATION_')) ?? [])
const plainConstants = computed(() => detail.value?.constants.filter((c) => !c.name.startsWith('NOTIFICATION_')) ?? [])
const hasEnumSection = computed(() => plainConstants.value.length > 0 || (detail.value?.enums.length ?? 0) > 0)

// ---------- 本页目录(右侧粘性栏) ----------

interface TocItem { anchor: string, label: string }
interface TocGroup { key: string, label: string, items: TocItem[] }

const toc = computed<TocGroup[]>(() => {
  const d = detail.value
  if (!d) return []
  const g: TocGroup[] = []
  const add = (key: string, label: string, items: TocItem[]) => { if (items.length) g.push({ key, label, items }) }
  add('tutorials', '教程', (extras.value?.tutorials ?? []).map((t, i) => ({ anchor: `tut-${i}`, label: t.title })))
  add('signals', '信号', d.signals.map((s) => ({ anchor: `signal-${s.name}`, label: s.name })))
  add('members', '成员', d.members.map((x) => ({ anchor: `member-${x.name}`, label: x.name })))
  add('methods', '方法', d.methods.map((m) => ({ anchor: methodAnchor(m), label: m.name })))
  add('enums', '枚举与常量', [
    ...d.enums.map((e) => ({ anchor: `enum-${e.name}`, label: e.name })),
    ...plainConstants.value.map((c) => ({ anchor: `constant-${c.name}`, label: c.name }))
  ])
  add('notices', '通知', notifications.value.map((c) => ({ anchor: `constant-${c.name}`, label: c.name })))
  add('ops', '运算符', d.operators.map((op, i) => ({ anchor: `operator-${i}`, label: op.name || `#${i + 1}` })))
  return g
})

/** 当前滚动到的分组(组标题进入视口顶部以上时切换),rAF 节流 */
const activeToc = ref('')
let tocRaf = 0

function onScroll() {
  if (tocRaf) return
  tocRaf = requestAnimationFrame(() => {
    tocRaf = 0
    if (!rootEl.value) return
    let cur = ''
    rootEl.value.querySelectorAll<HTMLElement>('[data-toc-sec]').forEach((el) => {
      if (el.getBoundingClientRect().top <= 130) cur = el.dataset.tocSec || ''
    })
    activeToc.value = cur
  })
}

function load() {
  detail.value = props.className ? window.services.docsGetClass(props.versionId, props.className) : null
  flash.value = ''
  extras.value = null
  // 教程链接:后台按需拉取(缓存在库目录 extras/),失败静默 —— 离线浏览不受影响
  if (detail.value) {
    const want = `${props.versionId}/${detail.value.name}`
    window.services.docsGetClassExtras(props.versionId, detail.value.name)
      .then((ex) => {
        // 期间用户可能已切到别的类:只认当前这次请求的结果
        if (ex && detail.value && `${props.versionId}/${detail.value.name}` === want) extras.value = ex
      })
      .catch(() => { /* 静默 */ })
    pushHistory(detail.value.name)
  }
  if (props.anchor) {
    nextTick(() => {
      scrollToAnchor(props.anchor!)
      emit('anchor-done')
    })
  } else {
    nextTick(() => rootEl.value?.scrollTo({ top: 0 }))
  }
}

watch(() => [props.versionId, props.className], load, { immediate: true })

const rootEl = ref<HTMLElement | null>(null)

function scrollToAnchor(anchor: string) {
  const root = rootEl.value
  if (!root) return
  // 精确匹配优先;方法锚点已带参数个数,旧格式(仅符号名)回退按前缀取第一个
  const el = root.querySelector(`[data-doc-id="doc-${anchor}"]`) ||
    root.querySelector(`[data-doc-id^="doc-${anchor}-"]`)
  if (!el) return
  el.scrollIntoView({ block: 'start' })
  flash.value = anchor
  setTimeout(() => { flash.value = '' }, 1400)
}

/** 行内引用点击:同类内滚动定位;跨类/显式类前缀交给父级切换类 */
function onRef(kind: string, target: string) {
  if (kind === 'class') {
    emit('navigate', target)
    return
  }
  if (target.includes('.')) {
    const dot = target.indexOf('.')
    const cls = target.slice(0, dot)
    const name = target.slice(dot + 1)
    if (cls === props.className) {
      scrollToAnchor(`${kind}-${name}`)
    } else {
      emit('navigate', cls, `${kind}-${name}`)
    }
    return
  }
  // [param x]:定位到含该参数的方法签名(取第一个匹配),至少给一个落点
  if (kind === 'param') {
    const hit = detail.value?.methods.find((m) => m.params.some((p) => p.name === target))
    if (hit) scrollToAnchor(`method-${hit.name}`)
    return
  }
  scrollToAnchor(`${kind}-${target}`)
}

/** 重载方法锚点需带参数个数消歧(同名不同参的方法会互相撞锚点) */
function methodAnchor(m: { name: string, params: unknown[] }): string {
  return `method-${m.name}-${m.params.length}`
}

/**
 * 锚点 → DOM data-doc-id。滚动/跳转统一走 anchorDomId,渲染侧的 data-doc-id 与之一致。
 * 旧格式(无参数个数的 method-<name>)仍兼容:滚动时回退按前缀查第一个匹配。
 */
function anchorDomId(anchor: string): string {
  return `doc-${anchor}`
}

/** 复制签名(Markdown):外链指向官方在线文档,便于贴进笔记/issue */
function copySignature(text: string, kind: string, symbol: string) {
  const url = onlineDocsAnchorSafe(kind, symbol)
  const ok = copyText(`${text}\n\n${url}`)
  notify(ok ? '已复制签名与文档链接' : '复制失败,请手动选中复制')
}

/** 方法/成员/信号的在线锚点(未知 kind 回退类页) */
function onlineDocsAnchorSafe(kind: string, symbol: string): string {
  const base = onlineDocsUrl(currentTag.value, detail.value?.name ?? props.className)
  const prefixes: Record<string, string> = { method: 'method', signal: 'signal', constant: 'constant', enum: 'enum', member: 'property' }
  const p = prefixes[kind]
  return p ? `${base}#${p}-${String(symbol).toLowerCase()}` : base
}

/** 打开该类在官方在线文档的页面 */
function openOnline() {
  openExternal(onlineDocsUrl(currentTag.value, props.className))
}

/** 方法签名展示:name(a: Type = default, ...) -> Ret */
function signature(m: { name: string, returnType: string, params: { name: string, type: string, defaultValue?: string }[] }): string {
  const args = m.params.map((p) => `${p.name}: ${p.type}${p.defaultValue !== undefined ? ` = ${p.defaultValue}` : ''}`).join(', ')
  return `${m.name}(${args}) -> ${m.returnType}`
}
</script>

<template>
  <div ref="rootEl" class="panel" @scroll="onScroll">
    <div v-if="detail" class="panel-grid">
      <div class="panel-main">
      <header class="head">
        <div class="title-row">
          <h2 class="cls-name mono">{{ detail.name }}</h2>
          <span v-if="detail.builtin" class="badge">builtin</span>
          <span v-if="detail.isSingleton" class="badge warn">单例</span>
          <span class="grow"></span>
          <button class="icon-btn" title="复制类签名与文档链接" @click="copySignature(`class ${detail.name}${detail.inherits ? ' extends ' + detail.inherits : ''}`, 'class', detail.name)">
            <Icon name="copy" :size="14" />
          </button>
          <button class="icon-btn" title="在官方在线文档中打开" @click="openOnline">
            <Icon name="external" :size="14" />
          </button>
          <button class="icon-btn" :class="{ on: isFav }" :title="isFav ? '取消收藏' : '收藏'" @click="toggleFavorite(detail.name)">
            <Icon name="star" :size="15" />
          </button>
        </div>
        <div class="crumbs">
          <span class="crumb-label">继承:</span>
          <template v-if="chain.length">
            <button v-for="p in chain" :key="p.name" class="crumb mono" @click="emit('navigate', p.name)">{{ p.name }}</button>
          </template>
          <span v-else class="crumb-none">无(根类)</span>
        </div>
        <div v-if="derived.length" class="crumbs">
          <span class="crumb-label">派生:</span>
          <button v-for="d in derived" :key="d.name" class="crumb mono" @click="emit('navigate', d.name)">{{ d.name }}</button>
        </div>
        <!-- 项目脚本类:显示来源文件,点击在文件管理器中定位 -->
        <div v-if="detail.sourceFile" class="crumbs">
          <span class="crumb-label">来源:</span>
          <button class="crumb mono" :title="detail.sourceFile" @click="showInFolder(detail.sourceFile)">
            {{ detail.sourceFile.split(/[\\/]/).pop() }}
          </button>
        </div>
        <div class="crumbs">
          <button class="tree-toggle" :title="treeOpen ? '收起继承树' : '展开可浏览的继承树'" @click="treeOpen = !treeOpen">
            <Icon :name="treeOpen ? 'chevron-down' : 'chevron-right'" :size="11" />
            继承树
          </button>
        </div>
        <div v-if="treeOpen && treeRoot" class="tree-box">
          <DocTreeNodeView :node="treeRoot" :path="treePath" :cap="TREE_CHILD_CAP" @navigate="(n) => emit('navigate', n)" />
        </div>
      </header>

      <section v-if="detail.brief" class="sec">
        <h3>简述</h3>
        <p class="brief"><BBRich :text="detail.brief" @ref="onRef" @url="openExternal" /></p>
      </section>

      <section v-if="detail.description" class="sec">
        <h3>描述</h3>
        <div class="desc"><BBRich :text="detail.description" @ref="onRef" @url="openExternal" /></div>
      </section>

      <section v-if="extras && extras.tutorials.length" class="sec">
        <h3>教程 <span class="count">{{ extras.tutorials.length }}</span></h3>
        <button
          v-for="t in extras.tutorials"
          :key="t.url"
          type="button"
          class="tut-row"
          :title="t.url"
          @click="openExternal(t.url)"
        >
          <Icon name="link" :size="13" />
          <span class="tut-title">{{ t.title }}</span>
          <Icon name="external" :size="11" class="tut-ext" />
        </button>
      </section>

      <section v-if="detail.signals.length" class="sec">
        <h3 data-toc-sec="signals">信号 <span class="count">{{ detail.signals.length }}</span></h3>
        <div
          v-for="s in detail.signals"
          :key="s.name"
          class="item"
          :data-doc-id="`doc-signal-${s.name}`"
          :class="{ flash: flash === `signal-${s.name}` }"
        >
          <div class="sig mono">
            <span class="kw">signal</span> {{ s.name }}<span v-if="s.params.length">({{ s.params.map((p) => `${p.name}: ${p.type}`).join(', ') }})</span><span v-else>()</span>
            <button class="sig-act" title="复制签名与文档链接" @click="copySignature(`signal ${detail.name}.${s.name}(${s.params.map((p) => `${p.name}: ${p.type}`).join(', ')})`, 'signal', s.name)">
              <Icon name="copy" :size="11" />
            </button>
          </div>
          <div v-if="s.description" class="item-desc"><BBRich :text="s.description" @ref="onRef" @url="openExternal" /></div>
        </div>
      </section>

      <section v-if="detail.members.length" class="sec">
        <h3 data-toc-sec="members">成员 <span class="count">{{ detail.members.length }}</span></h3>
        <div
          v-for="mb in detail.members"
          :key="mb.name"
          class="item"
          :data-doc-id="`doc-member-${mb.name}`"
          :class="{ flash: flash === `member-${mb.name}` }"
        >
          <div class="sig mono">
            <span class="type">{{ mb.type }}</span> <span class="name">{{ mb.name }}</span>
            <span v-if="mb.defaultValue !== undefined" class="default">= {{ mb.defaultValue }}</span>
            <span v-if="!mb.setter" class="badge dim">只读</span>
            <button class="sig-act" title="复制签名与文档链接" @click="copySignature(`${mb.type} ${detail.name}.${mb.name}`, 'member', mb.name)">
              <Icon name="copy" :size="11" />
            </button>
          </div>
          <div v-if="mb.description" class="item-desc"><BBRich :text="mb.description" @ref="onRef" @url="openExternal" /></div>
        </div>
      </section>

      <section v-if="detail.methods.length" class="sec">
        <h3 data-toc-sec="methods">方法 <span class="count">{{ detail.methods.length }}</span></h3>
        <div
          v-for="m in detail.methods"
          :key="m.name + m.params.length"
          class="item"
          :data-doc-id="`doc-${methodAnchor(m)}`"
          :class="{ flash: flash === methodAnchor(m) || flash === `method-${m.name}` }"
        >
          <div class="sig mono">
            <span v-for="q in m.qualifiers" :key="q" class="kw">{{ q }}</span>
            <span class="name">{{ signature(m) }}</span>
            <button class="sig-act" title="复制签名与文档链接" @click="copySignature(`${detail.name}.${signature(m)}`, 'method', m.name)">
              <Icon name="copy" :size="11" />
            </button>
          </div>
          <div v-if="m.description" class="item-desc"><BBRich :text="m.description" @ref="onRef" @url="openExternal" /></div>
        </div>
      </section>

      <section v-if="hasEnumSection" class="sec">
        <h3 data-toc-sec="enums">枚举与常量</h3>
        <div
          v-for="e in detail.enums"
          :key="e.name"
          class="item"
          :data-doc-id="`doc-enum-${e.name}`"
          :class="{ flash: flash === `enum-${e.name}` }"
        >
          <div class="sig mono">
            <span v-if="e.bitfield" class="kw bitfield">flags</span>
            <span class="kw">enum</span> <span class="name">{{ e.name }}</span>
          </div>
          <div v-for="v in e.values" :key="v.name" class="enum-row mono">
            <span class="name">{{ v.name }}</span> <span class="default">= {{ v.value }}</span>
            <div v-if="v.description" class="item-desc"><BBRich :text="v.description" @ref="onRef" @url="openExternal" /></div>
          </div>
        </div>
        <div
          v-for="c in plainConstants"
          :key="c.name"
          class="item"
          :data-doc-id="`doc-constant-${c.name}`"
          :class="{ flash: flash === `constant-${c.name}` }"
        >
          <div class="sig mono">
            <span class="kw">const</span> <span class="name">{{ c.name }}</span> <span class="default">= {{ c.value }}</span>
          </div>
          <div v-if="c.description" class="item-desc"><BBRich :text="c.description" @ref="onRef" @url="openExternal" /></div>
        </div>
      </section>

      <section v-if="notifications.length" class="sec">
        <h3 data-toc-sec="notices">通知 <span class="count">{{ notifications.length }}</span></h3>
        <div
          v-for="c in notifications"
          :key="c.name"
          class="item"
          :data-doc-id="`doc-constant-${c.name}`"
          :class="{ flash: flash === `constant-${c.name}` }"
        >
          <div class="sig mono">
            <span class="kw">const</span> <span class="name">{{ c.name }}</span> <span class="default">= {{ c.value }}</span>
          </div>
          <div v-if="c.description" class="item-desc"><BBRich :text="c.description" @ref="onRef" @url="openExternal" /></div>
        </div>
      </section>

      <section v-if="detail.operators.length" class="sec">
        <h3 data-toc-sec="ops">运算符 <span class="count">{{ detail.operators.length }}</span></h3>
        <div v-for="(op, i) in detail.operators" :key="i" class="item" :data-doc-id="`doc-operator-${i}`">
          <div class="sig mono">
            <span class="name">{{ op.name || 'op' }}({{ op.params.map((p) => `${p.name}: ${p.type}`).join(', ') }}) -> {{ op.returnType }}</span>
          </div>
          <div v-if="op.description" class="item-desc"><BBRich :text="op.description" @ref="onRef" @url="openExternal" /></div>
        </div>
      </section>

      </div><!-- /panel-main -->

      <aside v-if="toc.length" class="toc">
        <div class="toc-title">本页目录</div>
        <template v-for="g in toc" :key="g.key">
          <div class="toc-group" :class="{ on: activeToc === g.key }">{{ g.label }}</div>
          <button
            v-for="it in g.items"
            :key="it.anchor"
            type="button"
            class="toc-item"
            :title="it.label"
            @click="scrollToAnchor(it.anchor)"
          >{{ it.label }}</button>
        </template>
      </aside>
    </div><!-- /panel-grid -->

    <div v-else class="missing">
      <Icon name="alert" :size="20" />
      <p>未在当前文档库中找到「{{ className }}」。</p>
      <p class="hint">它可能属于其他版本,或文档库尚未收录。</p>
    </div>
  </div>
</template>

<style scoped>
.panel {
  height: 100%;
  overflow-y: auto;
  padding: 18px 22px 30px;
}

.head {
  margin-bottom: 14px;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cls-name {
  margin: 0;
  font-size: 21px;
  font-weight: 700;
  color: var(--text);
}

.grow {
  flex: 1;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-3);
  cursor: pointer;
}

.icon-btn.on {
  color: var(--warning, #e8a33d);
  border-color: color-mix(in srgb, var(--warning, #e8a33d) 40%, transparent);
}

.badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-2);
}

.badge.warn {
  color: var(--brand);
  border-color: color-mix(in srgb, var(--brand) 35%, transparent);
}

.badge.dim {
  margin-left: 6px;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 7px;
  font-size: 12.5px;
}

.crumb-label {
  color: var(--text-3);
}

.crumb {
  border: none;
  background: none;
  padding: 0;
  color: var(--brand);
  cursor: pointer;
  font-size: 12.5px;
}

.crumb:hover {
  text-decoration: underline;
}

.crumb-none {
  color: var(--text-3);
}

.tree-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: none;
  padding: 1px 5px;
  font-size: 12px;
  color: var(--text-3);
  cursor: pointer;
  border-radius: 5px;
}

.tree-toggle:hover {
  color: var(--brand);
  background: var(--surface-2);
}

.tree-box {
  margin-top: 8px;
  padding: 9px 12px;
  max-height: 340px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-2);
}

.sec {
  margin-top: 18px;
}

.sec h3 {
  margin: 0 0 8px;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 6px;
}

.tut-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 11px;
  margin-bottom: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-2);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.tut-row:hover {
  color: var(--brand);
  border-color: color-mix(in srgb, var(--brand) 35%, transparent);
}

.tut-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tut-ext {
  color: var(--text-3);
  flex-shrink: 0;
}

.count {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  background: var(--surface-2);
  border-radius: 999px;
  padding: 1px 7px;
}

.brief {
  margin: 0;
  color: var(--text-2);
  font-size: 13px;
}

.desc {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.75;
  white-space: pre-line;
}

.item {
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  margin-bottom: 8px;
  background: var(--surface);
  transition: background 0.5s;
}

.item.flash {
  animation: doc-flash 1.4s ease-out;
}

@keyframes doc-flash {
  0% { background: color-mix(in srgb, var(--brand) 16%, var(--surface)); }
  100% { background: var(--surface); }
}

.sig {
  font-size: 12.5px;
  color: var(--text);
  word-break: break-all;
}

.sig .kw {
  color: var(--text-3);
  margin-right: 5px;
  font-size: 11px;
}

.sig .kw.bitfield {
  color: var(--warning, #e8a33d);
}

.sig .type {
  color: var(--brand);
}

.sig .name {
  color: var(--text);
  font-weight: 600;
}

.sig .default {
  color: var(--text-3);
  margin-left: 5px;
}

.item:hover .sig-act {
  opacity: 1;
}

.sig-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: 7px;
  vertical-align: -3px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-3);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}

.sig-act:hover {
  color: var(--brand);
}

.item-desc {
  margin-top: 5px;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-line;
}

.enum-row {
  padding: 5px 0 2px 14px;
  font-size: 12px;
  border-top: 1px dashed var(--border);
  margin-top: 5px;
}

.enum-row:first-of-type {
  border-top: none;
}

.missing {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin-top: 80px;
  color: var(--text-2);
  font-size: 13px;
}

.missing .hint {
  font-size: 12px;
  color: var(--text-3);
}

/* ---------- 本页目录(右侧粘性栏) ---------- */
.panel-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 176px;
  gap: 20px;
  align-items: start;
}

.panel-main {
  min-width: 0;
}

.toc {
  position: sticky;
  top: 0;
  /* 按视口约束:100% 相对本列自身内容高度不生效,目录栏会撑开到与正文等高且无法独立滚动 */
  max-height: calc(100vh - 100px);
  overflow-y: auto;
  scrollbar-width: thin;
  padding: 2px 0 12px;
  border-left: 1px solid var(--border);
  padding-left: 12px;
}

.toc-title {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--text-3);
  margin-bottom: 4px;
}

.toc-group {
  margin-top: 9px;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--text-3);
}

.toc-group.on {
  color: var(--brand);
}

.toc-item {
  display: block;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  border: none;
  border-left: 2px solid transparent;
  background: none;
  padding: 2px 0 2px 8px;
  font-size: 11.5px;
  font-family: var(--mono);
  color: var(--text-2);
  cursor: pointer;
}

.toc-item:hover {
  color: var(--brand);
  border-left-color: var(--brand-weak);
}

@media (max-width: 1150px) {
  .panel-grid {
    grid-template-columns: 1fr;
  }

  .toc {
    display: none;
  }
}
</style>
