// 打包前同步桌面版静态资源(从仓库根运行):
//   desktop/renderer ← src-ztools/dist        (渲染层构建产物,主进程加载)
//   desktop/vendor/preload ← src-ztools/preload  (能力层 CommonJS,preload require)
// 仓库开发态不走这两个目录(main/preload 优先探测打包布局,见各自文件);仅 electron-builder 打包用。
const { cpSync, rmSync, existsSync, mkdirSync } = require('node:fs')
const path = require('node:path')

const root = process.cwd()
const distIndex = path.join(root, 'src-ztools', 'dist', 'index.html')
if (!existsSync(distIndex)) {
  console.error('未找到 src-ztools/dist/index.html —— 先运行 npm run build')
  process.exit(1)
}

rmSync(path.join(root, 'desktop', 'renderer'), { recursive: true, force: true })
cpSync(path.join(root, 'src-ztools', 'dist'), path.join(root, 'desktop', 'renderer'), { recursive: true })

const vendor = path.join(root, 'desktop', 'vendor', 'preload')
rmSync(path.join(root, 'desktop', 'vendor'), { recursive: true, force: true })
mkdirSync(path.join(root, 'desktop', 'vendor'), { recursive: true })
cpSync(path.join(root, 'src-ztools', 'preload'), vendor, {
  recursive: true,
  filter: (src) => !src.includes('__tests__')
})

console.log('已同步 desktop/renderer 与 desktop/vendor/preload')
