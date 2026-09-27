// 把渲染层的 .ts 源码打成自包含 ESM 包,供 Node 里的回归测试导入。
//
// 为什么需要这一步:被测源码是 .ts(import 路径无扩展名),Node 无法直接加载。
// 用项目已有的 vite(devDependency)打成单文件即可在 Node 里运行,
// 不需要引入测试框架,也不需要依赖 Node 24 的类型剥离(README 声明支持 Node ≥ 18)。
//
// 产物(.gpm-test/ 已被 .gitignore 忽略):
//   .gpm-test/out/usebackups.mjs      ← src/composables/useBackups.ts       (useBackups.test.mjs)
//   .gpm-test/out/usetaskdialog.mjs   ← src/composables/useTaskDialog.ts    (useTaskDialog.test.mjs)
//   .gpm-test/out/usemarketsearch.mjs ← src/composables/useMarketSearch.ts  (useMarketSearch.test.mjs)
//   .gpm-test/out/useassethydration.mjs ← src/composables/useAssetHydration.ts (useMarketSearch.test.mjs)
//   .gpm-test/out/format.mjs          ← src/utils/format.ts                 (src/__tests__/format.test.mjs)
//   .gpm-test/out/godotversion.mjs    ← src/utils/godotVersion.ts           (src/__tests__/marketUtils.test.mjs)
//   .gpm-test/out/markettags.mjs      ← src/utils/marketTags.ts             (src/__tests__/marketUtils.test.mjs)
//
// 一次打包供全部渲染层测试共用(npm run test:renderer),避免每个测试各起一次 vite。
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
        usemarketsearch: path.join(root, 'src', 'composables', 'useMarketSearch.ts'),
        useassethydration: path.join(root, 'src', 'composables', 'useAssetHydration.ts'),
        usemarketbrowse: path.join(root, 'src', 'composables', 'useMarketBrowse.ts'),
        usemarketinstall: path.join(root, 'src', 'composables', 'useMarketInstall.ts'),
        useprojectlist: path.join(root, 'src', 'composables', 'useProjectList.ts'),
        useprojectcreate: path.join(root, 'src', 'composables', 'useProjectCreate.ts'),
        useprojectdelete: path.join(root, 'src', 'composables', 'useProjectDelete.ts'),
        useinstallprogress: path.join(root, 'src', 'composables', 'useInstallProgress.ts'),
        usemarketfavorites: path.join(root, 'src', 'composables', 'useMarketFavorites.ts'),
        useaddonselection: path.join(root, 'src', 'composables', 'useAddonSelection.ts'),
        useaddonactions: path.join(root, 'src', 'composables', 'useAddonActions.ts'),
        usebackuppageactions: path.join(root, 'src', 'composables', 'useBackupPageActions.ts'),
        usedocs: path.join(root, 'src', 'composables', 'useDocs.ts'),
        format: path.join(root, 'src', 'utils', 'format.ts'),
        godotversion: path.join(root, 'src', 'utils', 'godotVersion.ts'),
        markettags: path.join(root, 'src', 'utils', 'marketTags.ts'),
        avatar: path.join(root, 'src', 'utils', 'avatar.ts'),
        bbcode: path.join(root, 'src', 'utils', 'bbcode.ts'),
        // 测试专用:暴露 vue(与各入口共享同一个 chunk),供测试创建 ref
        vueshim: path.join(root, 'src', 'composables', '__tests__', 'vue-shim.mjs')
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.mjs`
    },
    // 不 externalize:把 vue 一起打进来,产物才能脱离 node_modules 独立运行
    rollupOptions: { external: [] }
  }
})

for (const name of ['usebackups', 'usetaskdialog', 'usemarketsearch', 'useassethydration', 'usemarketbrowse', 'usemarketinstall', 'usemarketfavorites', 'useprojectlist', 'useprojectcreate', 'useprojectdelete', 'useinstallprogress', 'useaddonselection', 'useaddonactions', 'usebackuppageactions', 'usedocs', 'format', 'godotversion', 'markettags', 'avatar', 'bbcode', 'vueshim']) {
  console.log(`bundle built: ${path.join(root, OUT_DIR, `${name}.mjs`)}`)
}
