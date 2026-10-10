import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  base: './',
  // 垫片 src/public/tauri-shim.js 是 index.html 的经典脚本(URL /tauri-shim.js),不经打包、按原文件送出。
  // Vite 默认 publicDir 是 <root>/public(本仓库没有这个目录),不指过来就取不到垫片 → 桌面版开屏即「未检测到 ZTools 环境」。
  publicDir: fileURLToPath(new URL('./src/public', import.meta.url)),
  server: {
    // 5173 被占用时直接报错,而不是静默切换端口导致 ZTools 加载到空白页
    strictPort: true,
    // Windows 上 localhost 可能解析为 IPv6(::1),而 ZTools webview 用 IPv4 访问会连接被拒导致白屏。
    // 明确绑定 127.0.0.1,与 plugin.json 的 development.main 保持一致
    host: '127.0.0.1'
  },
  build: {
    outDir: fileURLToPath(new URL('./src-ztools/dist', import.meta.url)),
    emptyOutDir: true
  }
})
