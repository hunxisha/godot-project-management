import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  base: './',
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
