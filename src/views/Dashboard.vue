<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getSettings, listDocs, pickDirectory, saveSettings, showInFolder } from '../services/bridge'
import { openProjectAction } from '../composables/useProjectActions'
import { gradOf } from '../utils/avatar'
import Icon from '../components/Icon.vue'
import { DEFAULT_SETTINGS, type GodotProject, type GodotSettings, type GodotVersion } from '../types/godot'

const emit = defineEmits<{ (e: 'navigate', tab: string): void, (e: 'create'): void }>()

const projects = ref<(GodotProject & { _id: string })[]>([])
const versions = ref<(GodotVersion & { _id: string })[]>([])
// 设置异步读取(阶段 A):先给默认值保证首屏可用,onMounted 后补齐
const settings = ref<GodotSettings>({ ...DEFAULT_SETTINGS })

const defaultVersion = computed(() => versions.value.find((v) => v._id === settings.value.defaultVersionId))

const recentProjects = computed(() =>
  [...projects.value]
    .sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt))
    .slice(0, 6)
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

const today = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())

onMounted(async () => {
  projects.value = await listDocs<GodotProject>('godot/project/')
  versions.value = await listDocs<GodotVersion>('godot/version/')
  settings.value = await getSettings()
})

async function chooseRoot() {
  const dir = await pickDirectory('选择 Godot 引擎安装目录')
  if (dir) {
    settings.value = await saveSettings({ versionsRoot: dir })
  }
}
</script>

<template>
  <div class="dash view">
    <!-- 问候 + 引擎目录 -->
    <section class="hero panel">
      <div class="hero-main">
        <div class="greet">{{ greeting }},开发者</div>
        <div class="hero-sub">今天是 {{ today }} —— 引擎、项目与插件的一站式工作台。</div>
      </div>
      <div class="hero-side">
        <button class="stat-chip" title="项目总数,点击管理" @click="emit('navigate', 'projects')">
          <Icon name="folder" :size="13" />
          <span class="sc-num">{{ projects.length }}</span>
          <span class="sc-label">项目</span>
        </button>
        <button class="stat-chip" title="已装引擎数,点击管理" @click="emit('navigate', 'versions')">
          <Icon name="package" :size="13" />
          <span class="sc-num">{{ versions.length }}</span>
          <span class="sc-label">引擎</span>
        </button>
        <button
          class="stat-chip"
          :class="{ unset: !defaultVersion }"
          :title="defaultVersion ? `默认引擎 ${defaultVersion.name}` : '未设置默认引擎,点击前往设置'"
          @click="emit('navigate', 'versions')"
        >
          <Icon name="play" :size="13" />
          <span class="sc-text">{{ defaultVersion?.name ?? '未设置' }}</span>
          <span class="sc-label">默认</span>
        </button>
      </div>
      <div class="hero-root">
        <button class="root-chip" :class="{ unset: !settings.versionsRoot }" :title="settings.versionsRoot" @click="chooseRoot">
          <Icon name="folder" :size="13" />
          <span class="mono">{{ settings.versionsRoot ?? '设置引擎目录' }}</span>
        </button>
        <button v-if="settings.versionsRoot" class="hero-btn" title="打开引擎目录" @click="showInFolder(settings.versionsRoot!)">
          <Icon name="external" :size="13" />
        </button>
      </div>
    </section>

    <!-- 快捷操作 -->
    <section class="quick">
      <button class="quick-item panel" @click="emit('navigate', 'versions')">
        <span class="qi-icon qi-a"><Icon name="download" :size="17" /></span>
        <span class="qi-text">
          <span class="qi-name">下载引擎</span>
          <span class="qi-desc">获取官方版本</span>
        </span>
        <Icon name="chevron-right" :size="14" class="qi-arrow" />
      </button>
      <button class="quick-item panel" @click="emit('create')">
        <span class="qi-icon qi-b"><Icon name="plus" :size="17" /></span>
        <span class="qi-text">
          <span class="qi-name">新建项目</span>
          <span class="qi-desc">从零创建</span>
        </span>
        <Icon name="chevron-right" :size="14" class="qi-arrow" />
      </button>
      <button class="quick-item panel" @click="emit('navigate', 'projects')">
        <span class="qi-icon qi-c"><Icon name="folder-plus" :size="17" /></span>
        <span class="qi-text">
          <span class="qi-name">添加项目</span>
          <span class="qi-desc">导入已有目录</span>
        </span>
        <Icon name="chevron-right" :size="14" class="qi-arrow" />
      </button>
      <button class="quick-item panel" @click="emit('navigate', 'marketplace')">
        <span class="qi-icon qi-d"><Icon name="puzzle" :size="17" /></span>
        <span class="qi-text">
          <span class="qi-name">插件市场</span>
          <span class="qi-desc">官方资产商店</span>
        </span>
        <Icon name="chevron-right" :size="14" class="qi-arrow" />
      </button>
    </section>

    <!-- 收藏 + 最近 -->
    <section class="cols">
      <div class="panel block">
        <div class="panel-head">
          <span class="panel-title"><Icon name="star" :size="13" class="fav-star" /> 收藏项目</span>
          <span class="grow"></span>
          <button class="more" @click="emit('navigate', 'projects')">管理 <Icon name="chevron-right" :size="11" /></button>
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
      </div>

      <div v-if="recentProjects.length" class="panel block">
        <div class="panel-head">
          <span class="panel-title"><Icon name="clock" :size="13" /> 最近项目</span>
          <span class="grow"></span>
          <button class="more" @click="emit('navigate', 'projects')">全部 <Icon name="chevron-right" :size="11" /></button>
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
      </div>
    </section>

    <!-- 新手引导 -->
    <section v-if="!versions.length" class="panel block guide">
      <div class="panel-head">
        <span class="panel-title"><Icon name="zap" :size="13" /> 快速上手</span>
      </div>
      <ol class="steps">
        <li>在「引擎」页下载一个 Godot 引擎,或导入本地的 Godot 可执行文件</li>
        <li>将 Godot 项目文件夹拖入 ZTools,快速添加并绑定引擎版本</li>
        <li>按 <span class="kbd">Ctrl K</span> 呼出命令面板,输入项目名回车即可打开项目</li>
      </ol>
    </section>
  </div>
</template>

<style scoped>
/* ---- 问候区:面板化,品牌色左侧指示条 ---- */
.hero {
  position: relative;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px 18px;
  padding: 18px 20px;
  background:
    linear-gradient(var(--surface), var(--surface)) padding-box,
    var(--brand-grad) border-box;
  overflow: hidden;
}

/* 细网格纹理:Godot 编辑器视口质感 */
.hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    repeating-linear-gradient(0deg, var(--brand-weak) 0 1px, transparent 1px 26px),
    repeating-linear-gradient(90deg, var(--brand-weak) 0 1px, transparent 1px 26px);
  opacity: 0.5;
  pointer-events: none;
}

.hero > * {
  position: relative;
}

.hero-main {
  flex-shrink: 0;
  min-width: 220px;
}

.greet {
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: var(--text);
}

.hero-sub {
  margin-top: 3px;
  font-size: 12.5px;
  color: var(--text-3);
}

/* 统计胶囊 */
.hero-side {
  display: flex;
  align-items: center;
  gap: 8px;
}

.stat-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, box-shadow 0.15s;
  white-space: nowrap;
}

.stat-chip:hover {
  border-color: var(--brand);
  color: var(--brand);
  box-shadow: var(--shadow-sm);
}

.stat-chip .icon {
  color: var(--brand);
}

.sc-num {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.sc-text {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
  color: var(--text);
}

.stat-chip.unset .sc-text {
  color: var(--text-3);
  font-weight: 500;
}

.sc-label {
  color: var(--text-3);
}

/* 引擎目录 */
.hero-root {
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
  max-width: 320px;
  padding: 5px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
  white-space: nowrap;
}

.root-chip:hover {
  border-color: var(--brand);
  color: var(--brand);
  border-style: solid;
}

.root-chip span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.root-chip.unset {
  color: var(--text-3);
}

.hero-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  flex-shrink: 0;
}

.hero-btn:hover {
  color: var(--brand);
  border-color: var(--brand);
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
  box-shadow: var(--shadow);
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
  flex: 1;
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

.qi-arrow {
  color: var(--text-3);
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}

.quick-item:hover .qi-arrow {
  opacity: 1;
  color: var(--brand);
}

/* ---- 双列面板 ---- */
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: start;
}

@media (max-width: 1080px) {
  .cols {
    grid-template-columns: 1fr;
  }
}

.block :deep(.panel-head) {
  padding: 8px 12px;
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
  padding: 2px 6px;
  border-radius: 5px;
}

.more:hover {
  background: var(--brand-weak);
}

/* ---- 项目行 ---- */
.recent-row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 7px 12px;
  cursor: pointer;
  transition: background 0.12s;
}

.recent-row + .recent-row {
  border-top: 1px solid var(--surface-2);
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

.rr-name .tag {
  line-height: 17px;
  font-size: 10.5px;
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

/* ---- 收藏区 ---- */
.fav-star {
  color: var(--gold, #e8a33d);
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
  margin: 6px 12px 12px;
  padding: 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-3);
}

.fav-empty .icon {
  color: var(--gold, #e8a33d);
  flex-shrink: 0;
}

/* ---- 引导 ---- */
.steps {
  margin: 0;
  padding: 4px 14px 14px 38px;
  font-size: 13px;
  line-height: 2;
  color: var(--text-2);
}

.steps .kbd {
  margin: 0 2px;
}

@media (max-width: 920px) {
  .quick {
    grid-template-columns: repeat(2, 1fr);
  }

  .hero-root {
    margin-left: 0;
  }
}
</style>
