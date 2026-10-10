# tplsrc 夹具来源说明

探测层（`src-ztools/preload/lib/tplprobe.js`）的文件头有一条硬约束：**夹具必须逐字摘自真实源码**，
不许合成源码里不存在的形态（`:65-66` 专门为此记了一次「不加宽容度也不造合成夹具」）。
所以这份树不是手写的假源码，是从本机**真编译过并核对过产物**的那份抽的：

- 来源：`E:\Godot项目\自定义模板\godot-4.7.2-stable`（godotengine/godot tag `4.7.2-stable`，
  由本插件的「代下载源码」取包 + `System32\tar.exe` 解包，母计划附录 B 的实测版本）
- 抽取日期：2026-10-11
- 生成方式：一次性脚本按下面的行号区间 `sed -n` 拼接，未改一个字符

## 逐字抽取的部分

| 夹具文件 | 真实文件与行区间 | 为什么是这几段 |
|---|---|---|
| `version.py` | 整份（9 行） | 版本闸的唯一读数（`parseVersionPy`），patch=2 → 串 `4.7.2-stable` |
| `SConstruct` | `160-215`、`259-272`、`470-490`、`1076-1092` | 依次是：核心 Bool/EnumVariable 声明区（optimize/debug_symbols/lto/production/deprecated/precision/minizip/brotli/vulkan/opengl3/d3d12/accesskit/angle/sdl…）、`disable_*` 声明区、`module_<name>_enabled` 的动态声明循环（照出「f-string 声明不该被当成变量名」）、`if env["disable_*"]:` 连带块（`parseCascades` 的真图） |
| `platform/windows/detect.py` | `222-235`、`289-298` | 前者含 `use_static_cpp` 的声明（该 flag **只**在平台脚本里，不读平台脚本这一项永远标灰）；后者是 `def get_flags()` 全体，含 `"d3d12": True` —— 就是真机上把「取消 d3d12」变成空操作、撞 D3D12 SDK 墙的那一层平台覆盖 |
| `modules/<name>/config.py` | 57 个模块，整份逐字 | `parseIsEnabled` 读的就是它；全树只有 `mono` 与 `text_server_fb` 定义了 `is_enabled()`（都是「一行注释 + return False」，与 `tplprobe.js:46-50` 的注释一致） |

## 只作为「存在性标记」的部分（内容不参与探测）

`modules/<name>/register_types.h` 与 `modules/<name>/SCsub` 是 **0 字节占位**。
依据：探测层对模块只读 `config.py`（`tplprobe.js:102`），另两件只 `existsSync`（`:99`）。
真实树里这 57 个目录三件套齐全，所以把两件 unread 的文件置空不改变任何判定结果。

## 两处刻意保留的目录形态

- `modules/__pycache__/` —— 本机**编译过**的树里真实存在（构建产物，不在官方 tar 包里），
  它缺三件套，专门用来照「目录存在但不是模块」这一格。里面那个 `README` 不是上游内容，只是让目录存在。
- `modules/.gitkeep` —— 点开头条目，用来照 `detectBuiltinModules` 那条「`*` 天然不匹配点开头」的跳过规则。

## 怎么重造

改过 `tplprobe.js` 的判据、或换 Godot 版本时，重新按上面的区间抽一遍（不要手写假源码）。
`tests/tpl_parity.rs` 里的探测对照用例直接吃这份树，夹具缺什么会当场红。
