<script setup lang="ts">
import { reactive, ref } from 'vue'
import { getSettings, notify, openPath, pickDirectory, saveSettings } from '../services/bridge'
import type { OpenAction } from '../types/godot'

const state = reactive({ ...getSettings() })
const apiKeyInput = ref('')
const verifying = ref(false)

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

/** 验证并保存 Asset Store API Key */
async function saveApiKey() {
  const key = apiKeyInput.value.trim()
  if (!key || verifying.value) return
  verifying.value = true
  try {
    const r = await window.services.verifyApiKey(key)
    if (r.authenticated) {
      state.apiKey = key
      state.storeAccount = r.name || '已认证用户'
      patchNow()
      apiKeyInput.value = ''
      notify(`已连接 Asset Store:${r.name || '已认证用户'}`)
    }
  } catch (e: any) {
    notify(e?.message || '验证失败,请检查 API Key')
  } finally {
    verifying.value = false
  }
}

/** 退出登录(仅清除本地记录,不撤销网站上的 Key) */
function logoutStore() {
  delete state.apiKey
  delete state.storeAccount
  patchNow()
}

function openStoreSite() {
  window.ztools.shellOpenExternal('https://store.godotengine.org/settings/#tab-api')
}
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
      <div class="section-title">网络代理</div>
      <div class="row">
        <input
          v-model.trim="state.proxy"
          class="input value"
          placeholder="如 http://127.0.0.1:7890,留空直连"
          spellcheck="false"
          @change="patchNow"
        />
      </div>
      <div class="hint">所有网络请求(版本列表、引擎下载、插件市场)将经由该 HTTP 代理发送,保存后立即生效;仅支持 HTTP 代理。</div>
    </div>

    <div class="card section">
      <div class="section-title">Asset Store 账号</div>
      <template v-if="state.storeAccount">
        <div class="row">
          <span class="value">已连接:{{ state.storeAccount }}</span>
          <div class="gap"></div>
          <button class="btn small danger-text" @click="logoutStore">退出登录</button>
        </div>
      </template>
      <template v-else>
        <div class="row">
          <input
            v-model="apiKeyInput"
            class="input value"
            type="password"
            placeholder="粘贴 Asset Store API Key"
            spellcheck="false"
            @keyup.enter="saveApiKey"
          />
          <button class="btn small primary" :disabled="verifying || !apiKeyInput.trim()" @click="saveApiKey">
            {{ verifying ? '验证中…' : '连接' }}
          </button>
        </div>
      </template>
      <div class="hint">
        在 <span class="link" @click="openStoreSite">store.godotengine.org 的 API 密钥页面</span> 登录并生成 Key 后粘贴到此处;退出登录不会撤销网站上的 Key。
      </div>
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

.link {
  color: var(--brand);
  cursor: pointer;
}
</style>
