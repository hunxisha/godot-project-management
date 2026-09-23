<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getSettings, listDocs, pickDirectory, saveSettings, showInFolder } from '../services/bridge'
import { openProjectAction } from '../composables/useProjectActions'
import type { GodotProject, GodotVersion } from '../types/godot'

const emit = defineEmits<{ (e: 'navigate', tab: string): void }>()

const projects = ref<(GodotProject & { _id: string })[]>([])
const versions = ref<(GodotVersion & { _id: string })[]>([])
const settings = getSettings()

const defaultVersion = computed(() => versions.value.find((v) => v._id === settings.defaultVersionId))

const recentProjects = computed(() =>
  [...projects.value]
    .sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt))
    .slice(0, 5)
)

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
</script>

<template>
  <div class="dashboard">
    <div class="stats">
      <div class="card stat" @click="emit('navigate', 'projects')">
        <div class="num">{{ projects.length }}</div>
        <div class="label">项目</div>
      </div>
      <div class="card stat" @click="emit('navigate', 'versions')">
        <div class="num">{{ versions.length }}</div>
        <div class="label">已装引擎</div>
      </div>
      <div class="card stat">
        <div class="num small">{{ defaultVersion?.name ?? '未设置' }}</div>
        <div class="label">默认引擎</div>
      </div>
    </div>

    <div v-if="recentProjects.length" class="card recent">
      <div class="section-title">最近项目</div>
      <div
        v-for="p in recentProjects"
        :key="p._id"
        class="recent-row"
        @click="openProjectAction(p)"
      >
        <div class="avatar" :class="{ fav: p.favorite }">{{ p.name.charAt(0).toUpperCase() }}</div>
        <div class="rr-main">
          <div class="rr-name">
            <span>{{ p.name }}</span>
            <span v-if="p.engineVersion" class="tag">{{ p.engineVersion }}</span>
          </div>
          <div class="rr-path mono" :title="p.path">{{ p.path }}</div>
        </div>
        <span class="rr-open">打开</span>
      </div>
      <button class="btn small more" @click="emit('navigate', 'projects')">查看全部项目</button>
    </div>

    <div class="quick card">
      <div class="quick-title">快捷操作</div>
      <div class="quick-grid">
        <button class="quick-item" @click="emit('navigate', 'versions')">
          <span class="qi-name">下载引擎</span>
          <span class="qi-desc">获取 Godot 官方版本</span>
        </button>
        <button class="quick-item" @click="emit('navigate', 'projects')">
          <span class="qi-name">添加项目</span>
          <span class="qi-desc">拖入项目文件夹即可</span>
        </button>
        <button class="quick-item" @click="emit('navigate', 'marketplace')">
          <span class="qi-name">插件市场</span>
          <span class="qi-desc">浏览 Godot Asset Library</span>
        </button>
      </div>
    </div>

    <div v-if="!versions.length" class="card guide">
      <div class="guide-title">开始使用</div>
      <ol class="steps">
        <li>在「版本」页下载一个 Godot 引擎,或导入本地的 Godot 可执行文件</li>
        <li>将 Godot 项目文件夹拖入 ZTools,快速添加并绑定引擎版本</li>
        <li>在主输入框输入「gp」,输入项目名回车即可打开项目</li>
      </ol>
      <div class="root-row">
        <span class="root-label">引擎安装目录:</span>
        <span class="mono" :class="{ unset: !settings.versionsRoot }">
          {{ settings.versionsRoot ?? '未设置(首次下载时选择)' }}
        </span>
        <button class="btn small" @click="chooseRoot">选择</button>
        <button v-if="settings.versionsRoot" class="btn small" @click="showInFolder(settings.versionsRoot!)">打开</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.stats {
  display: grid;
  grid-template-columns: 1fr 1fr 1.6fr;
  gap: 12px;
}

.stat {
  padding: 14px 16px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.stat:hover {
  border-color: var(--brand);
}

.num {
  font-size: 26px;
  font-weight: 700;
  color: var(--brand);
  line-height: 1.2;
}

.num.small {
  font-size: 17px;
  padding-top: 5px;
}

.label {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-3);
}

.recent {
  padding: 12px 16px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 8px;
}

.recent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.recent-row:hover {
  background: var(--surface-2);
}

.avatar {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  background: var(--brand-weak);
  color: var(--brand);
  font-weight: 700;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.avatar.fav {
  background: var(--warn-weak);
  color: var(--warn);
}

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
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rr-open {
  font-size: 12px;
  color: var(--brand);
  flex-shrink: 0;
}

.more {
  margin-top: 6px;
}

.quick {
  padding: 14px 16px;
}

.quick-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 10px;
}

.quick-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.quick-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s;
}

.quick-item:hover {
  border-color: var(--brand);
}

.qi-name {
  font-size: 14px;
  font-weight: 600;
}

.qi-desc {
  font-size: 12px;
  color: var(--text-3);
}

.guide {
  padding: 14px 16px;
}

.guide-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 6px;
}

.steps {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  color: var(--text-2);
}

.steps li {
  margin: 4px 0;
}

.root-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 13px;
}

.root-label {
  color: var(--text-3);
}

.root-row .mono {
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.root-row .mono.unset {
  color: var(--text-3);
}
</style>
