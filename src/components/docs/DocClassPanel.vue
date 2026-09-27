<!-- 类详情面板:对齐 Godot 编辑器内置帮助的结构(继承链/派生/描述/信号/成员/方法/枚举与常量/通知/运算符)。
     描述与所有说明文字经 BBRich 渲染,行内引用可点击跳转;同类的滚动定位,跨类的导航交给 DocsView。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import BBRich from './BBRich.vue'
import { useDocs } from '../../composables/useDocs'
import { openExternal } from '../../services/bridge'
import type { DocClassDetail } from '../../types/godot'

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
const flash = ref('')
const missing = computed(() => !detail.value)

const { favorites, toggleFavorite, pushHistory, derivedOf, inheritsChainOf } = useDocs()

const chain = computed(() => inheritsChainOf(props.className))
const derived = computed(() => derivedOf(props.className))
const isFav = computed(() => favorites.value.includes(props.className))

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
  add('signals', '信号', d.signals.map((s) => ({ anchor: `signal-${s.name}`, label: s.name })))
  add('members', '成员', d.members.map((x) => ({ anchor: `member-${x.name}`, label: x.name })))
  add('methods', '方法', d.methods.map((x) => ({ anchor: `method-${x.name}`, label: x.name })))
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
  if (detail.value) pushHistory(detail.value.name)
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
  const el = rootEl.value?.querySelector(`[data-doc-id="doc-${anchor}"]`)
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
  // 无类前缀:[param] 归属方法无从定位,其余按本类成员滚动
  if (kind === 'param') return
  scrollToAnchor(`${kind}-${target}`)
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
      </header>

      <section v-if="detail.brief" class="sec">
        <h3>简述</h3>
        <p class="brief"><BBRich :text="detail.brief" @ref="onRef" @url="openExternal" /></p>
      </section>

      <section v-if="detail.description" class="sec">
        <h3>描述</h3>
        <div class="desc"><BBRich :text="detail.description" @ref="onRef" @url="openExternal" /></div>
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
          :data-doc-id="`doc-method-${m.name}`"
          :class="{ flash: flash === `method-${m.name}` }"
        >
          <div class="sig mono">
            <span v-for="q in m.qualifiers" :key="q" class="kw">{{ q }}</span>
            <span class="name">{{ signature(m) }}</span>
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
  max-height: 100%;
  overflow-y: auto;
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
