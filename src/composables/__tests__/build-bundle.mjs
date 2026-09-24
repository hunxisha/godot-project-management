// 把 useBackups.ts 打成一个自包含 ESM 包,供 useBackups.test.mjs 导入。
//
// 为什么需要这一步:useBackups 依赖 Vue 响应式 API 且是 .ts 源码(import 路径无扩展名),
// Node 无法直接加载。用项目已有的 vite(devDependency)打成单文件即可在 Node 里运行,
// 不需要引入测试框架。
//
// 用法:node src/composables/__tests__/build-bundle.mjs
import { build } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 项目根 = src/composables/__tests__/../../.. */
const root = path.resolve(__dirname, '../../..')
/** 产物目录(.gitignore 已忽略) */
const OUT_DIR = '.gpm-test/out'

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: path.join(root, 'src', 'composables', 'useBackups.ts'),
      formats: ['es'],
      fileName: () => 'usebackups.mjs'
    },
    // 不 externalize:把 vue 一起打进来,产物才能脱离 node_modules 独立运行
    rollupOptions: { external: [] }
  }
})

console.log(`bundle built: ${path.join(root, OUT_DIR, 'usebackups.mjs')}`)
