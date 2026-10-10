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

/// 第六轮：代下载源码的**前置六闸**与 URL/路径拼装（`tplsource.js:28-89` ↔ `tpl/source.rs`）。
/// 闸的顺序与文案都是用户看得见的东西，抽成纯函数就是为了能两端逐字比，而不是靠人抄写。
const JS_SOURCE_HARNESS: &str = r###"
const fs = require('node:fs')
const path = require('node:path')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const S = require(path.join(cfg.repo, 'src-ztools/preload/lib/tplsource.js'))

// 镜像 tplsource.js:71-89 的前置段（受 SOURCE_GUARD 约束）；三个 *_exists 与 active 由入参喂
function precheck(tagRaw, destRaw, destExists, tarExists, active, topExists) {
  const tag = String(tagRaw || '').trim()
  const destDir = String(destRaw || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
    return { ok: false, error: `tag 形态不合法(只认字母数字与 . _ -):${tag}` }
  }
  if (!destDir) return { ok: false, error: '未指定下载父目录' }
  if (!destExists) return { ok: false, error: `下载父目录不存在:${destDir}` }
  if (!tarExists) {
    return { ok: false, error: '未找到 System32\\tar.exe,无法解包源码包。请手动准备源码目录。' }
  }
  if (active) return { ok: false, error: '已有代下载在途,先取消或等它完成,再发起新的。' }
  const top = path.join(destDir, `godot-${tag}`)
  if (topExists) return { ok: false, error: `目标目录已存在:${top}。请先移除它或换一个父目录(不覆盖既有目录)。` }
  return { ok: true }
}
// 镜像 tplsource.js:116-121 的旁证解析
function sidecarExpect(text) {
  const expect = (String(text).trim().split(/\s+/)[0] || '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(expect) ? expect : ''
}

const cases = { urls: [], tags: [], sidecar: [], pre: [] }
for (const t of ['4.7.2-stable', '4.3-stable', '4.7.1-rc1']) cases.urls.push(S.sourceUrls(t))
for (const t of ['4.7.2-stable', '4.3', 'a_b-c.1', '', '-4.7', 'v4.7.2', '4.7 2', '4.7/..', '4.7\n', 'X9']) {
  const s = String(t || '').trim()
  cases.tags.push([s, /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)])
}
for (const s of ['  AB12  rest\nmore', 'a'.repeat(64), ('A'.repeat(64)) + '  x', 'short 1', '', '   ', 'z'.repeat(64), 'ab'.repeat(32)]) {
  cases.sidecar.push(sidecarExpect(s))
}
for (const p of cfg.pres) {
  cases.pre.push(precheck(p.tag, p.dest, p.destExists, p.tarExists, p.active, p.topExists))
}
process.stdout.write(JSON.stringify(cases))
"###;

const SOURCE_GUARD: [&str; 4] = [
    "if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {",
    "if (!destDir) return { ok: false, error: '未指定下载父目录' }",
    "if (active) return { ok: false, error: '已有代下载在途,先取消或等它完成,再发起新的。' }",
    "return { ok: false, error: `目标目录已存在:${top}。请先移除它或换一个父目录(不覆盖既有目录)。` }",
];

#[test]
fn tpl_source_gates_urls_and_sidecar_match_js() {
    use godot_workshop::tpl::source as s;
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let js_src = fs::read_to_string(repo.join("src-ztools/preload/lib/tplsource.js")).unwrap();
    for line in SOURCE_GUARD.iter() {
        assert!(js_src.contains(line), "tplsource.js 的前置段改了,harness 镜像没同步:缺 {line:?}");
    }

    let dest = "D:\\dl";
    type Pre = (&'static str, &'static str, bool, bool, bool, bool);
    let pres: Vec<Pre> = vec![
        ("4.7.2-stable", dest, true, true, false, false),
        ("  4.7.2-stable  ", dest, true, true, false, false),
        ("-4.7", dest, true, true, false, false),
        ("4.7/..", dest, true, true, false, false),
        ("4.7 2", dest, true, true, false, false),
        ("", dest, true, true, false, false),
        ("4.7.2-stable", "   ", true, true, false, false),
        ("4.7.2-stable", dest, false, true, false, false),
        ("4.7.2-stable", dest, true, false, false, false),
        ("4.7.2-stable", dest, true, true, true, false),
        ("4.7.2-stable", dest, true, true, false, true),
        // 顺序也钉:全坏时先报 tag,不是从一串里挑一个响
        ("-x", "", false, false, true, true),
    ];
    let cfg_pres: Vec<Value> = pres.iter().map(|(t, d, de, te, a, te2)| {
        json!({ "tag": t, "dest": d, "destExists": de, "tarExists": te, "active": a, "topExists": te2 })
    }).collect();

    let base = std::env::temp_dir().join(format!("gpm-tpl-src-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let script = base.join("js-source.js");
    let cfg_file = base.join("js-cfg.json");
    fs::write(&cfg_file, json!({ "repo": repo, "pres": cfg_pres }).to_string()).unwrap();
    fs::write(&script, JS_SOURCE_HARNESS).unwrap();

    let js: Value = match Command::new("node").arg(&script).arg(&cfg_file).output() {
        Err(e) => panic!("环境里找不到 node({e})—— 按失败处理,不静默跳过"),
        Ok(out) => {
            assert!(out.status.success(), "JS source harness 退出非零:{}", String::from_utf8_lossy(&out.stderr));
            serde_json::from_slice(&out.stdout).expect("JS 侧输出的是 JSON")
        }
    };
    let _ = fs::remove_dir_all(&base);

    // 1) 前置六闸:文案与先后逐字比
    let rs_pre: Vec<Value> = pres.iter().map(|(t, d, de, te, a, te2)| {
        let tag = t.trim();
        let top = Path::new(d).join(format!("godot-{tag}"));
        s::precheck(tag, d.trim(), *de, *te, *a, *te2, &top.to_string_lossy()).unwrap_or(json!({ "ok": true }))
    }).collect();
    assert_eq!(js["pre"], Value::Array(rs_pre), "前置六闸的文案或顺序两端不一致");
    assert_eq!(js["pre"].as_array().map(|v| v.len()), Some(12), "六闸用例数变了要重看覆盖");

    // 2) sourceUrls
    let rs_urls: Vec<Value> = ["4.7.2-stable", "4.3-stable", "4.7.1-rc1"].iter().map(|t| {
        let (a, b) = s::source_urls(t);
        json!({ "asset": a, "sidecar": b })
    }).collect();
    assert_eq!(js["urls"], Value::Array(rs_urls), "sourceUrls 两端不一致");

    // 3) tag 形态闸(含空串、前导非字母数字、空格、路径穿越、换行)
    let rs_tags: Vec<Value> = ["4.7.2-stable", "4.3", "a_b-c.1", "", "-4.7", "v4.7.2", "4.7 2", "4.7/..", "4.7\n", "X9"]
        .iter().map(|t| {
            let s2 = t.trim();
            json!([s2, s::tag_ok(s2)])
        }).collect();
    assert_eq!(js["tags"], Value::Array(rs_tags), "tag 形态闸两端不一致");

    // 4) 旁证解析(64 位十六进制才算,大小写归一,取首段)
    let sides: Vec<String> = vec![
        "  AB12  rest\nmore".to_string(),
        "a".repeat(64),
        format!("{}  x", "A".repeat(64)),
        "short 1".to_string(),
        String::new(),
        "   ".to_string(),
        "z".repeat(64),
        "ab".repeat(32),
    ];
    let rs_side: Vec<Value> = sides.iter().map(|t| json!(s::sidecar_expect(t))).collect();
    assert_eq!(js["sidecar"], Value::Array(rs_side), "旁证解析两端不一致");

    println!("  代下载 parity OK:六闸 12 例 + URL 3 例 + tag 10 例 + 旁证 8 例逐字相同");
}
