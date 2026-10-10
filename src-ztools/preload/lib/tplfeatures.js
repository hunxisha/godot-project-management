// 自编译模板 · 能力层:面板上有什么功能、每项对应哪个 scons 变量。
//
// 这张表只管**语义**,不管"这份源码认不认这个开关" —— 后者是 tplprobe.js 对着 SConstruct 与
// modules/ 探出来的(策划书 §5.1 三层模型)。分开的原因:内置表能给中文名/说明/量级/风险/联动,
// 动态枚举给不了;而动态探测能防版本漂移,内置表防不了。两边各出各自的那半。
//
// flag 名逐字取自 godotengine/godot tag 4.7.2-stable 的 SConstruct / platform/windows/detect.py,
// 行号见每项的 src 注释与策划书 §5.1 表。模块 flag 一律 `module_<目录名>_enabled`:
// methods.py:258 `module_name = os.path.basename(path)`,没有名字翻译层。
//
// 不进这张表的开关(源码里存在但关掉就是废模板):freetype / gdscript / text_server_adv /
// glslang / threads。理由见策划书 §3 负范围补条 —— 面板替不了用户判断"我的项目要不要文字"。
/** @typedef {'large'|'medium'|'small'|'tiny'|'none'} SizeImpact */
/** @typedef {'safe'|'notice'|'danger'} Risk */

/**
 * @typedef {Object} TplFeature
 * @property {string} id           面板项 id(渲染层与勾选快照用它,不用 flag 名:一项可能多 flag)
 * @property {string} label        中文名
 * @property {string} group        必须是 TPL_GROUPS 里的一项
 * @property {string} desc         一句话说明:取消后会失去什么(不是"这是什么")
 * @property {SizeImpact} sizeImpact 体积量级。**不给 MB**,只给相对量级(策划书 §1 第 9 条)
 * @property {Risk} risk
 * @property {string[]} flags      该面板项映射到的 scons 变量名
 */

const TPL_GROUPS = ['渲染与显示', '引擎子系统', '资源格式', '音视频', '3D 资产与几何', '网络与联机', '界面与文字', '编译选项']

/** @type {TplFeature[]} */
const TPL_FEATURES = [
  // ---- 渲染与显示 ----
  { id: 'vulkan', label: 'Vulkan 渲染驱动', group: '渲染与显示', desc: '取消后 Forward Plus / Mobile 渲染法不可用', sizeImpact: 'large', risk: 'danger', flags: ['vulkan'] },          // SConstruct:197 默认 True
  { id: 'opengl3', label: 'OpenGL / GLES3 驱动', group: '渲染与显示', desc: '取消后 Compatibility 渲染法不可用', sizeImpact: 'medium', risk: 'notice', flags: ['opengl3'] },            // SConstruct:198
  { id: 'angle', label: 'ANGLE（GLES3 over D3D11）', group: '渲染与显示', desc: '取消后 opengl3 少一条后端路径', sizeImpact: 'medium', risk: 'notice', flags: ['angle'] },              // SConstruct:203
  { id: 'd3d12', label: 'Direct3D 12 驱动', group: '渲染与显示', desc: 'Windows 平台默认开(detect.py get_flags 覆盖 SConstruct:199 的 False);保留需本机装 D3D12 SDK,取消则发 d3d12=no', sizeImpact: 'medium', risk: 'notice', flags: ['d3d12'] },                    // SConstruct:199 声明 False,平台覆盖 True
  { id: 'accesskit', label: 'AccessKit 无障碍驱动', group: '渲染与显示', desc: '取消后屏幕阅读器读不到界面', sizeImpact: 'small', risk: 'safe', flags: ['accesskit'] },                  // SConstruct:202
  { id: 'sdl', label: 'SDL3 输入驱动', group: '渲染与显示', desc: '取消后手柄输入回落系统栈', sizeImpact: 'small', risk: 'safe', flags: ['sdl'] },                                        // SConstruct:204
  // ---- 引擎子系统 ----
  { id: 'sys3d', label: '3D 节点与场景', group: '引擎子系统', desc: '取消后 Node3D/Camera3D/MeshInstance3D 等不可用', sizeImpact: 'large', risk: 'notice', flags: ['disable_3d'] },      // SConstruct:264
  { id: 'phys3d', label: '3D 物理', group: '引擎子系统', desc: '取消后 3D 碰撞体与 RigidBody 不可用', sizeImpact: 'medium', risk: 'safe', flags: ['disable_physics_3d'] },               // SConstruct:267
  { id: 'phys2d', label: '2D 物理', group: '引擎子系统', desc: '取消后 2D 碰撞体不可用', sizeImpact: 'small', risk: 'safe', flags: ['disable_physics_2d'] },                             // SConstruct:266
  { id: 'nav3d', label: '3D 导航', group: '引擎子系统', desc: '取消后 3D NavigationAgent/Region 不可用', sizeImpact: 'medium', risk: 'safe', flags: ['disable_navigation_3d'] },          // SConstruct:269
  { id: 'nav2d', label: '2D 导航', group: '引擎子系统', desc: '取消后 2D NavigationAgent/Region 不可用', sizeImpact: 'small', risk: 'safe', flags: ['disable_navigation_2d'] },           // SConstruct:268
  { id: 'xr', label: 'XR 支持', group: '引擎子系统', desc: '取消后 XRInterface 相关不可用', sizeImpact: 'medium', risk: 'safe', flags: ['disable_xr'] },                                   // SConstruct:270
  { id: 'advGui', label: '高级 GUI 节点与主题属性', group: '引擎子系统', desc: '取消后部分 Control 主题属性与富样式不可用', sizeImpact: 'medium', risk: 'notice', flags: ['disable_advanced_gui'] }, // SConstruct:265
  { id: 'overrideCfg', label: 'override.cfg 支持', group: '引擎子系统', desc: '取消后不能用 override.cfg 覆盖项目设置', sizeImpact: 'tiny', risk: 'safe', flags: ['disable_overrides'] },  // SConstruct:271
  // ---- 资源格式 ----
  { id: 'fmtWebp', label: 'WebP 图片', group: '资源格式', desc: '取消后 .webp 资源运行时加载不了', sizeImpact: 'small', risk: 'notice', flags: ['module_webp_enabled'] },
  { id: 'fmtJpg', label: 'JPG 图片', group: '资源格式', desc: '取消后 .jpg 加载不了', sizeImpact: 'small', risk: 'notice', flags: ['module_jpg_enabled'] },
  { id: 'fmtRaster', label: 'TGA / BMP / HDR 图片', group: '资源格式', desc: '取消后这三种格式加载不了', sizeImpact: 'tiny', risk: 'safe', flags: ['module_tga_enabled', 'module_bmp_enabled', 'module_hdr_enabled'] },
  { id: 'fmtCompressed', label: '压缩纹理（DDS/KTX/EXR/ASTC/BC/ETC/CVTT）', group: '资源格式', desc: '取消后对应压缩纹理加载不了', sizeImpact: 'small', risk: 'notice', flags: ['module_dds_enabled', 'module_ktx_enabled', 'module_tinyexr_enabled', 'module_astcenc_enabled', 'module_bcdec_enabled', 'module_etcpak_enabled', 'module_cvtt_enabled'] },
  { id: 'fmtSvg', label: 'SVG 矢量纹理', group: '资源格式', desc: '取消后 .svg 加载不了', sizeImpact: 'small', risk: 'safe', flags: ['module_svg_enabled'] },
  { id: 'fmtZip', label: 'ZIP 读写（ZIPReader/ZIPPacker）', group: '资源格式', desc: '取消后运行时读不了 zip 包', sizeImpact: 'small', risk: 'safe', flags: ['module_zip_enabled'] },
  // ---- 音视频 ----
  { id: 'audOgg', label: 'Ogg / Vorbis 音频', group: '音视频', desc: '取消后 .ogg 不能播 —— Godot 主力音频格式', sizeImpact: 'small', risk: 'notice', flags: ['module_vorbis_enabled', 'module_ogg_enabled'] },
  { id: 'audMp3', label: 'MP3 音频', group: '音视频', desc: '取消后 AudioStreamMP3 不可用', sizeImpact: 'small', risk: 'notice', flags: ['module_mp3_enabled'] },
  { id: 'audTheora', label: 'Theora 视频', group: '音视频', desc: '取消后 VideoStreamTheora 不可用', sizeImpact: 'small', risk: 'safe', flags: ['module_theora_enabled'] },
  { id: 'audInteractive', label: '交互式音乐', group: '音视频', desc: '取消后 AudioStreamInteractive / Playlist / Synchronized 不可用', sizeImpact: 'small', risk: 'safe', flags: ['module_interactive_music_enabled'] },
  // ---- 3D 资产与几何 ----
  { id: 'a3Gltf', label: 'glTF / GLB', group: '3D 资产与几何', desc: '取消后 GLTFDocument 等 21 个类消失', sizeImpact: 'medium', risk: 'notice', flags: ['module_gltf_enabled'] },
  { id: 'a3Fbx', label: 'FBX 导入', group: '3D 资产与几何', desc: '取消后 .fbx 导入消失(模板侧本就少用)', sizeImpact: 'small', risk: 'safe', flags: ['module_fbx_enabled'] },
  { id: 'a3Csg', label: 'CSG 构造几何', group: '3D 资产与几何', desc: '取消后 CSG*3D 节点不可用', sizeImpact: 'small', risk: 'safe', flags: ['module_csg_enabled'] },
  { id: 'a3Gridmap', label: 'GridMap', group: '3D 资产与几何', desc: '取消后 GridMap 节点不可用', sizeImpact: 'small', risk: 'safe', flags: ['module_gridmap_enabled'] },
  { id: 'a3Jolt', label: 'Jolt 物理后端', group: '3D 资产与几何', desc: '取消后项目设置里选不到 Jolt', sizeImpact: 'medium', risk: 'safe', flags: ['module_jolt_physics_enabled'] },
  { id: 'a3GodotPhys', label: 'Godot 自带物理后端（2D+3D）', group: '3D 资产与几何', desc: '取消后只剩 Jolt;两者都关 = 没有物理', sizeImpact: 'medium', risk: 'danger', flags: ['module_godot_physics_2d_enabled', 'module_godot_physics_3d_enabled'] },
  { id: 'a3Lightmap', label: 'Lightmapper RD', group: '3D 资产与几何', desc: '取消后无法烘焙光照(烘焙发生在编辑器)', sizeImpact: 'small', risk: 'safe', flags: ['module_lightmapper_rd_enabled'] },
  { id: 'a3GeomTools', label: '网格工具（meshoptimizer/xatlas/vhacd/basis）', group: '3D 资产与几何', desc: '取消后网格压缩/展图/凸包/转码链断', sizeImpact: 'small', risk: 'safe', flags: ['module_meshoptimizer_enabled', 'module_xatlas_unwrap_enabled', 'module_vhacd_enabled', 'module_basis_universal_enabled'] },
  // ---- 网络与联机 ----
  { id: 'netMbedtls', label: 'mbedTLS（HTTPS / TLS）', group: '网络与联机', desc: '取消后任何 HTTPS、加密连接、WebSocket 安全连接全断', sizeImpact: 'small', risk: 'danger', flags: ['module_mbedtls_enabled'] },
  { id: 'netEnet', label: 'ENet', group: '网络与联机', desc: '取消后 ENetMultiplayerPeer 不可用', sizeImpact: 'small', risk: 'safe', flags: ['module_enet_enabled'] },
  { id: 'netMp', label: '高层多人', group: '网络与联机', desc: '取消后 MultiplayerSpawner / Synchronizer 不可用', sizeImpact: 'small', risk: 'safe', flags: ['module_multiplayer_enabled'] },
  { id: 'netWs', label: 'WebSocket', group: '网络与联机', desc: '取消后 WebSocketPeer/Client/Server 不可用', sizeImpact: 'small', risk: 'safe', flags: ['module_websocket_enabled'] },
  { id: 'netRtc', label: 'WebRTC', group: '网络与联机', desc: '取消后 P2P / 中继联机不可用', sizeImpact: 'medium', risk: 'safe', flags: ['module_webrtc_enabled'] },
  { id: 'netUpnp', label: 'UPnP 端口映射', group: '网络与联机', desc: '取消后不能自动映射端口', sizeImpact: 'tiny', risk: 'safe', flags: ['module_upnp_enabled'] },
  // ---- 界面与文字 ----
  { id: 'uiVShader', label: '可视化着色器（112 个类）', group: '界面与文字', desc: '取消后所有 VisualShaderNode* 消失', sizeImpact: 'medium', risk: 'notice', flags: ['module_visual_shader_enabled'] },
  { id: 'uiNoise', label: '噪声（FastNoiseLite 等）', group: '界面与文字', desc: '取消后 FastNoiseLite / NoiseTexture2D/3D 不可用', sizeImpact: 'small', risk: 'safe', flags: ['module_noise_enabled'] },
  { id: 'uiRegex', label: '正则（RegEx）', group: '界面与文字', desc: '取消后 RegEx 不可用', sizeImpact: 'small', risk: 'notice', flags: ['module_regex_enabled'] },
  { id: 'uiMsdf', label: 'MSDF 字体生成', group: '界面与文字', desc: '取消后 MSDF 位图字体不可用', sizeImpact: 'small', risk: 'notice', flags: ['module_msdfgen_enabled'] },
  { id: 'uiOpenxr', label: 'OpenXR 运行时接口（64 个类）', group: '界面与文字', desc: '取消后 OpenXR* 全消失', sizeImpact: 'medium', risk: 'safe', flags: ['module_openxr_enabled'] },
  { id: 'uiXrExtra', label: 'WebXR / Mobile VR', group: '界面与文字', desc: '取消后 WebXRInterface / MobileVRInterface 消失', sizeImpact: 'tiny', risk: 'safe', flags: ['module_webxr_enabled', 'module_mobile_vr_enabled'] },
  { id: 'uiCamera', label: '相机喂入（CameraFeed）', group: '界面与文字', desc: '取消后移动端相机源不可用', sizeImpact: 'tiny', risk: 'safe', flags: ['module_camera_enabled'] },
  { id: 'uiProfiler', label: 'ObjectDB 性能分析', group: '界面与文字', desc: '取消后 objectdb_profiler 不可用', sizeImpact: 'tiny', risk: 'safe', flags: ['module_objectdb_profiler_enabled'] },
  // ---- 编译选项 ----
  // 这一组不是"功能",是"构建取向",默认值方向不统一(见每项 src 注释)。它们的**初始勾选态
  // 由探测到的源码默认值决定**,不跟"默认全选"走 —— 否则"全量"预设会编出一个带调试符号、
  // 开着 d3d12/xaudio2 的模板。策划书 §5.3 就是为这条写的。
  { id: 'optDebugSymbols', label: '调试符号', group: '编译选项', desc: '打开会显著增大产物体积;官方模板不带', sizeImpact: 'large', risk: 'safe', flags: ['debug_symbols'] },              // SConstruct:178 默认 False
  { id: 'optLto', label: 'LTO 链接期优化', group: '编译选项', desc: '产物更小更快,但编译时间明显变长', sizeImpact: 'medium', risk: 'safe', flags: ['lto'] },                              // SConstruct:183 默认 "none"
  { id: 'optSize', label: '体积优先优化（-Os）', group: '编译选项', desc: '把 optimize 从 auto 切到 size', sizeImpact: 'medium', risk: 'safe', flags: ['optimize'] },                     // SConstruct:171-174
  { id: 'optProduction', label: '生产构建（production=yes）', group: '编译选项', desc: '一次性设定静态运行库/关调试符号/LTO auto', sizeImpact: 'medium', risk: 'safe', flags: ['production'] }, // SConstruct:186, :674-680
  { id: 'optDeprecated', label: '弃用 API 兼容层', group: '编译选项', desc: '取消后用了已移除 API 的脚本直接报错', sizeImpact: 'medium', risk: 'notice', flags: ['deprecated'] },          // SConstruct:190 默认 True
  { id: 'optPrecision', label: '双精度浮点', group: '编译选项', desc: '打开后更大更慢,一般游戏不需要', sizeImpact: 'medium', risk: 'notice', flags: ['precision'] },                      // SConstruct:192 默认 "single"
  { id: 'optMinizip', label: 'minizip（ZIP 支持）', group: '编译选项', desc: '取消后核心不带 zip', sizeImpact: 'tiny', risk: 'safe', flags: ['minizip'] },                                // SConstruct:194
  { id: 'optBrotli', label: 'Brotli / WOFF2 字体', group: '编译选项', desc: '取消后网页字体 woff2 解不了', sizeImpact: 'tiny', risk: 'notice', flags: ['brotli'] },                       // SConstruct:195
  { id: 'optStaticCpp', label: 'C++ 运行库静态链接', group: '编译选项', desc: '取消后产物需要 VC 运行库,目标机没装会起不来', sizeImpact: 'tiny', risk: 'notice', flags: ['use_static_cpp'] } // detect.py:229
]

/** @param {string} id @returns {TplFeature|null} */
function featureById(id) {
  return TPL_FEATURES.find((f) => f.id === id) || null
}

/** @param {TplFeature} f @returns {string[]} */
function flagsOf(f) {
  return (f && f.flags) || []
}

module.exports = { TPL_GROUPS, TPL_FEATURES, featureById, flagsOf }
