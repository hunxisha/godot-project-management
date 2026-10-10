//! 探测层：对着用户那份源码树回答「这个开关存不存在、它的默认值是什么」。
//!
//! 真源 = `src-ztools/preload/lib/tplprobe.js`。正则**逐字照搬** JS 那几条
//! （`VAR_DECL` / `IS_ENABLED` / 连带块 / `version.py` / `get_flags`），只在两处把语义钉回 ASCII：
//!   · `\d` → `[0-9]`：JS 的 `\d` 只认 ASCII 数字，Rust 的默认按 Unicode Nd 走（会出现阿拉伯数字
//!     被当成版本号的错判）；
//!   · `\b` → `(?-u:\b)`：同理，JS 的词字符是 `[A-Za-z0-9_]`。
//! `\s` **不钉**：JS 的 `\s` 含 NBSP 等空白，Rust 的 Unicode `\s` 与它几乎同集，钉成 ASCII 反而更远。
//! （整条包 `(?-u:)` 试过不行：`[^"\\]` 在字节模式下可匹配非法 UTF-8，编译期就拒。）
//! 两端逐字节对照由 `tests/tpl_parity.rs` 拿真源码树（`tests/fixtures/tplsrc`，来源见其 MANIFEST.md）盯着。

use regex::Regex;
use serde_json::{Map, Value};
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

/// 对应 tplprobe.js:16 VAR_DECL
fn var_decl() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r###"(?:Bool|Enum)Variable\(\s*["']([a-z0-9_]+)["']\s*,\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,\s*(True|False|"([^"]*)"|'([^']*)'|[0-9]+)"###,
        )
        .unwrap()
    })
}

/// 对应 tplprobe.js:51 IS_ENABLED
fn is_enabled_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r###"def\s+is_enabled\s*\(\s*\)\s*:\s*(?:#[^\n]*\n\s*)?return\s+(True|False)(?-u:\b)"###).unwrap()
    })
}

/// 对应 tplprobe.js:132 的顶格 `if env["x"]:` 头
fn cascade_head() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r###"^if\s+env\["([a-z0-9_]+)"\]:\s*$"###).unwrap())
}

/// 对应 tplprobe.js:141 的块内赋值 `env["y"] = True`
fn cascade_assign() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r###"^[ \t]+env\["([a-z0-9_]+)"\]\s*=\s*True\s*$"###).unwrap())
}

/// 对应 tplprobe.js:165 的数字字段
fn version_num() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r###"(?m)^\s*(major|minor|patch)\s*=\s*([0-9]+)\s*$"###).unwrap())
}

/// 对应 tplprobe.js:166 的 status 字段
fn version_status() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r###"(?m)^\s*status\s*=\s*["']([^"']+)["']\s*$"###).unwrap())
}

/// 对应 tplprobe.js:238 的 get_flags 体里的布尔键
fn flag_pair() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r###""([a-z0-9_]+)":\s*(True|False)"###).unwrap())
}

/// 对应 tplprobe.js:79 MODULE_MARKERS（methods.py:302-309 的原文判据，少一件就不是模块）
const MODULE_MARKERS: [&str; 3] = ["register_types.h", "SCsub", "config.py"];

/// 对应 tplprobe.js:188 TESTED_VERSIONS（只放真编译过并核对过产物的版本）
const TESTED_VERSIONS: [&str; 1] = ["4.7.2-stable"];

/// 对应 tplprobe.js:200 PLATFORM_BUILD_SCRIPTS（P0 恒为 platform=windows）
const PLATFORM_BUILD_SCRIPTS: [&str; 1] = ["platform/windows/detect.py"];

/// 对应 tplprobe.js:38 decodeDefault
fn decode_default(raw: &str, dq: Option<&str>, sq: Option<&str>) -> Value {
    match raw {
        "True" => Value::Bool(true),
        "False" => Value::Bool(false),
        _ => Value::String(dq.or(sq).unwrap_or(raw).to_string()),
    }
}

/// 对应 tplprobe.js:24 parseSconsOptions —— 同名只取**第一次**出现
pub fn parse_scons_options(text: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for c in var_decl().captures_iter(text) {
        let name = c[1].to_string();
        if out.contains_key(&name) {
            continue;
        }
        let mut m = Map::new();
        m.insert("exists".to_string(), Value::Bool(true));
        m.insert(
            "default".to_string(),
            decode_default(&c[2].to_string(), c.get(3).map(|m| m.as_str()), c.get(4).map(|m| m.as_str())),
        );
        out.insert(name, Value::Object(m));
    }
    out
}

/// 对应 tplprobe.js:70 parseIsEnabled —— 没有 `is_enabled()` 就是 True
pub fn parse_is_enabled(config_text: &str) -> bool {
    match is_enabled_re().captures(config_text) {
        None => true,
        Some(c) => &c[1] == "True",
    }
}

/// 对应 tplprobe.js:127 parseCascades（出块判据用缩进，所以 if/else 嵌套也能走完）
pub fn parse_cascades(text: &str) -> Map<String, Value> {
    let mut out = Map::new();
    // 真源是 `split(/\r?\n/)`：先按 \n 切再剥行尾 \r，CRLF 检出（无 .gitattributes 时 Windows
    // 上 git 可能这么给）才不会把顶格判据整条读歪
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    for i in 0..lines.len() {
        let Some(head) = cascade_head().captures(lines[i]) else { continue };
        let src = head[1].to_string();
        let mut targets: Vec<String> = Vec::new();
        for line in lines.iter().skip(i + 1) {
            if line.trim().is_empty() {
                continue;
            }
            if !line.starts_with(' ') && !line.starts_with('\t') {
                break; // 回到顶格 = 出块
            }
            if let Some(a) = cascade_assign().captures(line) {
                let t = &a[1];
                if t != src && !targets.iter().any(|x| x == t) {
                    targets.push(t.to_string());
                }
            }
        }
        if !targets.is_empty() {
            out.insert(src, Value::Array(targets.into_iter().map(Value::String).collect()));
        }
    }
    out
}

/// 对应 tplprobe.js:162 parseVersionPy —— 缺任一字段返回空串，猜一个「看起来对」的串比承认读不出更糟
pub fn parse_version_py(text: &str) -> String {
    let mut major = String::new();
    let mut minor = String::new();
    let mut patch = String::new();
    for c in version_num().captures_iter(text) {
        match &c[1] {
            "major" if major.is_empty() => major = c[2].to_string(),
            "minor" if minor.is_empty() => minor = c[2].to_string(),
            "patch" if patch.is_empty() => patch = c[2].to_string(),
            _ => {}
        }
    }
    let Some(st) = version_status().captures(text).map(|c| c[1].to_string()) else {
        return String::new();
    };
    if major.is_empty() || minor.is_empty() || patch.is_empty() {
        return String::new();
    }
    // patch 为 0 不进版本串:这是官方形态(tag 4.3-stable 的 version.py 就是 patch = 0 而对外串是 4.3-stable)
    if patch == "0" {
        format!("{major}.{minor}-{st}")
    } else {
        format!("{major}.{minor}.{patch}-{st}")
    }
}

/// 对应 tplprobe.js:182 versionStringFromTag
pub fn version_string_from_tag(tag: &str) -> String {
    tag.trim().to_string()
}

/// 对应 tplprobe.js:230 parsePlatformFlags（只认 get_flags 函数体里的布尔键，其余不猜）
pub fn parse_platform_flags(detect_text: &str) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(at) = detect_text.find("def get_flags():") else {
        return out;
    };
    let body = match detect_text[at + 1..].find("\ndef ") {
        Some(rel) => &detect_text[at..at + 1 + rel],
        None => &detect_text[at..],
    };
    for c in flag_pair().captures_iter(body) {
        out.insert(c[1].to_string(), Value::Bool(&c[2] == "True"));
    }
    out
}

/// 对应 tplprobe.js:216 mergeOptionsFirstWins —— 同名先到先得，后出现的**不覆盖**
fn merge_first_wins(target: &mut Map<String, Value>, extra: Map<String, Value>) {
    for (k, v) in extra {
        target.entry(k).or_insert(v);
    }
}

/// 对应 tplprobe.js:91 detectBuiltinModules（键一律 `module_<目录名>_enabled`，没有名字翻译层）
fn detect_builtin_modules(src_dir: &Path) -> Map<String, Value> {
    let mut out = Map::new();
    let rd = match fs::read_dir(src_dir.join("modules")) {
        Ok(rd) => rd,
        Err(_) => return out, // JS 侧 try/catch 后交空表
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name.starts_with('.') {
            continue; // methods.py:273 的 glob("*") 天然不匹配点开头
        }
        let base = src_dir.join("modules").join(&name);
        if !MODULE_MARKERS.iter().all(|f| base.join(f).exists()) {
            continue; // 少一件就不是模块，给它生成开关是在猜
        }
        let key = format!("module_{name}_enabled");
        if out.contains_key(&key) {
            continue;
        }
        let cfg = read_opt(&base.join("config.py"));
        let mut m = Map::new();
        m.insert("exists".to_string(), Value::Bool(true));
        m.insert("default".to_string(), Value::Bool(parse_is_enabled(&cfg)));
        out.insert(key, Value::Object(m));
    }
    out
}

/// 对应 tplprobe.js:275 readOpt —— 读不到（不存在/被占用/是目录）一律给空串，不抛
fn read_opt(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

/// 对应 tplprobe.js:255 probeSource —— 键序与 JS 的返回对象字面量逐格对齐（`:268`）
pub fn probe_source(src_dir: &Path, target_tag: Option<&str>) -> Value {
    let mut options = Map::new();
    let result = |ok: bool, error: String, source_version: String, tested: bool, tag_matched: bool, options: Map<String, Value>, cascades: Map<String, Value>| {
        let mut m = Map::new();
        m.insert("ok".to_string(), Value::Bool(ok));
        m.insert("error".to_string(), Value::String(error));
        m.insert("sourceVersion".to_string(), Value::String(source_version));
        m.insert("tested".to_string(), Value::Bool(tested));
        m.insert("tagMatched".to_string(), Value::Bool(tag_matched));
        m.insert("options".to_string(), Value::Object(options));
        m.insert("cascades".to_string(), Value::Object(cascades));
        m.insert(
            "testedVersions".to_string(),
            Value::Array(TESTED_VERSIONS.iter().map(|v| Value::String(v.to_string())).collect()),
        );
        Value::Object(m)
    };

    // SConstruct 是「这是不是 Godot 源码根」的唯一判据
    if src_dir.as_os_str().is_empty() || !src_dir.join("SConstruct").exists() {
        return result(
            false,
            "所选目录不是 Godot 源码根(缺 SConstruct),无法探测构建选项".to_string(),
            String::new(),
            false,
            false,
            options,
            Map::new(),
        );
    }

    let sc = read_opt(&src_dir.join("SConstruct"));
    merge_first_wins(&mut options, parse_scons_options(&sc));
    for rel in PLATFORM_BUILD_SCRIPTS {
        merge_first_wins(&mut options, parse_scons_options(&read_opt(&src_dir.join(rel))));
    }
    merge_first_wins(&mut options, detect_builtin_modules(src_dir));

    // 平台覆盖层最后盖：只盖两边都声明了的键，未声明的不凭空造
    let detect_rel = Path::new("platform").join("windows").join("detect.py");
    let platform_flags = parse_platform_flags(&read_opt(&src_dir.join(detect_rel)));
    for (k, v) in platform_flags {
        if let Some(slot) = options.get_mut(&k) {
            if slot.get("exists").and_then(|e| e.as_bool()).unwrap_or(false) {
                let mut m = Map::new();
                m.insert("exists".to_string(), Value::Bool(true));
                m.insert("default".to_string(), v);
                *slot = Value::Object(m);
            }
        }
    }

    let cascades = parse_cascades(&sc);
    let source_version = parse_version_py(&read_opt(&src_dir.join("version.py")));
    let tested = TESTED_VERSIONS.contains(&source_version.as_str());
    // 没带 targetTag 就不算 tagMatched：无条件置 true 等于谎报「版本对得上」
    let tag_matched = match target_tag {
        Some(t) if !t.is_empty() => source_version == version_string_from_tag(t),
        _ => false,
    };
    result(true, String::new(), source_version, tested, tag_matched, options, cascades)
}
