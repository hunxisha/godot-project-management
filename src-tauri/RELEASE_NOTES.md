# Godot 工坊桌面版

下载并管理 Godot 引擎版本与导出模板、隔离并快捷打开项目、浏览官方资产市场并安装插件与素材、
一键 headless 导出游戏、为项目做完整备份 —— 独立桌面应用，装完即用，无需 ZTools。

## 安装

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows | `Godot.Workshop_2.0.0_x64-setup.exe` | 64 位 NSIS 安装包 |
| macOS (Apple 芯片) | `Godot.Workshop_2.0.0_aarch64.dmg` | M 系列芯片 |
| Linux | `Godot.Workshop_2.0.0_amd64.AppImage` | 免安装，`chmod +x` 后直接运行 |
| Linux | `Godot.Workshop_2.0.0_amd64.deb` | Debian/Ubuntu 系 |

### 当前是免签名构建

- **Windows**：首次运行会出现 SmartScreen「未知发布者」提示 → 点「更多信息」→「仍要运行」。
- **macOS**：首次打开需**右键 → 打开**，或在「系统设置 → 隐私与安全性」中放行。
- **Linux**：无额外提示。

## 2.0.0：宿主换新（Electron → Tauri 2）

同一套界面与能力语义换到**系统 WebView + Rust 核心**：

- 闲置内存占用显著下降（1.x 的 Electron 自带完整 Chromium；2.0 复用系统 WebView）
- 安装体积同步缩小
- 能力层 30 个模块以 Rust 重写，**数据格式与 1.x 完全一致**：
  - 1.x 老用户迁移 = 把 1.x 数据目录的 `db.json` 拷到新数据目录，或继续用「设置 → 数据导出/导入」
  - 插件版（ZTools）用户同样走「数据导出/导入」
- 文档库管线经**双端逐字节 diff 验收**：与 1.x 生成的切片完全一致，翻译、搜索、跨版本 diff 行为不变
- 引擎下载经真实网络验收：断点续传（中断后继续）+ SHA-256 校验

已知差异（相比 1.x）：导入本地引擎、资产预览确认层、导出历史等少量功能在 2.0.0 起步版尚未接线，
对应入口会显示「即将支持」；其余七页功能可用。

## 反馈

问题与建议请提到 [Issues](https://github.com/hunxisha/godot-project-management/issues)。
