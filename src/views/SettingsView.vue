<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { getSettings, notify, openPath, pickDirectory, pickFile, saveSettings } from '../services/bridge'
import Icon from '../components/Icon.vue'
import ThemeSwitcher from '../components/ThemeSwitcher.vue'
import CodeThemeSwitcher from '../components/CodeThemeSwitcher.vue'
import TranslatePanel from '../components/settings/TranslatePanel.vue'
import { fmtSize } from '../utils/format'
import { DEFAULT_SETTINGS, type DocsCacheInfo, type GodotSettings, type NetworkCheckResult, type OpenAction } from '../types/godot'

// 设置异步读取:先给默认值,onMounted 后用持久化值覆盖
const state = reactive<GodotSettings>({ ...DEFAULT_SETTINGS })
getSettings().then((s) => Object.assign(state, s)).catch(() => {})
const apiKeyInput = ref('')
const verifying = ref(false)

async function patchNow() {
  try {
    await saveSettings({ ...state })
  } catch (e: any) {
    // 静默失败是这类 bug 最难查的形态:写不进去就说出来,别等用户关掉页面再发现没了
    notify(`设置保存失败:${e?.message || e}`)
  }
}

async function chooseRoot() {
  const dir = await pickDirectory('选择 Godot 引擎安装目录', state.versionsRoot)
  if (dir) {
    state.versionsRoot = dir
    await patchNow()
  }
}

async function chooseBackupRoot() {
  const dir = await pickDirectory('选择项目备份目录', state.backupRoot)
  if (dir) {
    state.backupRoot = dir
    await patchNow()
  }
}

// ---------- 数据迁移 / 文档库缓存 / 网络诊断 ----------

const dtBusy = ref(false)

async function exportData() {
  if (dtBusy.value) return
  const dir = await pickDirectory('选择导出位置')
  if (!dir) return
  dtBusy.value = true
  try {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const r = await window.services.exportPluginData(`${dir}\\ztools-godot-data-${stamp}.json`.replace(/\//g, '\\'))
    if (r.ok) notify(`已导出:${r.projects} 个项目、${r.favorites} 条收藏(设置已包含)`)
    else notify(r.error || '导出失败')
  } finally {
    dtBusy.value = false
  }
}

async function importData() {
  if (dtBusy.value) return
  const file = await pickFile('选择要导入的数据文件', ['json'])
  if (!file) return
  dtBusy.value = true
  try {
    const r = await window.services.importPluginData(file)
    if (r.ok) {
      const parts = [`项目新增 ${r.projectsAdded} 个`]
      if (r.projectsOffline) parts.push(`本机不存在 ${r.projectsOffline} 个(已跳过)`)
      if (r.projectsSkipped) parts.push(`无效 ${r.projectsSkipped} 个`)
      parts.push(`收藏新增 ${r.favoritesAdded} 条`, `设置补齐 ${r.settingsAdopted} 项`)
      notify(`导入完成:${parts.join(', ')}`)
      Object.assign(state, await getSettings())
    } else {
      notify(r.error || '导入失败')
    }
  } finally {
    dtBusy.value = false
  }
}

// ---------- 文档库缓存 ----------

const docsCache = ref<DocsCacheInfo | null>(null)

async function refreshDocsCache() {
  docsCache.value = await window.services.docsCacheInfo()
}
refreshDocsCache()

async function cleanDocsCache(versionIds?: string[]) {
  const r = await window.services.docsCleanCache(versionIds)
  if (r.ok) {
    notify(`已清理 ${r.removed ?? 0} 个文档库(收藏与浏览历史保留)`)
    await refreshDocsCache()
  } else {
    // 没有这一句,宿主回 ok:false 时点「清理缓存」就是按钮转一下什么都不发生
    notify(r.error || '清理失败')
  }
}

const netChecking = ref(false)
const netResults = ref<NetworkCheckResult[]>([])

async function runDiagnostics() {
  if (netChecking.value) return
  netChecking.value = true
  netResults.value = []
  try {
    const r = await window.services.runNetworkDiagnostics()
    netResults.value = r.results || []
  } catch (e: any) {
    notify(e?.message || '诊断失败')
  } finally {
    netChecking.value = false
  }
}

// ---------- 备份默认项 ----------

/** build/ 与 export/ 视作一组,勾选任一项即代表这组 */
const BUILD_GROUP = ['build', 'export']

function hasExclude(name: string) {
  const list = state.backupExclude || []
  if (name === 'build') return BUILD_GROUP.some((n) => list.includes(n))
  return list.includes(name)
}

function toggleExclude(name: string, on: boolean) {
  const set = new Set(state.backupExclude || [])
  for (const n of name === 'build' ? BUILD_GROUP : [name]) {
    if (on) set.add(n)
    else set.delete(n)
  }
  state.backupExclude = [...set]
  patchNow()
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
    } else {
      // 少了这一句就是「按钮转一下,什么都不发生」:宿主校验不过时回的是
      // {authenticated:false,error},而这里过去只有成功分支。密钥错也走同一句话。
      notify(r.error || '验证失败,请检查 API Key')
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

// ---------- 设置分组锚点导航(左栏 + scrollspy) ----------

const groups = [
  { id: 'general', label: '通用', icon: 'grid' },
  { id: 'engine', label: '引擎与网络', icon: 'globe' },
  { id: 'translate', label: '翻译', icon: 'sparkle' },
  { id: 'backup', label: '备份', icon: 'archive' },
  { id: 'data', label: '数据', icon: 'hard-drive' }
] as const

type GroupId = (typeof groups)[number]['id']
const activeGroup = ref<GroupId>('general')
const flowEl = ref<HTMLElement | null>(null)
let spyRoot: HTMLElement | null = null

/** 左栏点击 → 对应分组滚到视口顶部 */
function scrollToGroup(id: GroupId) {
  document.getElementById('grp-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** scrollspy:取「上缘已越过阈值」的最后一个分组 */
function spyHandler() {
  let current: GroupId = groups[0].id
  for (const g of groups) {
    const el = document.getElementById('grp-' + g.id)
    if (el && el.getBoundingClientRect().top <= 150) current = g.id
  }
  activeGroup.value = current
}

onMounted(() => {
  // 滚动容器是 App.vue 的 .content(页面级滚动)
  spyRoot = flowEl.value?.closest('.content') ?? null
  spyRoot?.addEventListener('scroll', spyHandler, { passive: true })
  spyHandler()
})

onBeforeUnmount(() => {
  spyRoot?.removeEventListener('scroll', spyHandler)
})
</script>

<template>
  <div class="settings view">
    <div class="view-head">
      <h2><Icon name="gear" :size="17" /> 设置</h2>
      <span class="view-sub">更改即时生效,无需手动保存</span>
    </div>

    <div class="settings-layout">
      <!-- 左侧分组锚点:点击滚动,scrollspy 跟随高亮 -->
      <nav class="settings-nav" aria-label="设置分组">
        <button
          v-for="g in groups"
          :key="g.id"
          :class="{ active: activeGroup === g.id }"
          @click="scrollToGroup(g.id)"
        >
          <Icon :name="g.icon" :size="13" /> {{ g.label }}
        </button>
      </nav>

      <div ref="flowEl" class="settings-flow">
        <!-- ========== 通用 ========== -->
        <section id="grp-general" class="settings-group">
          <header class="g-head">
            <Icon name="grid" :size="15" class="g-icon" />
            <span class="g-title">通用</span>
            <span class="g-desc">外观主题与项目默认行为</span>
          </header>

          <div class="panel g-card">
            <div class="g-body">
              <div class="set-item col">
                <div class="set-head">
                  <span class="set-title">外观主题</span>
                  <span class="set-desc">「色板 × 明暗」组合出 10 种外观;「跟随宿主」随 ZTools 深色模式自动切换</span>
                </div>
                <div class="set-ctl">
                  <ThemeSwitcher inline />
                </div>
              </div>

              <div class="set-item col">
                <div class="set-head">
                  <span class="set-title">代码配色</span>
                  <span class="set-desc">只改 12 类语法角色的颜色,不动界面色板;文档签名与代码块共用同一套</span>
                </div>
                <div class="set-ctl">
                  <CodeThemeSwitcher inline />
                </div>
              </div>

              <div class="set-item row">
                <div class="set-head">
                  <span class="set-title">打开项目的默认动作</span>
                  <span class="set-desc">项目页与命令面板点「打开」时执行的动作</span>
                </div>
                <div class="set-ctl">
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

              <div class="set-item row">
                <div class="set-head">
                  <span class="set-title">删除项目时</span>
                  <span class="set-desc">Windows 下删除的项目文件夹会移入回收站,可恢复</span>
                </div>
                <div class="set-ctl">
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
              </div>

              <label class="set-item row">
                <div class="set-head">
                  <span class="set-title">自动启用插件</span>
                  <span class="set-desc">安装插件后自动在 project.godot 中启用</span>
                </div>
                <div class="set-ctl">
                  <input v-model="state.autoEnablePlugin" type="checkbox" class="switch" @change="patchNow" />
                </div>
              </label>
            </div>
          </div>
        </section>

        <!-- ========== 引擎与网络 ========== -->
        <section id="grp-engine" class="settings-group">
          <header class="g-head">
            <Icon name="globe" :size="15" class="g-icon" />
            <span class="g-title">引擎与网络</span>
            <span class="g-desc">下载目录、商店账号与网络链路</span>
            <span v-if="state.storeAccount" class="tag ok g-status"><Icon name="check" :size="10" /> 已连接</span>
          </header>

          <div class="panel g-card">
            <div class="g-body">
              <div class="set-item col">
                <div class="set-head">
                  <span class="set-title">引擎安装目录</span>
                  <span class="set-desc">通过本插件下载的 Godot 引擎装在独立子目录中,互不干扰,卸载即删</span>
                </div>
                <div class="set-ctl">
                  <span class="mono root-value" :class="{ unset: !state.versionsRoot }">
                    {{ state.versionsRoot ?? '未设置(首次下载版本时选择)' }}
                  </span>
                  <button class="btn small" @click="chooseRoot">选择目录</button>
                  <button v-if="state.versionsRoot" class="btn small ghost" title="打开目录" @click="openPath(state.versionsRoot!)">
                    <Icon name="external" :size="13" />
                  </button>
                </div>
              </div>

              <div class="set-item col">
                <div class="set-head">
                  <span class="set-title">Asset Store 账号</span>
                  <span class="set-desc">连接后可在市场页收藏、查看资产详情</span>
                </div>
                <div class="set-ctl">
                  <template v-if="state.storeAccount">
                    <span class="account-avatar">{{ state.storeAccount.charAt(0).toUpperCase() }}</span>
                    <span class="account-name">{{ state.storeAccount }}</span>
                    <button class="btn small danger-text" @click="logoutStore">退出登录</button>
                  </template>
                  <template v-else>
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
                  </template>
                </div>
                <div class="set-note">
                  在 <span class="link" @click="openStoreSite">store.godotengine.org 的 API 密钥页面</span> 登录并生成 Key 后粘贴到此处;退出登录不会撤销网站上的 Key。
                </div>
              </div>

              <div class="set-item col">
                <div class="set-head">
                  <span class="set-title">网络代理</span>
                  <span class="set-desc">版本列表、引擎下载、插件市场等请求将经由该 HTTP 代理,保存后立即生效;留空直连</span>
                </div>
                <div class="set-ctl">
                  <input
                    v-model.trim="state.proxy"
                    class="input"
                    placeholder="如 http://127.0.0.1:7890,留空直连"
                    spellcheck="false"
                    @change="patchNow"
                  />
                </div>
              </div>

              <div class="set-item col">
                <div class="set-head">
                  <span class="set-title">网络诊断</span>
                  <span class="set-desc">走插件的实际网络链路(含代理);GitHub 不可达时引擎下载与导出模板会受影响</span>
                </div>
                <div class="set-ctl">
                  <button class="btn small" :disabled="netChecking" @click="runDiagnostics">
                    <span v-if="netChecking" class="spin"></span>
                    <Icon v-else name="activity" :size="13" />
                    {{ netChecking ? '检测中…' : '开始检测' }}
                  </button>
                </div>
                <div v-if="netResults.length" class="net-results">
                  <div v-for="r in netResults" :key="r.name" class="net-row" :class="{ bad: !r.ok }">
                    <Icon :name="r.ok ? 'check' : 'alert'" :size="13" />
                    <span class="net-name">{{ r.name }}</span>
                    <span class="net-ms mono">{{ r.ok ? `${r.ms} ms` : '不可达' }}</span>
                    <span v-if="!r.ok" class="net-err">{{ r.error }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- ========== 翻译 ========== -->
        <section id="grp-translate" class="settings-group">
          <header class="g-head">
            <Icon name="sparkle" :size="15" class="g-icon" />
            <span class="g-title">翻译</span>
            <span class="g-desc">市场文案与文档内容的界面翻译</span>
          </header>
          <TranslatePanel :state="state" @save="patchNow" />
        </section>

        <!-- ========== 备份 ========== -->
        <section id="grp-backup" class="settings-group">
          <header class="g-head">
            <Icon name="archive" :size="15" class="g-icon" />
            <span class="g-title">备份</span>
            <span class="g-desc">新建备份对话框的默认项,均可在对话框里临时更改</span>
          </header>

          <div class="panel g-card">
            <div class="g-body">
              <div class="set-item col">
                <div class="set-head">
                  <span class="set-title">默认备份目录</span>
                  <span class="set-desc">新建备份时预选的存放位置</span>
                </div>
                <div class="set-ctl">
                  <span class="mono root-value" :class="{ unset: !state.backupRoot }">
                    {{ state.backupRoot ?? '未设置(新建备份时选择)' }}
                  </span>
                  <button class="btn small" @click="chooseBackupRoot">选择目录</button>
                  <button
                    v-if="state.backupRoot"
                    class="btn small ghost"
                    title="打开目录"
                    @click="openPath(state.backupRoot!)"
                  ><Icon name="external" :size="12" /></button>
                </div>
              </div>

              <div class="set-item row">
                <div class="set-head">
                  <span class="set-title">默认备份方式</span>
                </div>
                <div class="set-ctl">
                  <div class="seg">
                    <button
                      :class="{ on: (state.backupMode ?? 'zip') === 'zip' }"
                      @click="state.backupMode = 'zip'; patchNow()"
                    >zip 打包</button>
                    <button
                      :class="{ on: state.backupMode === 'copy' }"
                      @click="state.backupMode = 'copy'; patchNow()"
                    >完整快照</button>
                  </div>
                </div>
              </div>

              <div class="set-item row">
                <div class="set-head">
                  <span class="set-title">zip 压缩级别</span>
                  <span class="set-desc">
                    {{ (state.backupMode ?? 'zip') === 'copy'
                      ? '当前默认方式为完整快照,压缩级别不生效。'
                      : '快速=最快但体积最大;最大=体积最小但耗时最长。' }}
                  </span>
                </div>
                <div class="set-ctl">
                  <div class="seg">
                    <button
                      v-for="lv in ([{ v: 1, t: '快速' }, { v: 6, t: '标准' }, { v: 9, t: '最大' }] as const)"
                      :key="lv.v"
                      :class="{ on: (state.backupLevel ?? 6) === lv.v }"
                      :disabled="(state.backupMode ?? 'zip') === 'copy'"
                      @click="state.backupLevel = lv.v; patchNow()"
                    >{{ lv.t }}</button>
                  </div>
                </div>
              </div>

              <label class="set-item row">
                <div class="set-head">
                  <span class="set-title">默认包含 .godot 编辑器缓存</span>
                  <span class="set-desc">缓存可再生成;排除后备份更小更快</span>
                </div>
                <div class="set-ctl">
                  <input v-model="state.backupIncludeCache" type="checkbox" class="switch" @change="patchNow" />
                </div>
              </label>

              <div class="set-item col">
                <div class="set-head">
                  <span class="set-title">默认排除目录</span>
                  <span class="set-desc">默认不排除任何内容,保证备份保真;排除项按目录名匹配并记入备份记录</span>
                </div>
                <div class="set-ctl chk-list">
                  <label class="chk-row">
                    <input
                      type="checkbox"
                      class="chk"
                      :checked="hasExclude('.git')"
                      @change="toggleExclude('.git', ($event.target as HTMLInputElement).checked)"
                    />
                    <span><code>.git</code></span>
                  </label>
                  <label class="chk-row">
                    <input
                      type="checkbox"
                      class="chk"
                      :checked="hasExclude('build')"
                      @change="toggleExclude('build', ($event.target as HTMLInputElement).checked)"
                    />
                    <span><code>build/</code> 与 <code>export/</code> 产物目录</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- ========== 数据 ========== -->
        <section id="grp-data" class="settings-group">
          <header class="g-head">
            <Icon name="hard-drive" :size="15" class="g-icon" />
            <span class="g-title">数据</span>
            <span class="g-desc">换机迁移与离线文档库缓存</span>
          </header>

          <div class="panel g-card">
            <div class="g-body">
              <div class="set-item col">
                <div class="set-head">
                  <span class="set-title">数据迁移</span>
                  <span class="set-desc">
                    导出:设置、项目清单、市场收藏、文档收藏与浏览历史,打包为一个 JSON 文件。
                    导入:项目只登记本机路径存在的条目;收藏按 assetId 合并不覆盖;设置只补本机缺失的键
                    (安装目录、代理这类机器本地配置不会被导入值覆盖)。
                  </span>
                </div>
                <div class="set-ctl">
                  <button class="btn small" :disabled="dtBusy" @click="exportData">
                    <Icon name="upload" :size="13" /> 导出数据
                  </button>
                  <button class="btn small" :disabled="dtBusy" @click="importData">
                    <Icon name="download" :size="13" /> 导入数据
                  </button>
                </div>
              </div>

              <div class="set-item col">
                <div class="set-head">
                  <span class="set-title">文档库缓存</span>
                  <span class="set-desc">从已装引擎导出的离线类参考,可随时在「文档」页重新生成,删除不影响插件其它数据</span>
                </div>
                <div class="set-ctl">
                  <button
                    class="btn small"
                    :disabled="!docsCache?.libraries.length"
                    @click="cleanDocsCache()"
                  >
                    <Icon name="trash" :size="13" /> 清理全部
                  </button>
                  <span v-if="docsCache && docsCache.error" class="dt-size">{{ docsCache.error }}</span>
                  <span v-else-if="docsCache" class="dt-size">共 {{ fmtSize(docsCache.sizeBytes) }}</span>
                </div>
                <div v-if="docsCache?.libraries.length" class="docs-cache-list">
                  <div v-for="l in docsCache.libraries" :key="l.versionId" class="dc-row">
                    <span class="dc-tag mono">{{ l.tag }}</span>
                    <span class="dc-meta">{{ l.classes }} 类 · {{ fmtSize(l.sizeBytes) }}</span>
                    <span class="grow"></span>
                    <button class="mini-link" @click="cleanDocsCache([l.versionId])">删除</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  max-width: 880px;
  margin: 0 auto;
  width: 100%;
}

.root-value {
  flex: 1 1 200px;
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

/* 行内宽控件(路径回显、Key 输入框)在控件区里弹性占满剩余宽度 */
.set-ctl .input {
  flex: 1 1 200px;
  min-width: 0;
}

/* 排除目录勾选行(纵向排布在控件区里;双类选择器压过 .set-ctl 的居中) */
.set-ctl.chk-list {
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
}

.chk-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}

.set-item code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--surface-3);
  font-family: var(--mono);
  font-size: 11.5px;
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

.dt-size {
  font-size: 12px;
  color: var(--text-3);
}

.docs-cache-list {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.dc-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
}

.dc-tag {
  color: var(--text);
  font-weight: 600;
}

.dc-meta {
  color: var(--text-3);
}

.mini-link {
  border: none;
  background: none;
  padding: 2px 6px;
  font-size: 12px;
  color: var(--danger);
  cursor: pointer;
  border-radius: 5px;
}

.mini-link:hover {
  background: var(--surface-2);
}

/* 网络诊断结果 */
.net-results {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.net-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--ok);
}

.net-row.bad {
  color: var(--danger);
}

.net-name {
  font-weight: 600;
  color: var(--text-2);
}

.net-ms {
  color: var(--text-3);
  min-width: 60px;
}

.net-err {
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 分组锚点布局 ---------- */
.settings-layout {
  display: flex;
  align-items: flex-start;
  gap: 20px;
  max-width: 880px;
}

/* 左栏:图标 + 组名,当前组品牌色高亮 + 左侧色条 */
.settings-nav {
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 148px;
  flex-shrink: 0;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--chrome);
}

.settings-nav button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--chrome-text);
  font-size: 12.5px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.settings-nav button:hover {
  color: var(--text);
  background: var(--surface);
}

.settings-nav button.active {
  background: var(--brand-weak);
  color: var(--brand);
  font-weight: 600;
  box-shadow: inset 2px 0 0 var(--brand);
}

.settings-flow {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.settings-group {
  /* 锚点滚动落点:给 sticky 头留余量 */
  scroll-margin-top: 16px;
}

/* 组头:图标 + 组名 + 一句定位描述,右侧可挂组级状态 */
.g-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 2px 8px;
}

.g-head .g-icon {
  color: var(--brand);
  flex-shrink: 0;
}

.g-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}

.g-desc {
  font-size: 12px;
  color: var(--text-3);
}

.g-status {
  margin-left: auto;
}

/* 组卡:一张卡片承载全组设置项,项与项之间用分隔线 */
.g-body {
  display: flex;
  flex-direction: column;
}

.set-item {
  padding: 12px 16px;
}

.set-item + .set-item {
  border-top: 1px solid var(--border);
}

/* 窄控件行:标题+描述在左,控件在右 */
.set-item.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

/* 宽控件项:标题+描述在上,控件区在下 */
.set-item.col .set-ctl {
  margin-top: 9px;
}

.set-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.row .set-ctl {
  flex: 0 0 auto;
  max-width: 100%;
}

.set-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.set-desc {
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-3);
}

/* 控件区:一行排开,放不下时换行 */
.set-ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* 项内补充说明 */
.set-note {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-3);
}

@media (max-width: 860px) {
  .settings-layout {
    flex-direction: column;
    gap: 14px;
  }

  .settings-nav {
    position: static;
    flex-direction: row;
    width: 100%;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .settings-nav button {
    flex-shrink: 0;
  }
}
</style>
