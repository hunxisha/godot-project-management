<script setup lang="ts">
import { reactive } from 'vue'
import { getSettings, openPath, pickDirectory, saveSettings } from '../services/bridge'
import type { OpenAction } from '../types/godot'

const state = reactive({ ...getSettings() })

function patchNow() {
  saveSettings({ ...state })
}

function chooseRoot() {
  const dir = pickDirectory('选择 Godot 引擎安装目录', state.versionsRoot)
  if (dir) {
    state.versionsRoot = dir
    patchNow()
  }
}

const openActions: { value: OpenAction, label: string }[] = [
  { value: 'editor', label: '在编辑器中打开' },
  { value: 'run', label: '运行项目' },
  { value: 'folder', label: '打开项目目录' }
]
</script>

<template>
  <div class="settings">
    <div class="card section">
      <div class="section-title">引擎安装目录</div>
      <div class="row">
        <span class="mono value" :class="{ unset: !state.versionsRoot }">
          {{ state.versionsRoot ?? '未设置(首次下载版本时选择)' }}
        </span>
        <div class="gap"></div>
        <button class="btn small" @click="chooseRoot">选择目录</button>
        <button v-if="state.versionsRoot" class="btn small" @click="openPath(state.versionsRoot!)">打开</button>
      </div>
      <div class="hint">通过本插件下载的 Godot 引擎将安装在独立子目录中,互不干扰,卸载即删。</div>
    </div>

    <div class="card section">
      <div class="section-title">打开项目的默认动作</div>
      <div class="row">
        <select v-model="state.defaultOpenAction" class="select" @change="patchNow">
          <option v-for="a in openActions" :key="a.value" :value="a.value">{{ a.label }}</option>
        </select>
      </div>
    </div>

    <div class="card section">
      <div class="section-title">插件安装</div>
      <label class="check">
        <input v-model="state.autoEnablePlugin" type="checkbox" @change="patchNow" />
        <span>安装插件后自动在 project.godot 中启用</span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  max-width: 640px;
}

.section {
  padding: 14px 16px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 10px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gap {
  flex: 1;
}

.value {
  flex: 1;
  min-width: 0;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.value.unset {
  color: var(--text-3);
}

.hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-3);
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
}
</style>
