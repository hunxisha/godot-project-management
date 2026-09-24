// 主题系统:色板(data-theme)× 明暗(data-mode),由本模块统一写入 <html>。
//
// 单例:模块级 ref 保存当前选择,TabBar 的快捷切换器与设置页共用同一份状态,
// 无需引入状态管理库。useTheme() 不注册任何生命周期钩子,因此也可以在 main.ts 里
// 挂载前调用一次(提前应用主题,避免首帧闪一下默认色)。
import { computed, ref } from 'vue'
import { getSettings, saveSettings } from '../services/bridge'
import type { ThemeId, ThemeMode } from '../types/godot'

export interface ThemeDef {
  id: ThemeId
  name: string
  desc: string
  /** 卡片预览色:品牌色 / 页面底色 / 卡片底色 / 描边 */
  swatch: [string, string, string, string]
  /** 深色下的同一组预览色(预览必须与当前模式一致,否则浮层里会「看着是浅色、用着是深色」) */
  swatchDark: [string, string, string, string]
}

/** 色板清单(顺序即展示顺序) */
export const THEMES: ThemeDef[] = [
  {
    id: 'steel',
    name: '钢蓝',
    desc: '默认。对齐 Godot 编辑器原生质感的冷蓝色系',
    swatch: ['#478cbf', '#edf1f6', '#ffffff', '#dde4ee'],
    swatchDark: ['#6cb0e3', '#12161d', '#1b212b', '#2c3646']
  },
  {
    id: 'graphite',
    name: '石墨',
    desc: '中性无彩。长时间阅读最稳,不干扰内容',
    swatch: ['#4f5b6b', '#f1f2f4', '#ffffff', '#dfe2e6'],
    swatchDark: ['#9aa5b4', '#14161a', '#1c1f24', '#2e3239']
  },
  {
    id: 'forest',
    name: '森野',
    desc: '绿色强调,底色带极淡的冷绿,偏柔和',
    swatch: ['#3d8b62', '#eef3ef', '#ffffff', '#dbe6de'],
    swatchDark: ['#6fbf90', '#111713', '#1a211c', '#2b352e']
  },
  {
    id: 'violet',
    name: '紫罗兰',
    desc: '紫色强调,深浅对比最强的一档',
    swatch: ['#6a52c4', '#f2f0f8', '#ffffff', '#e1dcf0'],
    swatchDark: ['#a48ff0', '#131119', '#1c1a24', '#2f2c3a']
  },
  {
    id: 'amber',
    name: '暖阳',
    desc: '暖橙强调配暖灰底色,偏暖偏柔',
    swatch: ['#b56a1c', '#f7f3ee', '#ffffff', '#e8dfd3'],
    swatchDark: ['#e0a55c', '#17130e', '#201b15', '#332c23']
  }
]

export const MODES: { id: ThemeMode, name: string, icon: string }[] = [
  { id: 'auto', name: '跟随宿主', icon: 'monitor' },
  { id: 'light', name: '浅色', icon: 'sun' },
  { id: 'dark', name: '深色', icon: 'moon' }
]

const theme = ref<ThemeId>('steel')
const mode = ref<ThemeMode>('auto')
/** auto 模式下解析出的实际明暗(驱动菜单里的当前项高亮) */
const resolvedMode = ref<'light' | 'dark'>('light')

let initialized = false
let media: MediaQueryList | null = null

/** 宿主是否处于深色。优先问 ZTools,拿不到则退回系统偏好 */
function hostPrefersDark(): boolean {
  try {
    const api = (window as any).ztools
    if (api && typeof api.isDarkColors === 'function') return !!api.isDarkColors()
  } catch (e) { /* 宿主 API 不可用时退回系统偏好 */ }
  try {
    return !!(media && media.matches)
  } catch (e) { /* 再退一步:浅色 */ }
  return false
}

function apply() {
  resolvedMode.value = mode.value === 'auto'
    ? (hostPrefersDark() ? 'dark' : 'light')
    : mode.value
  const el = document.documentElement
  // 两个属性总是同时写入:main.css 不依赖「属性缺失」做隐式回退
  el.dataset.theme = theme.value
  el.dataset.mode = resolvedMode.value
}

export function useTheme() {
  if (!initialized) {
    initialized = true
    try {
      const s = getSettings()
      if (s.theme && THEMES.some((t) => t.id === s.theme)) theme.value = s.theme
      if (s.themeMode) mode.value = s.themeMode
    } catch (e) { /* 读设置失败时用默认值 */ }

    // 系统在运行中切换深浅时,auto 模式需要跟着变(setExpendHeight 之类的宿主事件没有回调)
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = () => {
        if (mode.value === 'auto') apply()
      }
      if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange)
      else if (typeof (media as any).addListener === 'function') (media as any).addListener(onChange)
    } catch (e) { /* matchMedia 不可用则只在切换时解析 */ }

    apply()
  }

  function setTheme(id: ThemeId) {
    theme.value = id
    apply()
    try {
      saveSettings({ theme: id })
    } catch (e) { /* 保存失败不影响本次生效 */ }
  }

  function setMode(next: ThemeMode) {
    mode.value = next
    apply()
    try {
      saveSettings({ themeMode: next })
    } catch (e) { /* 同上 */ }
  }

  /** 快捷按钮:在 跟随宿主 → 浅色 → 深色 之间循环 */
  function cycleMode() {
    const order: ThemeMode[] = ['auto', 'light', 'dark']
    setMode(order[(order.indexOf(mode.value) + 1) % order.length])
  }

  const currentTheme = computed(() => THEMES.find((t) => t.id === theme.value) || THEMES[0])
  const currentMode = computed(() => MODES.find((m) => m.id === mode.value) || MODES[0])

  return {
    theme,
    mode,
    resolvedMode,
    currentTheme,
    currentMode,
    themes: THEMES,
    modes: MODES,
    setTheme,
    setMode,
    cycleMode
  }
}
