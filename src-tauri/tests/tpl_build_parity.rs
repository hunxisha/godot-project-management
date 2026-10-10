//! P0e-2 的纯函数面 parity：`buildtools.js` 里**不吃本机状态**的那几件事。
//!
//! 为什么只对照这一批：检测与编译的另一半要跑真子进程（`python --version` / `scons` / `vswhere`）、
//! 要读真盘的剩余空间、要真起 cmd.exe —— 那些是**本机状态**，两端不可能逐字节相同（装没装 VS 都不同）。
//! 那部分由 `#[ignore]` 的真编译集成测试与 manual-verification.md 的真机条目管。
//! 而下面这些是纯文本进、纯文本出，正是最容易两端各写一份然后悄悄分叉的地方：
//! bat 正文（a9e31e6 那条中文路径雷的修法）、scons 命令行、产物改名表、vcvars 挑选顺序。
use godot_workshop::tpl::build as b;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::process::Command;

/// harness 里的 bat 正文是 buildtools.js:441-447 的**镜像**；改了那边不同步这里就该红。
const BUILDTOOLS_GUARD: [&str; 4] = [
    "'@echo off',",
    "call \"%~2\"",
    "if not exist SConstruct (echo ERROR: SConstruct not found in \"%~1\" after cd >&2 & exit /b 2)",
    "].join('\\r\\n'), 'utf8')",
];

const JS_BUILD_HARNESS: &str = r###"
const fs = require('node:fs')
const path = require('node:path')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const T = require(path.join(cfg.repo, 'src-ztools/preload/lib/buildtools.js'))

// 镜像 buildtools.js:441-447（受 BUILDTOOLS_GUARD 约束）
function batText(sconsVia, profilePath, extras, jobs) {
  return [
    '@echo off',
    'call "%~2"',
    'cd /d "%~1"',
    'if not exist SConstruct (echo ERROR: SConstruct not found in "%~1" after cd >&2 & exit /b 2)',
    T.sconsLineFor({ sconsVia }, '%~3', extras, jobs)
  ].join('\r\n')
}

const exists = new Set(cfg.exists)
const has = (p) => exists.has(p)
const cases = {}
// 交**原值**不预先 stringify:两边都由测试侧统一编码一次,否则 JS 那侧多包一层引号,比的是编码不是内容
const put = (k, v) => { cases[k] = v }

put('sconsVersion', [
  T.parseSconsVersion('SCons by Steven Knight et al.:\n\tSCons: v4.10.1.055b01f93838b5143e29315664c8ed4a, Sat, 05 Apr 2025 14:44:52\n'),
  T.parseSconsVersion('SCons: v4.4'),
  T.parseSconsVersion('没有版本号的一行输出'),
  T.parseSconsVersion(''),
  T.parseSconsVersion(undefined)
])
put('vcvars', [
  T.pickVcvars('C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\r\nD:\\apps\\Microsoft Visual Studio\\2022\\BuildTools\r\n\r\n', [], has),
  T.pickVcvars('', ['D:\\nope', 'E:\\apps\\Microsoft Visual Studio\\2022\\Community'], has),
  T.pickVcvars('C:\\nothing\\here', ['C:\\also\\nothing'], has),
  T.pickVcvars(null, [], has)
])
put('mappedNames', ['godot.windows.template_release.x86_64.exe',
  'godot.windows.template_release.x86_64.console.exe',
  'godot.windows.template_release.x86_64.lib',
  'godot.windows.template_release.x86_64.exp',
  'godot.windows.editor.x86_64.exe',
  'README.md'].map(T.mapTemplateFileName))
put('fallbackDirs', T.vcvarsFallbackDirs())
put('sconsLine', [
  T.sconsLineFor({ sconsVia: 'path' }, '%~3', ['disable_3d=yes', 'optimize=size'], 16),
  T.sconsLineFor({ sconsVia: 'python' }, '%~3', [], 1),
  T.sconsLineFor({}, '%~3', ['modules_enabled_by_default=no'], 8)
])
put('bat', [
  batText('path', 'C:\\Windows\\Temp\\ztools-godot-profile-1.json', ['disable_3d=yes'], 16),
  batText('python', 'C:\\a b\\profile.json', [], 8)
])
put('tarExe', [T.TAR_EXE])
process.stdout.write(JSON.stringify({ cases }))
"###;

fn first_diff(a: &str, b: &str) -> String {
    if a == b {
        return "两串相同".to_string();
    }
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    let n = ab.len().min(bb.len());
    for i in 0..n {
        if ab[i] != bb[i] {
            let mut s = i.saturating_sub(28);
            while !a.is_char_boundary(s) {
                s += 1;
            }
            let mut ea = (i + 28).min(a.len());
            while !a.is_char_boundary(ea) {
                ea -= 1;
            }
            let mut eb = (i + 28).min(b.len());
            while !b.is_char_boundary(eb) {
                eb -= 1;
            }
            return format!("第 {i} 字节起不同:a={:?} b={:?}", &a[s..ea], &b[s..eb]);
        }
    }
    format!("前 {n} 字节相同但长度不同:a={} b={}", a.len(), b.len())
}

fn existing_vcvars() -> Vec<String> {
    vec![
        r"C:\nothing\here\VC\Auxiliary\Build\vcvars64.bat".into(),
        r"D:\apps\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat".into(),
        r"C:\also\nothing\VC\Auxiliary\Build\vcvars64.bat".into(),
    ]
}

fn rust_build_side() -> Value {
    let exists = existing_vcvars();
    let has = |p: &str| exists.iter().any(|e| e == p);
    json!({
        "sconsVersion": [
            b::parse_scons_version("SCons by Steven Knight et al.:\n\tSCons: v4.10.1.055b01f93838b5143e29315664c8ed4a, Sat, 05 Apr 2025 14:44:52\n"),
            b::parse_scons_version("SCons: v4.4"),
            b::parse_scons_version("没有版本号的一行输出"),
            b::parse_scons_version(""),
            b::parse_scons_version("")
        ],
        "vcvars": [
            b::pick_vcvars("C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\r\nD:\\apps\\Microsoft Visual Studio\\2022\\BuildTools\r\n\r\n", &[], &has),
            b::pick_vcvars("", &["D:\\nope".to_string(), "E:\\apps\\Microsoft Visual Studio\\2022\\Community".to_string()], &has),
            b::pick_vcvars("C:\\nothing\\here", &["C:\\also\\nothing".to_string()], &has),
            b::pick_vcvars("", &[], &has)
        ],
        "mappedNames": [
            b::map_template_file_name("godot.windows.template_release.x86_64.exe"),
            b::map_template_file_name("godot.windows.template_release.x86_64.console.exe"),
            b::map_template_file_name("godot.windows.template_release.x86_64.lib"),
            b::map_template_file_name("godot.windows.template_release.x86_64.exp"),
            b::map_template_file_name("godot.windows.editor.x86_64.exe"),
            b::map_template_file_name("README.md")
        ],
        "fallbackDirs": b::vcvars_fallback_dirs(),
        "sconsLine": [
            b::scons_line_for("path", "%~3", &["disable_3d=yes".into(), "optimize=size".into()], 16),
            b::scons_line_for("python", "%~3", &[], 1),
            b::scons_line_for("", "%~3", &["modules_enabled_by_default=no".into()], 8)
        ],
        "bat": [
            b::bat_text("path", &["disable_3d=yes".into()], 16),
            b::bat_text("python", &[], 8)
        ],
        "tarExe": [b::TAR_EXE]
    })
}

#[test]
fn tpl_build_pure_functions_are_byte_identical() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let src = fs::read_to_string(repo.join("src-ztools/preload/lib/buildtools.js")).unwrap();
    for line in BUILDTOOLS_GUARD.iter() {
        assert!(src.contains(line), "buildtools.js 改了,但 harness 镜像没同步:缺 {line:?}");
    }

    let base = std::env::temp_dir().join(format!("gpm-tpl-build-parity-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let script = base.join("js-build.js");
    let cfg_file = base.join("js-cfg.json");
    fs::write(&cfg_file, json!({ "repo": repo, "exists": existing_vcvars() }).to_string()).unwrap();
    fs::write(&script, JS_BUILD_HARNESS).unwrap();

    let js: Value = match Command::new("node").arg(&script).arg(&cfg_file).output() {
        Err(e) => panic!("环境里找不到 node({e})—— 按失败处理,不静默跳过"),
        Ok(out) => {
            if !out.status.success() {
                panic!("JS build harness 退出非零:{}", String::from_utf8_lossy(&out.stderr));
            }
            serde_json::from_slice(&out.stdout).expect("JS 侧输出的是 JSON")
        }
    };

    let rs = rust_build_side();
    let jc = js["cases"].as_object().unwrap();
    let mut names: Vec<&String> = jc.keys().collect();
    names.sort();
    assert_eq!(names.len(), 7, "纯函数用例少于 7 组,说明有组被删了");
    for n in &names {
        let j = serde_json::to_string(&jc[*n]).unwrap();
        let r = serde_json::to_string(rs.get(*n).unwrap_or(&Value::Null)).unwrap();
        assert_eq!(j, r, "纯函数组 {n} 两端不一致 → {}", first_diff(&j, &r));
    }
    println!("  构建层纯函数 parity OK:7 组逐字节相同");
    let _ = fs::remove_dir_all(&base);
}
