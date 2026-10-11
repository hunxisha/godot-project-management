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
//   .gpm-test/out/usedocs.mjs         ← src/composables/useDocs.ts          (src/composables/__tests__/useDocs.test.mjs)
//   .gpm-test/out/tools.mjs           ← src/tools/index.ts(barrel,Godot 文件解析器 + 树工具) (src/tools/__tests__/*.test.mjs)
//   .gpm-test/out/tkmanifest.mjs      ← src/toolkit/manifest.ts(工具箱 manifest 校验) (src/toolkit/__tests__/manifest.test.mjs)
//   .gpm-test/out/tkorchestrate.mjs   ← src/toolkit/orchestrate.ts(三段式调度) (src/toolkit/__tests__/orchestrate.test.mjs)
//   .gpm-test/out/tkdiff.mjs          ← src/toolkit/diff.ts(行级 LCS diff) (src/toolkit/__tests__/diff.test.mjs)
//   .gpm-test/out/tkschema.mjs        ← src/toolkit/schema.ts(声明式参数 schema) (src/toolkit/__tests__/schema.test.mjs)
//   .gpm-test/out/tkgpm.mjs             ← src/toolkit/gpm.ts(window.gpm 受限层组装) (src/toolkit/__tests__/gpm.test.mjs)
//   .gpm-test/out/tkloader.mjs          ← src/toolkit/loader.ts(注册与错误隔离的纯部分) (src/toolkit/__tests__/loader.test.mjs)
//   .gpm-test/out/tkfeatures.mjs        ← src/toolkit/features.ts(feature 注册与冲突让位) (src/toolkit/__tests__/features.test.mjs)
//   .gpm-test/out/tktoollog.mjs         ← src/toolkit/toollog.ts(动作账本) (src/toolkit/__tests__/toollog.test.mjs)
//   .gpm-test/out/tkscaffold.mjs        ← src/toolkit/scaffold.ts(骨架生成器纯函数) (src/toolkit/__tests__/scaffold.test.mjs)
//   .gpm-test/out/tkformat.mjs          ← src/tools/builtin/gdscript-format/format.ts(文本卫生算法) (…/__tests__/gdscriptFormat.test.mjs)
//   .gpm-test/out/tkform.mjs            ← src/tools/builtin/gdscript-format/index.ts(内置工具 entry:schema + plan) (同上)
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
        useupdatescan: path.join(root, 'src', 'composables', 'useUpdateScan.ts'),
        usedocs: path.join(root, 'src', 'composables', 'useDocs.ts'),
        // 工具箱首页的装配层(内置注册 + 用户插件扫描的**编排**,不是真执行路径:Q33)
        usetoolkit: path.join(root, 'src', 'composables', 'useToolkit.ts'),
        format: path.join(root, 'src', 'utils', 'format.ts'),
        godotversion: path.join(root, 'src', 'utils', 'godotVersion.ts'),
        markettags: path.join(root, 'src', 'utils', 'marketTags.ts'),
        avatar: path.join(root, 'src', 'utils', 'avatar.ts'),
        bbcode: path.join(root, 'src', 'utils', 'bbcode.ts'),
        godotdocs: path.join(root, 'src', 'utils', 'godotDocs.ts'),
        doctree: path.join(root, 'src', 'utils', 'docTree.ts'),
        tools: path.join(root, 'src', 'tools', 'index.ts'),
        // 工具箱(第 1 批)按模块各开一个入口:纯函数层进 Node harness,
        // 不建 barrel —— 建了就把碰 window 的 loader/gpm 一起拖进测试产物。
        tkmanifest: path.join(root, 'src', 'toolkit', 'manifest.ts'),
        tkgpm: path.join(root, 'src', 'toolkit', 'gpm.ts'),
        tkloader: path.join(root, 'src', 'toolkit', 'loader.ts'),
        tkfeatures: path.join(root, 'src', 'toolkit', 'features.ts'),
        tktoollog: path.join(root, 'src', 'toolkit', 'toollog.ts'),
        tkscaffold: path.join(root, 'src', 'toolkit', 'scaffold.ts'),
        tkformat: path.join(root, 'src', 'tools', 'builtin', 'gdscript-format', 'format.ts'),
        tkform: path.join(root, 'src', 'tools', 'builtin', 'gdscript-format', 'index.ts'),
        tkorchestrate: path.join(root, 'src', 'toolkit', 'orchestrate.ts'),
        tkdiff: path.join(root, 'src', 'toolkit', 'diff.ts'),
        tkschema: path.join(root, 'src', 'toolkit', 'schema.ts'),
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

for (const name of ['usebackups', 'usetaskdialog', 'usemarketsearch', 'useassethydration', 'usemarketbrowse', 'usemarketinstall', 'usemarketfavorites', 'useprojectlist', 'useprojectcreate', 'useprojectdelete', 'useinstallprogress', 'useaddonselection', 'useaddonactions', 'usebackuppageactions', 'useupdatescan', 'usedocs', 'usetoolkit', 'format', 'godotversion', 'markettags', 'avatar', 'bbcode', 'godotdocs', 'doctree', 'vueshim', 'tools', 'tkmanifest', 'tkorchestrate', 'tkdiff', 'tkschema', 'tkgpm', 'tkloader', 'tkfeatures', 'tktoollog', 'tkscaffold', 'tkformat', 'tkform']) {
  console.log(`bundle built: ${path.join(root, OUT_DIR, `${name}.mjs`)}`)
}
