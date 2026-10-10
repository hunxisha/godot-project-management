//! 勾选 + 探测结果 → feature build profile 与 scons 命令行键。
//!
//! 真源 = `src-ztools/preload/lib/tplprofile.js`（675 行，纯函数、不碰 IO）。
//! 本文件按**语义镜像**移植：每条判据都点名它抄的是哪一段，两端逐字节对照由
//! `tests/tpl_parity.rs` 常驻盯着（`docs/tplrust-plan.md` §0 第 1 拍）。
//!
//! 三条不能走样的规矩：
//!   · **通道只认前缀**（Ruling #38，真源 `:117`）：`module_*_enabled` 进 profile，其余一律进命令行；
//!   · **与源码默认相同就不输出**（Ruling #36，真源 `:249-267`）：差值规则，两个通道都成立；
//!   · **探测不到就不猜**（真源 `:228-231`）：未探到的 flag 只记 skipped，一个通道都不写。

use crate::tpl::features::features;
use serde_json::{Map, Value};

/// 对应 tplprofile.js buildProfile() 的返回体（四件产物，顺序与键名都进 parity 对照）。
pub struct ProfileResult {
    pub json: Value,
    pub written: Vec<String>,
    pub skipped: Vec<Value>,
    pub command_extras: Vec<String>,
}

/// 对应 tplprofile.js:72 ENUM_VALUES（`off` 必须逐字等于该 EnumVariable 在 4.7.2 里的默认值）
const ENUM_VALUES: [(&str, &str, &str); 3] = [
    ("lto", "auto", "none"),
    ("optimize", "size", "auto"),
    ("precision", "double", "single"),
];

/// 对应 tplprofile.js:85 MODE_COMMAND_FLAGS（目前只有一条，且只在 default-off 下发）
const MODE_COMMAND_FLAGS: [(&str, bool, &str); 1] =
    [("modules_enabled_by_default", false, "default-off")];

/// 对应 tplprofile.js:315 LITE2D_OFF_IDS
const LITE2D_OFF_IDS: [&str; 3] = ["sys3d", "accesskit", "d3d12"];

/// 对应 tplprofile.js:329 MINIMAL_OFF 的 id 列（顺序即真源顺序）
const MINIMAL_OFF_IDS: [&str; 7] = [
    "sys3d",
    "advGui",
    "phys2d",
    "phys3d",
    "optDeprecated",
    "optMinizip",
    "optBrotli",
];

/// JS 的 `!!v`：null/false/0/"" 为假，其余（含空数组与非 ASCII 串）为真。
/// 这里只会被 `selection[id]` 与 `option.default` 喂进来，两者都不会碰到数组/对象。
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// 对应 tplprofile.js:98 isNegatedFlag
fn is_negated_flag(flag: &str) -> bool {
    flag.starts_with("disable_")
}

/// 对应 tplprofile.js:103 isModuleFlag（正则 `^module_.*_enabled$`）。
/// 用 strip_prefix 而不是「前缀 + 后缀」两个 starts/ends 拼：`module_enabled` 这种裸名
/// 在正则下不成立，而双 ends_with 会把它算成模块开关 —— 真源 `:112-114` 专门警告过这点。
fn is_module_flag(flag: &str) -> bool {
    match flag.strip_prefix("module_") {
        Some(rest) => rest.ends_with("_enabled"),
        None => false,
    }
}

/// 对应 tplprofile.js:117 goesToProfile（Ruling #38 的唯一通道判据）
fn goes_to_profile(flag: &str) -> bool {
    is_module_flag(flag)
}

/// 对应 tplprofile.js:91 sconsToken
fn scons_token(flag: &str, value: &Value) -> String {
    match value {
        Value::Bool(true) => format!("{flag}=yes"),
        Value::Bool(false) => format!("{flag}=no"),
        Value::String(s) => format!("{flag}={s}"),
        other => format!("{flag}={other}"),
    }
}

/// 对应 tplprofile.js:135 isOnByDefault —— **三态**：开 / 关 / 未知（None）。
/// 未知不当 false 用：判据只留一处，写成两处守卫后其中一条永远够不着（真源注释数过 6 条恒真断言）。
fn is_on_by_default(flag: &str, o: Option<&Value>) -> Option<bool> {
    let o = o?;
    if !truthy(o.get("exists").unwrap_or(&Value::Null)) {
        return None;
    }
    let default = o.get("default")?;
    if let Some(s) = default.as_str() {
        // 认不出的枚举:不知道哪个取值算「开」→ 未知,不猜
        let off = match enum_table(flag) {
            Some((_, _, off)) => off,
            None => return None,
        };
        return Some(s != off);
    }
    Some(default == &Value::Bool(true))
}

/// 对应 tplprofile.js:151 featureKeptByDefault（未知在两个方向上都返回 false —— 不猜）
fn feature_kept_by_default(flag: &str, o: Option<&Value>) -> bool {
    match is_on_by_default(flag, o) {
        None => false,
        Some(st) => {
            if is_negated_flag(flag) {
                !st
            } else {
                st
            }
        }
    }
}

fn enum_table(flag: &str) -> Option<(&'static str, &'static str, &'static str)> {
    ENUM_VALUES.iter().find(|(k, _, _)| *k == flag).copied()
}

/// 对应 tplprofile.js:179 initialSelection(options)
/// 只对**探到的** flag 求值；一个都没探到才给 false（Ruling #57）。options 整体缺失与「什么都没探到」同形。
pub fn initial_selection(options: &Value) -> Value {
    let src = options.as_object().cloned().unwrap_or_default();
    let mut sel = Map::new();
    for f in features() {
        let probed: Vec<&str> = f
            .flags
            .iter()
            .copied()
            .filter(|k| src.get(*k).is_some_and(|o| truthy(o.get("exists").unwrap_or(&Value::Null))))
            .collect();
        let on = !probed.is_empty()
            && probed
                .iter()
                .all(|k| feature_kept_by_default(k, src.get(*k)));
        sel.insert(f.id.to_string(), Value::Bool(on));
    }
    Value::Object(sel)
}

/// 对应 tplprofile.js:256 desiredValue —— `None` 即真源那个 `SAME_AS_SOURCE` 哨兵（不输出）。
fn desired_value(flag: &str, source_default: &Value, keep: bool, mode: &str) -> Option<Value> {
    if mode == "default-off" && is_module_flag(flag) {
        // 反向白名单已让「模块默认 = 关」，所以比的是有效默认：保留 → 显式点名 true；没保留 → 不写。
        return if keep { Some(Value::Bool(true)) } else { None };
    }
    let on_value = if is_negated_flag(flag) { !keep } else { keep };
    if let Some(s) = source_default.as_str() {
        let (_, on, off) = enum_table(flag)?;
        let want = if on_value { on } else { off };
        return if want == s { None } else { Some(Value::String(want.to_string())) };
    }
    if on_value == truthy(source_default) {
        None
    } else {
        Some(Value::Bool(on_value))
    }
}

/// 对应 tplprofile.js:284 sortKeys（**只排这一层**，值都是标量，无需递归）
fn sort_keys(obj: Map<String, Value>) -> Map<String, Value> {
    let mut keys: Vec<&String> = obj.keys().collect();
    keys.sort();
    let mut out = Map::new();
    for k in keys {
        out.insert(k.clone(), obj[k].clone());
    }
    out
}

/// 对应 tplprofile.js:198 buildProfile(selection, options, {mode})
pub fn build_profile(selection: &Value, options: &Value, mode: &str) -> ProfileResult {
    let mode = if mode.is_empty() { "default-on" } else { mode };
    let sel = selection.as_object().cloned().unwrap_or_default();
    let src = options.as_object().cloned().unwrap_or_default();
    let mut dbo: Map<String, Value> = Map::new();
    let mut cmd: Map<String, Value> = Map::new();
    let mut written: Vec<String> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();

    for (flag, value, only_mode) in MODE_COMMAND_FLAGS.iter() {
        if !only_mode.is_empty() && *only_mode != mode {
            continue;
        }
        cmd.insert((*flag).to_string(), Value::Bool(*value));
        written.push((*flag).to_string());
    }

    for f in features() {
        if !sel.contains_key(f.id) {
            // 面板没给这一项的勾选态：按源码默认什么都不写（宁缺勿错），而不是当成「用户取消了它」
            for flag in f.flags {
                skipped.push(json_skip(flag, &format!("面板未提供 {} 的勾选态,按源码默认不写(宁缺勿错)", f.id)));
            }
            continue;
        }
        let keep = truthy(sel.get(f.id).unwrap_or(&Value::Null));
        for flag in f.flags {
            let o = match src.get(*flag) {
                Some(o) if truthy(o.get("exists").unwrap_or(&Value::Null)) => o,
                _ => {
                    skipped.push(json_skip(
                        flag,
                        "此版本源码未探到该开关,两个通道都不写(未声明的 scons 变量是静默失效的)",
                    ));
                    continue;
                }
            };
            let want = match desired_value(flag, o.get("default").unwrap_or(&Value::Null), keep, mode) {
                None => continue,
                Some(v) => v,
            };
            if goes_to_profile(flag) {
                dbo.insert((*flag).to_string(), want);
            } else {
                cmd.insert((*flag).to_string(), want);
            }
            written.push((*flag).to_string());
        }
    }

    // 命令行通道按 flag 名字典序生成 token —— 同一个键不因来源或勾选顺序落到不同位置由构造保证
    let mut cmd_keys: Vec<&String> = cmd.keys().collect();
    cmd_keys.sort();
    let command_extras = cmd_keys
        .into_iter()
        .map(|k| scons_token(k, &cmd[k]))
        .collect();

    // written 排序（真源 `.sort()` 是 UTF-16 码元序；这里全是 ASCII flag 名，字节序等价）
    written.sort();

    let mut top = Map::new();
    top.insert("disabled_build_options".to_string(), Value::Object(sort_keys(dbo)));

    ProfileResult {
        json: Value::Object(top),
        written,
        skipped,
        command_extras,
    }
}

fn json_skip(flag: &str, why: &str) -> Value {
    // 键序 flag → why：与 JS 的 `{ flag, why }` 字面量同序，skipped 又是遇到顺序，两处都得对上
    let mut m = Map::new();
    m.insert("flag".to_string(), Value::String(flag.to_string()));
    m.insert("why".to_string(), Value::String(why.to_string()));
    Value::Object(m)
}

/// 对应 tplprofile.js:292 profileText —— 逐字节口径见 docs/tplrust-plan.md §5.2
pub fn profile_text(json: &Value) -> String {
    serde_json::to_string_pretty(json).unwrap_or_default()
}

/// 对应 tplprofile.js:302 selectionTurningOff
fn selection_turning_off(options: &Value, ids: &[&str]) -> Value {
    let mut sel = initial_selection(options).as_object().cloned().unwrap_or_default();
    for id in ids {
        if sel.contains_key(*id) {
            sel.insert((*id).to_string(), Value::Bool(false));
        }
    }
    Value::Object(sel)
}

/// 对应 tplprofile.js:668 PRESETS.apply(name, options) —— **未知名不猜**，直接 ok:false
pub fn presets_apply(name: &str, options: &Value) -> Value {
    let (features, mode) = match name {
        "full" => (initial_selection(options), "default-on"),
        "lite2d" => (selection_turning_off(options, &LITE2D_OFF_IDS), "default-on"),
        "minimal" => (selection_turning_off(options, &MINIMAL_OFF_IDS), "default-off"),
        other => {
            let mut m = Map::new();
            m.insert("ok".to_string(), Value::Bool(false));
            m.insert("error".to_string(), Value::String(format!("未知预设:{other}")));
            return Value::Object(m);
        }
    };
    let mut m = Map::new();
    m.insert("ok".to_string(), Value::Bool(true));
    m.insert("features".to_string(), features);
    m.insert("mode".to_string(), Value::String(mode.to_string()));
    Value::Object(m)
}
