//! 能力表：面板上有什么功能、每项对应哪个 scons 变量。
//! 真源 = `src-ztools/preload/lib/tplfeatures.js`（那张表只管语义，不管「这份源码认不认」——
//! 后者由 probe.rs 探）。**本文件是 P0e-1 的空壳**，表体待 parity 先红再填。

/// 对应 tplfeatures.js:17 TplFeature
pub struct TplFeature {
    pub id: &'static str,
    pub label: &'static str,
    pub group: &'static str,
    pub desc: &'static str,
    /// large | medium | small | tiny | none
    pub size_impact: &'static str,
    /// safe | notice | danger
    pub risk: &'static str,
    pub flags: &'static [&'static str],
}

// 表体由 tplfeatures.js 逐格生成(2026-10-11,P0e-1),不手抄 —— 手抄 55 行中文文案必出错。
// 改 JS 那张表后重跑生成或直接看 tests/tpl_parity.rs 红:每一格(含顺序)都在逐字节对照里。

pub fn groups() -> &'static [&'static str] {
    &["渲染与显示", "引擎子系统", "资源格式", "音视频", "3D 资产与几何", "网络与联机", "界面与文字", "编译选项"]
}

pub fn features() -> &'static [TplFeature] {
    &[
        TplFeature { id: "vulkan", label: "Vulkan 渲染驱动", group: "渲染与显示", desc: "取消后 Forward Plus / Mobile 渲染法不可用", size_impact: "large", risk: "danger", flags: &["vulkan"] },
        TplFeature { id: "opengl3", label: "OpenGL / GLES3 驱动", group: "渲染与显示", desc: "取消后 Compatibility 渲染法不可用", size_impact: "medium", risk: "notice", flags: &["opengl3"] },
        TplFeature { id: "angle", label: "ANGLE（GLES3 over D3D11）", group: "渲染与显示", desc: "取消后 opengl3 少一条后端路径", size_impact: "medium", risk: "notice", flags: &["angle"] },
        TplFeature { id: "d3d12", label: "Direct3D 12 驱动", group: "渲染与显示", desc: "Windows 平台默认开(detect.py get_flags 覆盖 SConstruct:199 的 False);保留需本机装 D3D12 SDK,取消则发 d3d12=no", size_impact: "medium", risk: "notice", flags: &["d3d12"] },
        TplFeature { id: "accesskit", label: "AccessKit 无障碍驱动", group: "渲染与显示", desc: "取消后屏幕阅读器读不到界面", size_impact: "small", risk: "safe", flags: &["accesskit"] },
        TplFeature { id: "sdl", label: "SDL3 输入驱动", group: "渲染与显示", desc: "取消后手柄输入回落系统栈", size_impact: "small", risk: "safe", flags: &["sdl"] },
        TplFeature { id: "sys3d", label: "3D 节点与场景", group: "引擎子系统", desc: "取消后 Node3D/Camera3D/MeshInstance3D 等不可用", size_impact: "large", risk: "notice", flags: &["disable_3d"] },
        TplFeature { id: "phys3d", label: "3D 物理", group: "引擎子系统", desc: "取消后 3D 碰撞体与 RigidBody 不可用", size_impact: "medium", risk: "safe", flags: &["disable_physics_3d"] },
        TplFeature { id: "phys2d", label: "2D 物理", group: "引擎子系统", desc: "取消后 2D 碰撞体不可用", size_impact: "small", risk: "safe", flags: &["disable_physics_2d"] },
        TplFeature { id: "nav3d", label: "3D 导航", group: "引擎子系统", desc: "取消后 3D NavigationAgent/Region 不可用", size_impact: "medium", risk: "safe", flags: &["disable_navigation_3d"] },
        TplFeature { id: "nav2d", label: "2D 导航", group: "引擎子系统", desc: "取消后 2D NavigationAgent/Region 不可用", size_impact: "small", risk: "safe", flags: &["disable_navigation_2d"] },
        TplFeature { id: "xr", label: "XR 支持", group: "引擎子系统", desc: "取消后 XRInterface 相关不可用", size_impact: "medium", risk: "safe", flags: &["disable_xr"] },
        TplFeature { id: "advGui", label: "高级 GUI 节点与主题属性", group: "引擎子系统", desc: "取消后部分 Control 主题属性与富样式不可用", size_impact: "medium", risk: "notice", flags: &["disable_advanced_gui"] },
        TplFeature { id: "overrideCfg", label: "override.cfg 支持", group: "引擎子系统", desc: "取消后不能用 override.cfg 覆盖项目设置", size_impact: "tiny", risk: "safe", flags: &["disable_overrides"] },
        TplFeature { id: "fmtWebp", label: "WebP 图片", group: "资源格式", desc: "取消后 .webp 资源运行时加载不了", size_impact: "small", risk: "notice", flags: &["module_webp_enabled"] },
        TplFeature { id: "fmtJpg", label: "JPG 图片", group: "资源格式", desc: "取消后 .jpg 加载不了", size_impact: "small", risk: "notice", flags: &["module_jpg_enabled"] },
        TplFeature { id: "fmtRaster", label: "TGA / BMP / HDR 图片", group: "资源格式", desc: "取消后这三种格式加载不了", size_impact: "tiny", risk: "safe", flags: &["module_tga_enabled", "module_bmp_enabled", "module_hdr_enabled"] },
        TplFeature { id: "fmtCompressed", label: "压缩纹理（DDS/KTX/EXR/ASTC/BC/ETC/CVTT）", group: "资源格式", desc: "取消后对应压缩纹理加载不了", size_impact: "small", risk: "notice", flags: &["module_dds_enabled", "module_ktx_enabled", "module_tinyexr_enabled", "module_astcenc_enabled", "module_bcdec_enabled", "module_etcpak_enabled", "module_cvtt_enabled"] },
        TplFeature { id: "fmtSvg", label: "SVG 矢量纹理", group: "资源格式", desc: "取消后 .svg 加载不了", size_impact: "small", risk: "safe", flags: &["module_svg_enabled"] },
        TplFeature { id: "fmtZip", label: "ZIP 读写（ZIPReader/ZIPPacker）", group: "资源格式", desc: "取消后运行时读不了 zip 包", size_impact: "small", risk: "safe", flags: &["module_zip_enabled"] },
        TplFeature { id: "audOgg", label: "Ogg / Vorbis 音频", group: "音视频", desc: "取消后 .ogg 不能播 —— Godot 主力音频格式", size_impact: "small", risk: "notice", flags: &["module_vorbis_enabled", "module_ogg_enabled"] },
        TplFeature { id: "audMp3", label: "MP3 音频", group: "音视频", desc: "取消后 AudioStreamMP3 不可用", size_impact: "small", risk: "notice", flags: &["module_mp3_enabled"] },
        TplFeature { id: "audTheora", label: "Theora 视频", group: "音视频", desc: "取消后 VideoStreamTheora 不可用", size_impact: "small", risk: "safe", flags: &["module_theora_enabled"] },
        TplFeature { id: "audInteractive", label: "交互式音乐", group: "音视频", desc: "取消后 AudioStreamInteractive / Playlist / Synchronized 不可用", size_impact: "small", risk: "safe", flags: &["module_interactive_music_enabled"] },
        TplFeature { id: "a3Gltf", label: "glTF / GLB", group: "3D 资产与几何", desc: "取消后 GLTFDocument 等 21 个类消失", size_impact: "medium", risk: "notice", flags: &["module_gltf_enabled"] },
        TplFeature { id: "a3Fbx", label: "FBX 导入", group: "3D 资产与几何", desc: "取消后 .fbx 导入消失(模板侧本就少用)", size_impact: "small", risk: "safe", flags: &["module_fbx_enabled"] },
        TplFeature { id: "a3Csg", label: "CSG 构造几何", group: "3D 资产与几何", desc: "取消后 CSG*3D 节点不可用", size_impact: "small", risk: "safe", flags: &["module_csg_enabled"] },
        TplFeature { id: "a3Gridmap", label: "GridMap", group: "3D 资产与几何", desc: "取消后 GridMap 节点不可用", size_impact: "small", risk: "safe", flags: &["module_gridmap_enabled"] },
        TplFeature { id: "a3Jolt", label: "Jolt 物理后端", group: "3D 资产与几何", desc: "取消后项目设置里选不到 Jolt", size_impact: "medium", risk: "safe", flags: &["module_jolt_physics_enabled"] },
        TplFeature { id: "a3GodotPhys", label: "Godot 自带物理后端（2D+3D）", group: "3D 资产与几何", desc: "取消后只剩 Jolt;两者都关 = 没有物理", size_impact: "medium", risk: "danger", flags: &["module_godot_physics_2d_enabled", "module_godot_physics_3d_enabled"] },
        TplFeature { id: "a3Lightmap", label: "Lightmapper RD", group: "3D 资产与几何", desc: "取消后无法烘焙光照(烘焙发生在编辑器)", size_impact: "small", risk: "safe", flags: &["module_lightmapper_rd_enabled"] },
        TplFeature { id: "a3GeomTools", label: "网格工具（meshoptimizer/xatlas/vhacd/basis）", group: "3D 资产与几何", desc: "取消后网格压缩/展图/凸包/转码链断", size_impact: "small", risk: "safe", flags: &["module_meshoptimizer_enabled", "module_xatlas_unwrap_enabled", "module_vhacd_enabled", "module_basis_universal_enabled"] },
        TplFeature { id: "netMbedtls", label: "mbedTLS（HTTPS / TLS）", group: "网络与联机", desc: "取消后任何 HTTPS、加密连接、WebSocket 安全连接全断", size_impact: "small", risk: "danger", flags: &["module_mbedtls_enabled"] },
        TplFeature { id: "netEnet", label: "ENet", group: "网络与联机", desc: "取消后 ENetMultiplayerPeer 不可用", size_impact: "small", risk: "safe", flags: &["module_enet_enabled"] },
        TplFeature { id: "netMp", label: "高层多人", group: "网络与联机", desc: "取消后 MultiplayerSpawner / Synchronizer 不可用", size_impact: "small", risk: "safe", flags: &["module_multiplayer_enabled"] },
        TplFeature { id: "netWs", label: "WebSocket", group: "网络与联机", desc: "取消后 WebSocketPeer/Client/Server 不可用", size_impact: "small", risk: "safe", flags: &["module_websocket_enabled"] },
        TplFeature { id: "netRtc", label: "WebRTC", group: "网络与联机", desc: "取消后 P2P / 中继联机不可用", size_impact: "medium", risk: "safe", flags: &["module_webrtc_enabled"] },
        TplFeature { id: "netUpnp", label: "UPnP 端口映射", group: "网络与联机", desc: "取消后不能自动映射端口", size_impact: "tiny", risk: "safe", flags: &["module_upnp_enabled"] },
        TplFeature { id: "uiVShader", label: "可视化着色器（112 个类）", group: "界面与文字", desc: "取消后所有 VisualShaderNode* 消失", size_impact: "medium", risk: "notice", flags: &["module_visual_shader_enabled"] },
        TplFeature { id: "uiNoise", label: "噪声（FastNoiseLite 等）", group: "界面与文字", desc: "取消后 FastNoiseLite / NoiseTexture2D/3D 不可用", size_impact: "small", risk: "safe", flags: &["module_noise_enabled"] },
        TplFeature { id: "uiRegex", label: "正则（RegEx）", group: "界面与文字", desc: "取消后 RegEx 不可用", size_impact: "small", risk: "notice", flags: &["module_regex_enabled"] },
        TplFeature { id: "uiMsdf", label: "MSDF 字体生成", group: "界面与文字", desc: "取消后 MSDF 位图字体不可用", size_impact: "small", risk: "notice", flags: &["module_msdfgen_enabled"] },
        TplFeature { id: "uiOpenxr", label: "OpenXR 运行时接口（64 个类）", group: "界面与文字", desc: "取消后 OpenXR* 全消失", size_impact: "medium", risk: "safe", flags: &["module_openxr_enabled"] },
        TplFeature { id: "uiXrExtra", label: "WebXR / Mobile VR", group: "界面与文字", desc: "取消后 WebXRInterface / MobileVRInterface 消失", size_impact: "tiny", risk: "safe", flags: &["module_webxr_enabled", "module_mobile_vr_enabled"] },
        TplFeature { id: "uiCamera", label: "相机喂入（CameraFeed）", group: "界面与文字", desc: "取消后移动端相机源不可用", size_impact: "tiny", risk: "safe", flags: &["module_camera_enabled"] },
        TplFeature { id: "uiProfiler", label: "ObjectDB 性能分析", group: "界面与文字", desc: "取消后 objectdb_profiler 不可用", size_impact: "tiny", risk: "safe", flags: &["module_objectdb_profiler_enabled"] },
        TplFeature { id: "optDebugSymbols", label: "调试符号", group: "编译选项", desc: "打开会显著增大产物体积;官方模板不带", size_impact: "large", risk: "safe", flags: &["debug_symbols"] },
        TplFeature { id: "optLto", label: "LTO 链接期优化", group: "编译选项", desc: "产物更小更快,但编译时间明显变长", size_impact: "medium", risk: "safe", flags: &["lto"] },
        TplFeature { id: "optSize", label: "体积优先优化（-Os）", group: "编译选项", desc: "把 optimize 从 auto 切到 size", size_impact: "medium", risk: "safe", flags: &["optimize"] },
        TplFeature { id: "optProduction", label: "生产构建（production=yes）", group: "编译选项", desc: "一次性设定静态运行库/关调试符号/LTO auto", size_impact: "medium", risk: "safe", flags: &["production"] },
        TplFeature { id: "optDeprecated", label: "弃用 API 兼容层", group: "编译选项", desc: "取消后用了已移除 API 的脚本直接报错", size_impact: "medium", risk: "notice", flags: &["deprecated"] },
        TplFeature { id: "optPrecision", label: "双精度浮点", group: "编译选项", desc: "打开后更大更慢,一般游戏不需要", size_impact: "medium", risk: "notice", flags: &["precision"] },
        TplFeature { id: "optMinizip", label: "minizip（ZIP 支持）", group: "编译选项", desc: "取消后核心不带 zip", size_impact: "tiny", risk: "safe", flags: &["minizip"] },
        TplFeature { id: "optBrotli", label: "Brotli / WOFF2 字体", group: "编译选项", desc: "取消后网页字体 woff2 解不了", size_impact: "tiny", risk: "notice", flags: &["brotli"] },
        TplFeature { id: "optStaticCpp", label: "C++ 运行库静态链接", group: "编译选项", desc: "取消后产物需要 VC 运行库,目标机没装会起不来", size_impact: "tiny", risk: "notice", flags: &["use_static_cpp"] },
    ]
}