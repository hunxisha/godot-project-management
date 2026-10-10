//! 工具链检测与 scons 编译执行层（P0e-2）。
//!
//! 真源 = `src-ztools/preload/lib/buildtools.js`（571 行）。本文件分两半：
//!   · **纯函数面**（bat 正文 / scons 命令行 / 产物改名表 / vcvars 挑选顺序）—— 与 JS 逐字节对照，
//!     见 `tests/tpl_build_parity.rs`；
//!   · **本机状态面**（跑 `python`/`scons`/`vswhere`、盘剩余空间、起 cmd.exe）—— 两端不可能相同
//!     （装没装 VS 都不一样），由 `#[ignore]` 的真编译测试与 manual-verification.md 的真机条目管。
//!
//! bat 正文的两条铁律是从真机上换回来的，别“顺手现代化”：
//!   · **正文纯 ASCII**：cmd.exe 按 ANSI 码页（中文机 GBK）解析 .bat 字节，UTF-8 中文路径写进正文必花
//!     （真机：`cd` 花掉 → cwd 停在原处 → scons 报 No SConstruct）；
//!   · **四条路径全走 argv `%~1..%~4`**，手工包引号不行 —— node 会把内嵌引号转义成 `\"`，cmd 不认。

use regex::Regex;
use std::sync::OnceLock;

/// 对应 buildtools.js:129 TAR_EXE（Windows 自带 bsdtar，Win10 1803+，吃得动 .tar.xz）
pub const TAR_EXE: &str = "C:\\Windows\\System32\\tar.exe";

/// 对应 buildtools.js:126 VSWHERE
pub const VSWHERE: &str = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";

fn scons_version_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"SCons:\s*v([0-9]+(?:\.[0-9]+){0,2})").unwrap())
}

fn console_exe_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^godot\.windows\.template_release\.(.+?)\.console\.exe$").unwrap())
}

fn plain_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^godot\.windows\.template_release\.(.+?)\.(exe|lib|exp)$").unwrap())
}

/// 对应 buildtools.js:137 batBaseDir —— bat 路径是 `cmd /c` 后的**第一个 token**，
/// 带空格会被加引号，触发 cmd「四个引号以上剥首尾」的老规则把整条命令行吃坏；
/// 临时目录带空格时退到 C:\Windows\Temp（默认 ACL 普通用户可写）。其余路径走 argv，空格中文都安全。
pub fn bat_base_dir() -> std::path::PathBuf {
    let t = std::env::temp_dir();
    if t.to_string_lossy().contains(' ') {
        std::path::PathBuf::from("C:\\Windows\\Temp")
    } else {
        t
    }
}

/// 对应 buildtools.js:83 parseSconsVersion —— 版本号与构建哈希同用点分隔，只取纯数字的前两三段
pub fn parse_scons_version(text: &str) -> String {
    scons_version_re()
        .captures(text)
        .map(|c| c[1].to_string())
        .unwrap_or_default()
}

/// 对应 buildtools.js:101 的 `path.win32.join(dir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')`。
/// 固定反斜杠形态（真源注释：Linux 上 path.join 会拼出正斜杠，断言与语义都乱）。
fn win32_join(dir: &str, tail: &str) -> String {
    let d = dir.trim_end_matches('\\');
    if d.is_empty() {
        format!("\\{tail}")
    } else {
        format!("{d}\\{tail}")
    }
}

const VCVARS_TAIL: &str = "VC\\Auxiliary\\Build\\vcvars64.bat";

/// 对应 buildtools.js:98 pickVcvars —— vswhere 的输出优先，逐个候选拼 vcvars64.bat，第一个存在的赢。
/// 注意真源**不兜 `fallbacks` 为 null**（`for (const dir of null)` 直接 TypeError），
/// 所以这里收 `&[String]`：调用方必须给数组，测试第一版问过 `null` 那格，答案是「没有这个契约」。
pub fn pick_vcvars(vswhere_out: &str, fallbacks: &[String], exists: &dyn Fn(&str) -> bool) -> String {
    for line in vswhere_out.split('\n') {
        let dir = line.trim();
        if dir.is_empty() {
            continue;
        }
        let p = win32_join(dir, VCVARS_TAIL);
        if exists(&p) {
            return p;
        }
    }
    for dir in fallbacks {
        let p = win32_join(dir, VCVARS_TAIL);
        if exists(&p) {
            return p;
        }
    }
    String::new()
}

/// 对应 buildtools.js:117 mapTemplateFileName —— scons 产物名 → 官方 tpz 的模板文件名；非产物回 None
pub fn map_template_file_name(name: &str) -> Option<String> {
    if let Some(c) = console_exe_re().captures(name) {
        return Some(format!("windows_release_{}.console.exe", &c[1]));
    }
    if let Some(c) = plain_re().captures(name) {
        return Some(format!("windows_release_{}.{}", &c[1], &c[2]));
    }
    None
}

/// 对应 buildtools.js:142 vcvarsFallbackDirs —— 常见盘符 × 常见 SKU，顺序即真源三重循环的顺序
pub fn vcvars_fallback_dirs() -> Vec<String> {
    const ROOTS: [&str; 5] = ["C:", "D:", "E:", "D:\\apps", "E:\\apps"];
    const YEARS: [&str; 3] = ["2026", "2022", "2019"];
    const SKUS: [&str; 4] = ["Community", "BuildTools", "Professional", "Enterprise"];
    let mut out = Vec::with_capacity(ROOTS.len() * YEARS.len() * SKUS.len());
    for r in ROOTS {
        for y in YEARS {
            for s in SKUS {
                // 真源最后有一步 replace(/\\+/g,'\\')：盘符以反斜杠结尾时会拼出双斜杠
                out.push(format!("{r}\\Microsoft Visual Studio\\{y}\\{s}").replace("\\\\", "\\"));
            }
        }
    }
    out
}

/// 对应 buildtools.js:265 sconsLineFor —— 默认裸 `scons` 从 PATH 解析（与检测同口径）；
/// 检测走的是模块通道时改由 argv 第 4 位（`%~4`，检测缓存的解释器）起 `python -m SCons`。
pub fn scons_line_for(scons_via: &str, profile_path: &str, extras: &[String], jobs: u32) -> String {
    let head = if scons_via == "python" { "\"%~4\" -m SCons" } else { "scons" };
    let mut parts: Vec<String> = vec![
        head.to_string(),
        "platform=windows".to_string(),
        "target=template_release".to_string(),
        format!("build_profile=\"{profile_path}\""),
    ];
    parts.extend(extras.iter().cloned());
    parts.push(format!("-j{jobs}"));
    parts.join(" ")
}

/// 对应 buildtools.js:441-447 写进临时 .bat 的那五行（CRLF 连接）。
/// 守卫行用**相对** `exist`：cmd 在 `if exist` 里吃 `%~n\` 的后置反斜杠（真机实测），相对写法绕开。
/// 没有 profile 路径这个入参不是漏了：正文里只出现 `%~1..%~4` 占位，真路径走 argv 传（见文件头那条铁律）。
pub fn bat_text(scons_via: &str, extras: &[String], jobs: u32) -> String {
    [
        "@echo off".to_string(),
        "call \"%~2\"".to_string(),
        "cd /d \"%~1\"".to_string(),
        "if not exist SConstruct (echo ERROR: SConstruct not found in \"%~1\" after cd >&2 & exit /b 2)".to_string(),
        scons_line_for(scons_via, "%~3", extras, jobs),
    ]
    .join("\r\n")
}
