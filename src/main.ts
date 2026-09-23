import { createApp } from 'vue'
import './main.css'
import App from './App.vue'

/**
 * 环境守卫:ZTools 插件依赖 window.ztools(host 注入)与 window.services(preload 注入)。
 * 缺失时给出明确提示,而不是白屏。直接用浏览器访问 dev 地址属于这种情况。
 */
function showBootError(title: string, detail: string) {
  const el = document.getElementById('app')
  if (!el) return
  el.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f6f8;color:#24292f;font-family:system-ui,sans-serif;padding:24px;">
      <div style="max-width:520px;background:#fff;border:1px solid #e2e6ea;border-radius:10px;padding:24px 28px;box-shadow:0 1px 3px rgba(0,0,0,.06);">
        <div style="font-size:16px;font-weight:600;margin-bottom:8px;color:#cf3c3c;">${title}</div>
        <div style="font-size:13px;line-height:1.8;color:#57606a;">${detail}</div>
      </div>
    </div>`
}

if (typeof window.ztools === 'undefined') {
  showBootError(
    '未检测到 ZTools 环境',
    '本页面是 ZTools 插件,需要在 ZTools 中打开:<br>' +
      '1. 确认已运行 npm run dev(Vite 监听 5173 端口);<br>' +
      '2. 在 ZTools 开发者工具中安装本插件(plugin.json 位于 src-ztools/);<br>' +
      '3. 在 ZTools 主输入框输入「godot」进入插件。<br>' +
      '直接用浏览器访问 dev 地址会因缺少 ZTools API 而无法运行。'
  )
} else if (typeof window.services === 'undefined') {
  showBootError(
    'preload 服务未注入',
    'window.ztools 已就绪,但 preload 未成功注入 window.services:<br>' +
      '1. 确认 src-ztools/preload/services.js 存在且无语法错误;<br>' +
      '2. 在 ZTools 开发者工具中重新载入插件后再进入;<br>' +
      '3. 打开插件页控制台查看 preload 的具体报错信息。'
  )
} else {
  createApp(App).mount('#app')
}
