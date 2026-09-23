<script setup lang="ts">
import { reactive, ref } from 'vue'
import { getSettings, notify, openPath, pickDirectory, saveSettings } from '../services/bridge'
import Icon from '../components/Icon.vue'
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

function chooseBackupRoot() {
  const dir = pickDirectory('选择项目备份目录', state.backupRoot)
  if (dir) {
    state.backupRoot = dir
    patchNow()
  }
}

const openActions: { value: OpenAction, label: string, icon: string }[] = [
  { value: 'editor', label: '在编辑器中打开', icon: 'pencil' },
  { value: 'run', label: '运行项目', icon: 'play' },
  { value: 'folder', label: '打开项目目录', icon: 'folder' }
]

const deleteModes: { value: 'ask' | 'always' | 'never', label: string }[] = [
  { value: 'ask', label: '每次询问' },
  { value: 'always', label: '默认同时删除' },
  { value: 'never', label: '仅移除记录' }
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
  <div class="settings view">
    <div class="view-head">
      <h2><Icon name="gear" :size="16" /> 设置</h2>
    </div>

    <div class="card section">
      <div class="sec-head">
        <span class="sec-ico"><Icon name="folder" :size="15" /></span>
        <span class="sec-title">引擎安装目录</span>
      </div>
      <div class="sec-body">
        <div class="root-row">
          <span class="mono root-value" :class="{ unset: !state.versionsRoot }">
            {{ state.versionsRoot ?? '未设置(首次下载版本时选择)' }}
          </span>
          <div class="grow"></div>
          <button class="btn small" @click="chooseRoot">选择目录</button>
          <button v-if="state.versionsRoot" class="btn small ghost" title="打开目录" @click="openPath(state.versionsRoot!)">
            <Icon name="external" :size="13" />
          </button>
        </div>
      </div>
      <div class="hint">通过本插件下载的 Godot 引擎将安装在独立子目录中,互不干扰,卸载即删。</div>
    </div>

    <div class="card section">
      <div class="sec-head">
        <span class="sec-ico"><Icon name="globe" :size="15" /></span>
        <span class="sec-title">网络代理</span>
      </div>
      <div class="sec-body">
        <input
          v-model.trim="state.proxy"
          class="input"
          placeholder="如 http://127.0.0.1:7890,留空直连"
          spellcheck="false"
          @change="patchNow"
        />
      </div>
      <div class="hint">所有网络请求(版本列表、引擎下载、插件市场)将经由该 HTTP 代理发送,保存后立即生效;仅支持 HTTP 代理。</div>
    </div>

    <div class="card section">
      <div class="sec-head">
        <span class="sec-ico"><Icon name="key" :size="15" /></span>
        <span class="sec-title">Asset Store 账号</span>
        <span v-if="state.storeAccount" class="tag ok">已连接</span>
      </div>
      <div class="sec-body">
        <template v-if="state.storeAccount">
          <div class="root-row">
            <span class="account-avatar">{{ state.storeAccount.charAt(0).toUpperCase() }}</span>
            <span class="account-name">{{ state.storeAccount }}</span>
            <div class="grow"></div>
            <button class="btn small danger-text" @click="logoutStore">退出登录</button>
          </div>
        </template>
        <template v-else>
          <div class="root-row">
            <input
              v-model="apiKeyInput"
              class="input"
              type="password"
              placeholder="粘贴 Asset Store API Key"
              spellcheck="false"
              @keyup.enter="saveApiKey"
            />
            <button class="btn small primary" :disabled="verifying || !apiKeyInput.trim()" @click="saveApiKey">
              <span v-if="verifying" class="spin"></span>
              {{ verifying ? '验证中…' : '连接' }}
            </button>
          </div>
        </template>
      </div>
      <div class="hint">
        在 <span class="link" @click="openStoreSite">store.godotengine.org 的 API 密钥页面</span> 登录并生成 Key 后粘贴到此处;退出登录不会撤销网站上的 Key。
      </div>
    </div>

    <div class="card section">
      <div class="sec-head">
        <span class="sec-ico"><Icon name="play" :size="15" /></span>
        <span class="sec-title">打开项目的默认动作</span>
      </div>
      <div class="sec-body">
        <div class="seg">
          <button
            v-for="a in openActions"
            :key="a.value"
            :class="{ on: state.defaultOpenAction === a.value }"
            @click="state.defaultOpenAction = a.value; patchNow()"
          >
            <Icon :name="a.icon" :size="12" /> {{ a.label }}
          </button>
        </div>
      </div>
    </div>

    <div class="card section">
      <div class="sec-head">
        <span class="sec-ico"><Icon name="box" :size="15" /></span>
        <span class="sec-title">项目备份目录</span>
      </div>
      <div class="sec-body">
        <div class="root-row">
          <span class="mono root-value" :class="{ unset: !state.backupRoot }">
            {{ state.backupRoot ?? '未设置(每次备份时选择)' }}
          </span>
          <div class="grow"></div>
          <button class="btn small" @click="chooseBackupRoot">选择目录</button>
          <button
            v-if="state.backupRoot"
            class="btn small ghost"
            title="打开目录"
            @click="openPath(state.backupRoot!)"
          ><Icon name="external" :size="12" /></button>
        </div>
      </div>
      <div class="hint">备份项目时默认保存到该目录;备份弹窗中可临时改选其他位置。</div>
    </div>

    <div class="card section">
      <div class="sec-head">
        <span class="sec-ico"><Icon name="trash" :size="15" /></span>
        <span class="sec-title">删除项目时</span>
      </div>
      <div class="sec-body">
        <div class="seg">
          <button
            v-for="m in deleteModes"
            :key="m.value"
            :class="{ on: state.deleteProjectFiles === m.value }"
            @click="state.deleteProjectFiles = m.value; patchNow()"
          >
            {{ m.label }}
          </button>
        </div>
      </div>
      <div class="hint">
        「每次询问」在删除弹窗中自由勾选;「默认同时删除」弹窗默认勾上删除文件;「仅移除记录」不再提供删除文件选项。Windows 下删除的项目文件夹会移入回收站,可恢复。
      </div>
    </div>

    <div class="card section">
      <div class="sec-head">
        <span class="sec-ico"><Icon name="puzzle" :size="15" /></span>
        <span class="sec-title">插件安装</span>
      </div>
      <div class="sec-body">
        <label class="switch-row">
          <div class="switch-text">
            <span class="switch-label">自动启用插件</span>
            <span class="switch-desc">安装插件后自动在 project.godot 中启用</span>
          </div>
          <input v-model="state.autoEnablePlugin" type="checkbox" class="switch" @change="patchNow" />
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grow {
  flex: 1;
}

.settings {
  max-width: 680px;
}

.section {
  padding: 15px 18px;
}

.sec-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 12px;
}

.sec-ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: var(--brand-weak);
  color: var(--brand);
  flex-shrink: 0;
}

.sec-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}

.sec-body {
  min-height: 32px;
}

.root-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.root-value {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.root-value.unset {
  color: var(--text-3);
  font-family: inherit;
}

.root-row .input {
  flex: 1;
  min-width: 0;
}

.hint {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}

.link {
  color: var(--brand);
  cursor: pointer;
}

.link:hover {
  text-decoration: underline;
}

.account-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--grad-a);
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  flex-shrink: 0;
}

.account-name {
  font-weight: 600;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 开关行 */
.switch-row {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
}

.switch-text {
  display: flex;
  flex-direction: column;
}

.switch-label {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}

.switch-desc {
  font-size: 12px;
  color: var(--text-3);
}

.switch-row .switch {
  margin-left: auto;
}
</style>
