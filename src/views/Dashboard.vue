<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getSettings, listDocs, pickDirectory, saveSettings, showInFolder } from '../services/bridge'
import { openProjectAction } from '../composables/useProjectActions'
import Icon from '../components/Icon.vue'
import type { GodotProject, GodotVersion } from '../types/godot'

const emit = defineEmits<{ (e: 'navigate', tab: string): void, (e: 'create'): void }>()

const projects = ref<(GodotProject & { _id: string })[]>([])
const versions = ref<(GodotVersion & { _id: string })[]>([])
const settings = getSettings()

const defaultVersion = computed(() => versions.value.find((v) => v._id === settings.defaultVersionId))

const recentProjects = computed(() =>
  [...projects.value]
    .sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt))
    .slice(0, 5)
)

/** 收藏项目(最多展示 8 个,按最近打开排序) */
const favProjects = computed(() =>
  projects.value
    .filter((p) => p.favorite)
    .sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt))
    .slice(0, 8)
)

/** 按时段问候 */
const hour = new Date().getHours()
const greeting =
  hour < 5 ? '夜深了' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 19 ? '下午好' : '晚上好'

onMounted(() => {
  projects.value = listDocs<GodotProject>('godot/project/')
  versions.value = listDocs<GodotVersion>('godot/version/')
})

function chooseRoot() {
  const dir = pickDirectory('选择 Godot 引擎安装目录')
  if (dir) {
    saveSettings({ versionsRoot: dir })
    settings.versionsRoot = dir
  }
}

/** 项目名 → 头像渐变组 */
function gradOf(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return ['a', 'b', 'c', 'd'][h % 4]
}
</script>

<template>
  <div class="dash view">
    <!-- 问候横幅 -->
    <section class="hero">
      <div class="hero-text">
        <div class="greet">{{ greeting }},开发者</div>
        <div class="hero-sub">Godot 引擎 · 项目 · 插件,一站式工作台</div>
      </div>
      <div class="hero-root">
        <button class="root-chip" :class="{ unset: !settings.versionsRoot }" :title="settings.versionsRoot" @click="chooseRoot">
          <Icon name="folder" :size="13" />
          <span class="mono">{{
            settings.versionsRoot ?? '未设置引擎目录,点击选择'
          }}</span>
        </button>
        <button v-if="settings.versionsRoot" class="hero-btn" title="打开引擎目录" @click="showInFolder(settings.versionsRoot!)">
          <Icon name="external" :size="13" />
        </button>
      </div>
    </section>

    <!-- 统计 -->
    <section class="stats">
      <button class="stat" @click="emit('navigate', 'projects')">
        <span class="s-icon"><Icon name="folder" :size="17" /></span>
        <span class="s-body">
          <span class="s-num">{{ projects.length }}</span>
          <span class="s-label">项目</span>
        </span>
        <Icon name="chevron-right" :size="14" class="s-arrow" />
      </button>
      <button class="stat" @click="emit('navigate', 'versions')">
        <span class="s-icon"><Icon name="package" :size="17" /></span>
        <span class="s-body">
          <span class="s-num">{{ versions.length }}</span>
          <span class="s-label">已装引擎</span>
        </span>
        <Icon name="chevron-right" :size="14" class="s-arrow" />
      </button>
      <button class="stat wide" @click="emit('navigate', 'versions')">
        <span class="s-icon"><Icon name="play" :size="17" /></span>
        <span class="s-body">
          <span class="s-num small">{{ defaultVersion?.name ?? '未设置' }}</span>
          <span class="s-label">默认引擎</span>
        </span>
        <Icon name="chevron-right" :size="14" class="s-arrow" />
      </button>
    </section>

    <!-- 收藏项目 -->
    <section class="card block">
      <div class="block-head">
        <h3><Icon name="star" :size="14" class="fav-star" /> 收藏项目</h3>
        <button class="more" @click="emit('navigate', 'projects')">管理收藏 <Icon name="chevron-right" :size="12" /></button>
      </div>
      <template v-if="favProjects.length">
        <div
          v-for="p in favProjects"
          :key="p._id"
          class="recent-row"
          @click="openProjectAction(p)"
        >
          <div class="avatar" :class="`g-${gradOf(p.name)}`">{{ p.name.charAt(0).toUpperCase() }}</div>
          <div class="rr-main">
            <div class="rr-name">
              <span>{{ p.name }}</span>
              <span v-if="p.engineVersion" class="tag">{{ p.engineVersion }}</span>
            </div>
            <div class="rr-path mono" :title="p.path">{{ p.path }}</div>
          </div>
          <div class="fav-acts">
            <button class="fav-btn" title="在编辑器中打开" @click.stop="openProjectAction(p, 'editor')">
              <Icon name="pencil" :size="12" />
            </button>
            <button class="fav-btn" title="运行项目" @click.stop="openProjectAction(p, 'run')">
              <Icon name="play" :size="12" />
            </button>
          </div>
        </div>
      </template>
      <div v-else class="fav-empty">
        <Icon name="star" :size="14" />
        在「项目」页点亮星标,常用项目会固定在这里,一键打开编辑器或运行
      </div>
    </section>

    <!-- 最近项目 -->
    <section v-if="recentProjects.length" class="card block">
      <div class="block-head">
        <h3><Icon name="clock" :size="14" /> 最近项目</h3>
        <button class="more" @click="emit('navigate', 'projects')">全部项目 <Icon name="chevron-right" :size="12" /></button>
      </div>
      <div
        v-for="p in recentProjects"
        :key="p._id"
        class="recent-row"
        @click="openProjectAction(p)"
      >
        <div class="avatar" :class="`g-${gradOf(p.name)}`">{{ p.name.charAt(0).toUpperCase() }}</div>
        <div class="rr-main">
          <div class="rr-name">
            <span>{{ p.name }}</span>
            <span v-if="p.engineVersion" class="tag">{{ p.engineVersion }}</span>
          </div>
          <div class="rr-path mono" :title="p.path">{{ p.path }}</div>
        </div>
        <span class="rr-open"><Icon name="play" :size="12" /> 打开</span>
      </div>
    </section>

    <!-- 快捷操作 -->
    <section class="quick">
      <button class="quick-item card" @click="emit('navigate', 'versions')">
        <span class="qi-icon qi-a"><Icon name="download" :size="18" /></span>
        <span class="qi-text">
          <span class="qi-name">下载引擎</span>
          <span class="qi-desc">获取官方版本</span>
        </span>
      </button>
      <button class="quick-item card" @click="emit('create')">
        <span class="qi-icon qi-b"><Icon name="plus" :size="18" /></span>
        <span class="qi-text">
          <span class="qi-name">新建项目</span>
          <span class="qi-desc">从零创建</span>
        </span>
      </button>
      <button class="quick-item card" @click="emit('navigate', 'projects')">
        <span class="qi-icon qi-c"><Icon name="folder-plus" :size="18" /></span>
        <span class="qi-text">
          <span class="qi-name">添加项目</span>
          <span class="qi-desc">导入已有目录</span>
        </span>
      </button>
      <button class="quick-item card" @click="emit('navigate', 'marketplace')">
        <span class="qi-icon qi-d"><Icon name="puzzle" :size="18" /></span>
        <span class="qi-text">
          <span class="qi-name">插件市场</span>
          <span class="qi-desc">官方资产商店</span>
        </span>
      </button>
    </section>

    <!-- 新手引导 -->
    <section v-if="!versions.length" class="card block guide">
      <div class="block-head">
        <h3><Icon name="zap" :size="14" /> 快速上手</h3>
      </div>
      <ol class="steps">
        <li>在「版本」页下载一个 Godot 引擎,或导入本地的 Godot 可执行文件</li>
        <li>将 Godot 项目文件夹拖入 ZTools,快速添加并绑定引擎版本</li>
        <li>在主输入框输入「gp」,输入项目名回车即可打开项目</li>
      </ol>
    </section>
  </div>
</template>

<style scoped>
/* ---- 问候横幅 ---- */
.hero {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
  border-radius: var(--radius-lg);
  background: var(--brand-grad);
  color: #fff;
  box-shadow: var(--shadow);
  overflow: hidden;
}

/* 网格纹理 */
.hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.07) 0 1px, transparent 1px 22px),
    repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.07) 0 1px, transparent 1px 22px);
  pointer-events: none;
}

.hero-text {
  position: relative;
  flex-shrink: 0;
}

.greet {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.hero-sub {
  margin-top: 2px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.78);
}

.hero-root {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  min-width: 0;
}

.root-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 340px;
  padding: 5px 12px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
  white-space: nowrap;
}

.root-chip:hover {
  background: rgba(255, 255, 255, 0.24);
}

.root-chip span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.root-chip.unset {
  font-style: normal;
  border-style: dashed;
}

.hero-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;
}

.hero-btn:hover {
  background: rgba(255, 255, 255, 0.24);
}

/* ---- 统计 ---- */
.stats {
  display: grid;
  grid-template-columns: 1fr 1fr 1.5fr;
  gap: 10px;
}

.stat {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}

.stat:hover {
  border-color: var(--brand);
  box-shadow: var(--shadow-lift);
  transform: translateY(-1px);
}

.s-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  background: var(--brand-weak);
  color: var(--brand);
  flex-shrink: 0;
}

.s-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.s-num {
  font-size: 21px;
  font-weight: 700;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}

.s-num.small {
  font-size: 15px;
  padding-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.s-label {
  font-size: 11.5px;
  color: var(--text-3);
}

.s-arrow {
  margin-left: auto;
  color: var(--text-3);
  flex-shrink: 0;
}

.stat:hover .s-arrow {
  color: var(--brand);
}

/* ---- 通用块 ---- */
.block {
  padding: 4px 6px 6px;
}

.block-head {
  display: flex;
  align-items: center;
  padding: 10px 12px 6px;
}

.block-head h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}

.block-head h3 .icon {
  color: var(--brand);
}

.more {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  border: none;
  background: none;
  color: var(--brand);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
}

.more:hover {
  background: var(--brand-weak);
}

/* ---- 最近项目行 ---- */
.recent-row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.12s;
}

.recent-row:hover {
  background: var(--surface-2);
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  letter-spacing: 0;
}

.avatar.g-a { background: var(--grad-a); }
.avatar.g-b { background: var(--grad-b); }
.avatar.g-c { background: var(--grad-c); }
.avatar.g-d { background: var(--grad-d); }

.rr-main {
  flex: 1;
  min-width: 0;
}

.rr-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}

.rr-path {
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rr-open {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--brand);
  opacity: 0;
  transition: opacity 0.15s;
  flex-shrink: 0;
}

.recent-row:hover .rr-open {
  opacity: 1;
}

/* ---- 收藏项目区 ---- */
.fav-star {
  color: var(--warn, #e8a33d);
}

.fav-acts {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.fav-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}

.fav-btn:hover {
  border-color: var(--brand);
  color: var(--brand);
  background: var(--brand-weak);
}

.fav-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 12px 12px;
  padding: 10px 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text-3);
}

.fav-empty .icon {
  color: var(--warn, #e8a33d);
  flex-shrink: 0;
}

/* ---- 快捷操作 ---- */
.quick {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.quick-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 15px;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}

.quick-item:hover {
  border-color: var(--brand);
  box-shadow: var(--shadow-lift);
  transform: translateY(-1px);
}

.qi-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.qi-a { background: var(--brand-weak); color: var(--brand); }
.qi-b { background: var(--grad-b); color: #fff; }
.qi-c { background: var(--grad-c); color: #fff; }
.qi-d { background: var(--grad-d); color: #fff; }

.qi-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.qi-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}

.qi-desc {
  font-size: 12px;
  color: var(--text-3);
}

/* ---- 引导 ---- */
.steps {
  margin: 0;
  padding: 2px 14px 12px 36px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--text-2);
}
</style>
