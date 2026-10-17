<script setup lang="ts">
// 资产详情对话框:展示商店详情接口的媒体画廊/简介/标签/许可/评分,
// 外加「详细介绍」(body_html)与「更新日志」(各版本 changes_html),
// 帮助在安装前判断「装不装」。数据由 services.getAssetDetail 现取。
import { computed, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { formatRelative, normVersion } from '../../utils/format'
import { IS_DESKTOP } from '../../services/desktop'
import { openExternal } from '../../services/bridge'
import { useTranslation } from '../../composables/useTranslation'
import type { AssetDetail } from '../../types/godot'

const props = defineProps<{
  open: boolean
  assetId: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const detail = ref<AssetDetail | null>(null)
const loading = ref(false)
const error = ref('')
/** 画廊当前展示的大图 */
const active = ref('')
/** 更新日志默认只展开最近几个版本,防止长列表把弹窗顶穿 */
const showAllReleases = ref(false)

// ---------- 翻译 ----------
// 只翻三处:简介、详细介绍(富文本)、各版本更新日志(富文本)。
// 标题/作者/许可/标签不翻 —— 标题是专有名词,作者是用户名,标签有固定映射表。
const {
  settings: trSettings,
  enabled: trEnabled,
  failedCount: trFailedCount,
  lastError: trLastError,
  textOf: trText,
  hasText: trHasText,
  translate: trTranslate,
  ensureSettings: trEnsure
} = useTranslation()

/** 用户临时切到原文(只影响本次弹窗,不写设置) */
const showOriginal = ref(false)

/** 是否正在显示译文 */
const trOn = computed(() => trEnabled.value && !showOriginal.value)

function keyDesc() { return `desc:${props.assetId}` }
function keyBody() { return `html:${props.assetId}` }
function keyChanges(r: { version: string, created: string }) { return `chg:${props.assetId}:${r.version}@${r.created}` }

/** 简介(译/原) */
const descText = computed(() => {
  const src = detail.value?.description || ''
  if (!trOn.value) return src
  return trText(keyDesc(), src)
})

/** 详细介绍 HTML(译/原) */
const bodyHtml = computed(() => {
  const src = detail.value?.bodyHtml || ''
  if (!trOn.value) return src
  return trText(keyBody(), src)
})

/** 某版本的更新日志 HTML(译/原) */
function changesHtmlOf(r: { version: string, created: string, changesHtml: string }): string {
  if (!trOn.value) return r.changesHtml
  return trText(keyChanges(r), r.changesHtml)
}

/** 打开详情后把三处文案排进翻译队列(scene=long → 优先走 AI,它能保住 HTML 结构) */
async function translateDetail() {
  await trEnsure()
  if (!trEnabled.value || !detail.value) return
  const items: { key: string, text: string, assetId: string, kind: 'desc' | 'html' | 'changes' }[] = []
  if (detail.value.description) {
    items.push({ key: keyDesc(), text: detail.value.description, assetId: props.assetId, kind: 'desc' })
  }
  if (detail.value.bodyHtml) {
    items.push({ key: keyBody(), text: detail.value.bodyHtml, assetId: props.assetId, kind: 'html' })
  }
  for (const r of shownReleases.value) {
    if (r.changesHtml) items.push({ key: keyChanges(r), text: r.changesHtml, assetId: props.assetId, kind: 'changes' })
  }
  if (items.length) trTranslate(items, 'long')
}

/** 更新日志列表(preload 已按发布时间倒序) */
const releaseList = computed(() => detail.value?.releases ?? [])
const shownReleases = computed(() =>
  showAllReleases.value ? releaseList.value : releaseList.value.slice(0, 5)
)

async function load() {
  if (!props.assetId) return
  loading.value = true
  error.value = ''
  detail.value = null
  active.value = ''
  showAllReleases.value = false
  try {
    detail.value = await window.services.getAssetDetail(props.assetId)
    if (!detail.value) {
      // 宿主没给详情时要说人话。以前桌面版的垫片回的是 {ok:false},这一行读 media[0] 直接抛
      // TypeError,弹层上显示的就是「加载失败:Cannot read properties of undefined」。
      error.value = IS_DESKTOP
        ? '桌面版暂不支持读取商店详情,列表卡片上的信息仍可用于判断是否安装。'
        : '商店没有返回该资产的详情,可稍后重试或从列表卡片直接安装。'
      return
    }
    active.value = detail.value.media[0] || ''
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.open, props.assetId],
  () => {
    if (!props.open) return
    // 每开一次都从译文开始:上一次手动切的「原文」不该带到另一个资产
    showOriginal.value = false
    load().then(() => translateDetail())
  }
)

// 点「显示全部 N 个版本」后,把新露出来的日志补翻掉(没展开的不翻,省额度)
watch(shownReleases, () => {
  if (props.open) translateDetail()
})

function openStore() {
  if (detail.value?.storeUrl) window.ztools.shellOpenExternal(detail.value.storeUrl)
}

/** v-html 富文本里的链接统一改走系统浏览器(webview 内导航会把插件界面顶掉) */
function onHtmlClick(e: MouseEvent) {
  const a = (e.target as HTMLElement)?.closest?.('a')
  if (!a) return
  const href = a.getAttribute('href') || ''
  if (href) {
    e.preventDefault()
    openExternal(href)
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="emit('close')">
      <div class="card modal">
        <div class="modal-head">
          <div class="modal-title"><Icon name="package" :size="15" /> {{ detail?.title || '资产详情' }}</div>
          <span class="grow"></span>
          <div v-if="trEnabled && detail" class="seg d-tr-seg" role="tablist" aria-label="显示译文或原文">
            <button :class="{ on: !showOriginal }" title="显示机器翻译" @click="showOriginal = false">译文</button>
            <button :class="{ on: showOriginal }" title="显示商店原文" @click="showOriginal = true">原文</button>
          </div>
          <button type="button" class="btn small ghost icon-x" title="关闭" @click="emit('close')">
            <Icon name="x" :size="14" />
          </button>
        </div>

        <div v-if="loading" class="hint-line"><span class="spin"></span> 加载详情…</div>

        <div v-else-if="error" class="detail-error">
          <Icon name="alert" :size="14" />
          <span>加载失败:{{ error }}</span>
        </div>

        <template v-else-if="detail">
          <div class="d-meta">
            <span class="d-author">{{ detail.author }}</span>
            <span v-if="detail.versionString" class="tag">v{{ normVersion(detail.versionString) }}</span>
            <span v-if="detail.licenseType" class="tag" :title="detail.licenseUrl">{{ detail.licenseType }}</span>
            <span v-if="detail.reviewsScore" class="tag ok" title="商店点赞数">
              <Icon name="star" :size="10" /> {{ detail.reviewsScore }}
            </span>
          </div>

          <div v-if="detail.media.length" class="d-gallery">
            <img :src="active" class="d-shot" alt="" />
            <div v-if="detail.media.length > 1" class="d-thumbs">
              <button
                v-for="(m, i) in detail.media.slice(0, 6)"
                :key="m"
                type="button"
                class="d-thumb"
                :class="{ on: active === m }"
                @click="active = m"
              >
                <img :src="m" alt="" />
              </button>
            </div>
          </div>

          <div v-if="detail.tags.length" class="d-tags">
            <span v-for="t in detail.tags" :key="t" class="tag">{{ t }}</span>
          </div>

          <p class="d-desc">
            {{ descText || '暂无简介' }}
            <span v-if="trOn && trHasText(keyDesc())" class="d-tr-badge" title="由翻译服务生成,切换上方「原文」可对照">机器翻译</span>
          </p>

          <!-- 商店详情页完整介绍(富文本):有译文时用译文 HTML,标签结构由 preload 保住 -->
          <section v-if="detail.bodyHtml" class="d-sec">
            <div class="d-sec-label">详细介绍</div>
            <div class="rich" @click="onHtmlClick" v-html="bodyHtml"></div>
          </section>

          <!-- 各版本变更日志 -->
          <section v-if="releaseList.length" class="d-sec">
            <div class="d-sec-label">更新日志</div>
            <div class="rel-list">
              <div v-for="r in shownReleases" :key="r.version + r.created" class="rel">
                <div class="rel-head">
                  <span v-if="r.version" class="tag brand">v{{ normVersion(r.version) }}</span>
                  <span v-if="!r.stable" class="tag warn" title="测试/预览版">测试版</span>
                  <span class="rel-date">{{ formatRelative(new Date(r.created).getTime() || 0, '—') }}</span>
                </div>
                <div v-if="r.changesHtml" class="rich" @click="onHtmlClick" v-html="changesHtmlOf(r)"></div>
                <div v-else class="rel-empty">该版本未填写变更说明</div>
              </div>
              <button
                v-if="releaseList.length > 5 && !showAllReleases"
                class="rel-more"
                @click="showAllReleases = true"
              >
                显示全部 {{ releaseList.length }} 个版本
              </button>
            </div>
          </section>

          <div v-if="trEnabled && trFailedCount" class="d-tr-note" :title="trLastError">
            <Icon name="alert" :size="11" />
            <span>{{ trFailedCount }} 处内容未翻译{{ trLastError ? `(${trLastError})` : '' }},已显示原文。</span>
          </div>

          <div class="d-foot">
            <button class="btn ghost" @click="openStore">
              <Icon name="external" :size="12" /> 在商店中打开
            </button>
            <span class="grow"></span>
            <button class="btn primary" @click="emit('close')">完成</button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.grow {
  flex: 1;
}

/* ---------- 译文 / 原文切换 ---------- */
.d-tr-seg {
  flex-shrink: 0;
  margin-right: 4px;
}

.d-tr-seg button {
  font-size: 11.5px;
  padding: 3px 9px;
}

/* 「机器翻译」小标:让它和商店原文能分开看 */
.d-tr-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--brand-weak);
  color: var(--brand);
  font-size: 10px;
  font-weight: 700;
  vertical-align: middle;
  white-space: nowrap;
}

.d-tr-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 11.5px;
  color: var(--text-3);
}

/* ---------- 分节(详细介绍 / 更新日志) ---------- */

.d-sec {
  margin: 12px 0 2px;
}

.d-sec-label {
  margin-bottom: 7px;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}

/* 商店 HTML 富文本排版(链接点击由 onHtmlClick 委派走系统浏览器) */
.rich {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
  overflow-wrap: break-word;
}

.rich :deep(h1),
.rich :deep(h2),
.rich :deep(h3),
.rich :deep(h4) {
  margin: 10px 0 4px;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.5;
}

.rich :deep(h1:first-child),
.rich :deep(h2:first-child),
.rich :deep(h3:first-child) {
  margin-top: 0;
}

.rich :deep(p) {
  margin: 5px 0;
}

.rich :deep(ul),
.rich :deep(ol) {
  margin: 5px 0;
  padding-left: 20px;
}

.rich :deep(a) {
  color: var(--brand);
  text-decoration: none;
}

.rich :deep(a:hover) {
  text-decoration: underline;
}

.rich :deep(code) {
  font-family: var(--mono);
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface-3);
}

.rich :deep(pre) {
  margin: 6px 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  overflow-x: auto;
}

.rich :deep(pre code) {
  padding: 0;
  background: none;
}

.rich :deep(img) {
  max-width: 100%;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}

.rich :deep(blockquote) {
  margin: 6px 0;
  padding: 2px 12px;
  border-left: 3px solid var(--brand);
  color: var(--text-2);
}

/* ---------- 更新日志列表 ---------- */

.rel-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rel {
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.rel-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 4px;
}

.rel-date {
  font-size: 12px;
  color: var(--text-3);
}

.rel-empty {
  font-size: 12.5px;
  color: var(--text-3);
}

.rel-more {
  align-self: center;
  border: 1px dashed var(--border-strong);
  border-radius: 999px;
  background: none;
  padding: 4px 16px;
  font-size: 12px;
  color: var(--brand);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.rel-more:hover {
  border-color: var(--brand);
  background: var(--brand-weak);
}

.hint-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-3);
  padding: 12px 0;
}

.detail-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  font-size: 12.5px;
  color: var(--danger);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--danger-weak);
}

.d-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.d-author {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}

.d-gallery {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.d-shot {
  width: 100%;
  max-height: 260px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface-2);
}

.d-thumbs {
  display: flex;
  gap: 6px;
  overflow-x: auto;
}

.d-thumb {
  flex-shrink: 0;
  width: 76px;
  height: 46px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  cursor: pointer;
  opacity: 0.65;
  transition: opacity 0.15s, border-color 0.15s;
}

.d-thumb.on {
  opacity: 1;
  border-color: var(--brand);
}

.d-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.d-tags {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.d-desc {
  margin: 0 0 12px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-2);
  white-space: pre-wrap;
  max-height: 180px;
  overflow-y: auto;
}

.d-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
  margin-top: 2px;
  border-top: 1px solid var(--border);
}
</style>
