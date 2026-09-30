// electron-builder 配置。
//
// 用 .cjs 而非 builder.json,是为了从**已安装的 electron** 读取精确版本:
// electron-builder 要求精确版本(它要按版本下载对应平台二进制),而 desktop/ 自身没有
// node_modules,配置里写死版本会与根 package.json 的依赖声明漂移。
//
// publish 一律不做:v1.0 无自动更新,update-info 文件(latest.yml)没有用途;
// 产物由 CI 用 gh 上传到 GitHub Release(见 .github/workflows/desktop-release.yml)。
// 若启用 electron-builder 的 publish,在未配置 repository 时会触发上游
// computeChannelNames 的空配置解引用报错,故此处显式关闭。

const pkg = require('../package.json')

/** 取精确 electron 版本:优先已安装版本,回退根依赖声明(去范围前缀) */
function electronVersion() {
  try {
    return require('electron/package.json').version
  } catch (e) {
    const declared = String((pkg.devDependencies || {}).electron || '').replace(/^[\^~>=<\s]+/, '')
    if (/^\d+\.\d+\.\d+/.test(declared)) return declared
    throw new Error(`无法确定 electron 精确版本,请在 package.json 中把 electron 钉为精确版本(当前:${pkg.devDependencies?.electron})`)
  }
}

module.exports = {
  appId: 'com.ztools.godot-workshop',
  productName: 'Godot Workshop',
  electronVersion: electronVersion(),
  directories: {
    output: 'release'
  },
  files: [
    'main/**',
    'preload/**',
    'renderer/**',
    'vendor/**',
    'package.json',
    '!**/*.map'
  ],
  win: {
    target: [
      { target: 'nsis', arch: ['x64', 'arm64'] }
    ]
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    artifactName: 'GodotWorkshop-${version}-${arch}-setup.${ext}'
  },
  mac: {
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] }
    ],
    category: 'public.app-category.developer-tools',
    // 免签名起步(见 docs/desktop-app-plan.md §0/§5):不做代码签名与公证
    identity: null
  },
  dmg: {
    artifactName: 'GodotWorkshop-${version}-${arch}.${ext}'
  },
  linux: {
    target: [
      'AppImage',
      'deb'
    ],
    category: 'Development'
  },
  appImage: {
    artifactName: 'GodotWorkshop-${version}-${arch}.AppImage'
  },
  deb: {
    artifactName: 'godot-workshop-${version}-${arch}.deb'
  }
}
