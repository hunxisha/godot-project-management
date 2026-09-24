// 把渲染层的 .ts 源码打成自包含 ESM 包,供 Node 里的回归测试导入。
//
// 为什么需要这一步:被测源码是 .ts(import 路径无扩展名),Node 无法直接加载。
// 用项目已有的 vite(devDependency)打成单文件即可在 Node 里运行,
// 不需要引入测试框架,也不需要依赖 Node 24 的类型剥离(README 声明支持 Node ≥ 18)。
//
// 产物(.gpm-test/ 已被 .gitignore 忽略):
//   .gpm-test/out/usebackups.mjs   ← src/composables/useBackups.ts    (useBackups.test.mjs)
//   .gpm-test/out/usetaskdialog.mjs← src/composables/useTaskDialog.ts (useTaskDialog.test.mjs)
//   .gpm-test/out/format.mjs       ← src/utils/format.ts              (src/__tests__/format.test.mjs)
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
      entry: {
        usebackups: path.join(root, 'src', 'composables', 'useBackups.ts'),
        usetaskdialog: path.join(root, 'src', 'composables', 'useTaskDialog.ts'),
        format: path.join(root, 'src', 'utils', 'format.ts')
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.mjs`
    },
    // 不 externalize:把 vue 一起打进来,产物才能脱离 node_modules 独立运行
    rollupOptions: { external: [] }
  }
})

for (const name of ['usebackups', 'usetaskdialog', 'format']) {
  console.log(`bundle built: ${path.join(root, OUT_DIR, `${name}.mjs`)}`)
}
