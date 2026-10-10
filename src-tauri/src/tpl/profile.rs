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

/// 对应 tplprofile.js:349 RENDER_DRIVERS
const RENDER_DRIVERS: [&str; 4] = ["vulkan", "opengl3", "angle", "d3d12"];

fn feature_by_id(id: &str) -> Option<&'static crate::tpl::features::TplFeature> {
    features().iter().find(|f| f.id == id)
}

/// 对应 tplprofile.js:364 productValue —— **两个通道的并集**，都没发才回落到源码默认。
/// `None` = 这份源码里没有这个变量（未声明的 scons 变量是静默忽略的，校验一律按未知处理）。
fn product_value(flag: &str, built: &ProfileResult, options: &Value) -> Option<Value> {
    if let Some(v) = built.json.get("disabled_build_options").and_then(|d| d.get(flag)) {
        return Some(v.clone());
    }
    if let Some(tok) = built.command_extras.iter().find(|t| t.split('=').next() == Some(flag)) {
        let raw = &tok[tok.find('=').unwrap() + 1..];
        return Some(match raw {
            "yes" => Value::Bool(true),
            "no" => Value::Bool(false),
            other => Value::String(other.to_string()),
        });
    }
    let o = options.get(flag)?;
    if o.get("exists").and_then(|e| e.as_bool()).unwrap_or(false) {
        o.get("default").cloned()
    } else {
        None
    }
}

/// 对应 tplprofile.js:384 productOn —— 有事实才回答，`None` 即真源那个 `null`
fn product_on(flag: &str, built: &ProfileResult, options: &Value) -> Option<bool> {
    let v = product_value(flag, built, options)?;
    let mut probe = Map::new();
    probe.insert("exists".to_string(), Value::Bool(true));
    probe.insert("default".to_string(), v);
    is_on_by_default(flag, Some(&Value::Object(probe)))
}

/// 对应 tplprofile.js:396 productOff —— 方向只在这一处翻；未知一律 false（「没探到」≠「已关闭」）
fn product_off(flag: &str, built: &ProfileResult, options: &Value) -> bool {
    match product_on(flag, built, options) {
        None => false,
        Some(st) => {
            if is_negated_flag(flag) {
                st
            } else {
                !st
            }
        }
    }
}

/// 对应 tplprofile.js:407 itemOffInProduct —— 一项多 flag 时任一被确定关掉就算这项没了
fn item_off_in_product(id: &str, built: &ProfileResult, options: &Value) -> bool {
    match feature_by_id(id) {
        None => false,
        Some(f) => f.flags.iter().any(|k| product_off(k, built, options)),
    }
}

fn issue(item_id: &str, flag: &str, why: &str, action: &str, skippable: bool) -> Value {
    // 键序 itemId/flag/why/action/skippable 与真源的字面量一致，逐字节对照要连键序一起比
    let mut m = Map::new();
    m.insert("itemId".to_string(), Value::String(item_id.to_string()));
    m.insert("flag".to_string(), Value::String(flag.to_string()));
    m.insert("why".to_string(), Value::String(why.to_string()));
    m.insert("action".to_string(), Value::String(action.to_string()));
    m.insert("skippable".to_string(), Value::Bool(skippable));
    Value::Object(m)
}

/// 对应 tplprofile.js:449 validateSelection 的第四参 ctx
pub struct ValidateCtx {
    pub mode: String,
    pub d3d12_sdk_installed: Option<bool>,
    pub accesskit_sdk_installed: Option<bool>,
    pub untested_source: Option<bool>,
}

/// 对应 tplprofile.js:449 validateSelection —— 三条硬拦 + 若干软问题。
/// 校验的对象是**将要发出去的那份产物**，所以先跑一遍 `build_profile` 再从产物读，
/// 不直接看勾选真值（真源 `:458-466` 那段注释是这一层的契约）。
pub fn validate_selection(selection: &Value, options: &Value, ctx: Option<&ValidateCtx>) -> Value {
    let mode = ctx.and_then(|c| if c.mode.is_empty() { None } else { Some(c.mode.as_str()) }).unwrap_or("default-on");
    let sel = selection.as_object().cloned().unwrap_or_default();
    let built = build_profile(selection, options, mode);
    let mut issues: Vec<Value> = Vec::new();
    let mut hard: Vec<Value> = Vec::new();
    let off = |flag: &str| product_off(flag, &built, options);
    let gone = |id: &str| item_off_in_product(id, &built, options);

    // 硬拦 1：四个渲染驱动全关（只按有事实的下判断，未探到的不算「已关闭」）
    if RENDER_DRIVERS.iter().all(|d| gone(d)) {
        hard.push(issue("vulkan", "vulkan", "四个渲染驱动全关,编出来的模板不会有任何画面", "至少保留一个;Windows 上建议保留 Vulkan", false));
    }
    // 硬拦 2：一项不剩
    if sel.values().filter(|v| truthy(v)).count() == 0 {
        hard.push(issue("source", "", "一项都没保留,这不是一个能跑的模板", "至少保留渲染驱动与文字渲染", false));
    }
    // 硬拦 3：反向白名单活着却没有任何模块被点名保留（判据只看已发出的 token，不再叠 exists 前置）
    let whitelist_live = built.command_extras.iter().any(|t| t == "modules_enabled_by_default=no");
    let named_modules: Vec<String> = built
        .json
        .get("disabled_build_options")
        .map(|d| d.as_object().map(|m| m.keys().filter(|k| is_module_flag(k)).cloned().collect()).unwrap_or_default())
        .unwrap_or_default();
    if whitelist_live && named_modules.is_empty() {
        let mut probed: Vec<&str> = Vec::new();
        for f in features() {
            for k in f.flags {
                if is_module_flag(k)
                    && options.get(k).and_then(|o| o.get("exists")).and_then(|e| e.as_bool()).unwrap_or(false)
                    && !probed.contains(&k)
                {
                    probed.push(k);
                }
            }
        }
        let (why, action) = if probed.is_empty() {
            (
                "「最小可跑」会整体关掉所有模块,而这次一个模块开关都没探到、无法点名保留 —— 产物会是没有脚本也没有文字的零模块模板".to_string(),
                "换一份完整解压、能探到 modules/ 的源码再编,或改用「默认开」的预设".to_string(),
            )
        } else {
            (
                format!("「最小可跑」会整体关掉所有模块,这次探到 {} 个模块开关但一个都没点名保留 —— 产物会是没有脚本也没有文字的零模块模板", probed.len()),
                "至少点名保留脚本与文字渲染要用的模块(勾回对应面板项),或改用「默认开」的预设".to_string(),
            )
        };
        hard.push(issue("source", "modules_enabled_by_default", &why, &action, false));
    }

    // 软问题：物理两条轴都没了（Jolt 只提供 3D，救不了 2D）
    let phys2d_gone = off("disable_physics_2d") || off("module_godot_physics_2d_enabled");
    let phys3d_gone = off("disable_physics_3d")
        || (off("module_godot_physics_3d_enabled") && off("module_jolt_physics_enabled"));
    if phys2d_gone && phys3d_gone {
        issues.push(issue("a3GodotPhys", "module_godot_physics_2d_enabled", "2D 与 3D 物理后端都被关掉了,CharacterBody/RigidBody 不会有任何碰撞", "至少保留一套物理后端", true));
    }
    // 依赖缺失：只在「这个驱动真会被编进产物」时报，且 ctx 必须是显式 false（undefined ≠ false）
    if product_on("d3d12", &built, options) == Some(true) && ctx.and_then(|c| c.d3d12_sdk_installed) == Some(false) {
        issues.push(issue("d3d12", "d3d12", "保留 Direct3D 12 驱动,但本机没装它的依赖 —— 实测这样会直接编译失败", "取消该项,或先跑 python misc\\scripts\\install_d3d12_sdk_windows.py", true));
    }
    if product_on("accesskit", &built, options) == Some(true) && ctx.and_then(|c| c.accesskit_sdk_installed) == Some(false) {
        issues.push(issue("accesskit", "accesskit", "保留 AccessKit,但本机没装它的依赖 —— 实测会撞 accesskit 报错", "取消该项(无障碍树对导出模板通常无关)", true));
    }
    if gone("netMbedtls") {
        issues.push(issue("netMbedtls", "module_mbedtls_enabled", "关掉 mbedTLS 后 HTTPS / TLS 全断,任何联网需求都会静默失败", "勾回该项,或确认项目不含任何联网调用", true));
    }
    // 反向白名单的「半个瞎」：勾着但有模块 flag 没探到 → 会被整体关掉
    if whitelist_live && !named_modules.is_empty() {
        let mut lost = 0usize;
        for f in features() {
            if !truthy(sel.get(f.id).unwrap_or(&Value::Null)) {
                continue;
            }
            if f.flags.iter().filter(|k| is_module_flag(k)).any(|k| product_value(k, &built, options).is_none()) {
                lost += 1;
            }
        }
        if lost > 0 {
            issues.push(issue("source", "modules_enabled_by_default", &format!("反向白名单下有 {lost} 项你保留的模块没在这份源码里探到,它们会被整体关掉(面板显示保留、产物里没有)"), "把这些项取消勾选,或改用「默认开」的预设", true));
        }
    }
    // 默认开模式的对称半边：勾了取消但有 flag 没探到 → 只能关掉一部分
    if mode == "default-on" {
        for f in features() {
            match sel.get(f.id) {
                None => continue,
                Some(v) if truthy(v) => continue,
                Some(_) => {}
            }
            let missing: Vec<&str> = f.flags.iter().copied()
                .filter(|k| !options.get(k).and_then(|o| o.get("exists")).and_then(|e| e.as_bool()).unwrap_or(false))
                .collect();
            let probed_count = f.flags.len() - missing.len();
            if probed_count > 0 && !missing.is_empty() {
                issues.push(issue(f.id, missing[0], &format!("该项在本版本源码里有 {} 个开关不存在,取消它只会关掉探到的那 {} 个 —— 不会影响那些格式", missing.len(), probed_count), "照常取消即可;要精确关掉那些能力得换一份声明了对应开关的源码", true));
            }
        }
    }
    if ctx.and_then(|c| c.untested_source).unwrap_or(false) {
        issues.push(issue("source", "", "这份源码的版本不在已实测表内,面板按探测结果工作;未识别的项保持源码默认,不猜参数", "如产物异常,先按已实测版本复现", true));
    }

    let mut out = Map::new();
    out.insert("issues".to_string(), Value::Array(issues));
    out.insert("hardBlocks".to_string(), Value::Array(hard));
    Value::Object(out)
}

/// 对应 tplprofile.js:618 selectionSuppressed —— 当前勾选下被连带关闭的面板项 id。
/// 只有**严格 false** 的伞项才算被取消（缺键按「用户没取消它」）；表外源 flag 取保守态进表；
/// 只走一层不做传递闭包（Ruling #73）；输出按表序而不是 Set 的插入序。
pub fn selection_suppressed(selection: &Value, cascades: &Value) -> Value {
    let sel = selection.as_object().cloned().unwrap_or_default();
    let graph = cascades.as_object().cloned().unwrap_or_default();
    let mut hit: Vec<String> = Vec::new();
    for (src_flag, targets) in graph.iter() {
        let owns = |id: &str| feature_by_id(id).map(|f| f.flags.contains(&src_flag.as_str())).unwrap_or(false);
        let owners: Vec<&str> = features().iter().filter(|f| owns(f.id)).map(|f| f.id).collect();
        let umbrella_off = owners.is_empty()
            || owners.iter().any(|id| sel.get(*id) == Some(&Value::Bool(false)));
        if !umbrella_off {
            continue;
        }
        if let Value::Array(list) = targets {
            for t in list {
                let Some(t) = t.as_str() else { continue };
                for f in features() {
                    if f.flags.contains(&t) && !hit.contains(&f.id.to_string()) {
                        hit.push(f.id.to_string());
                    }
                }
            }
        }
    }
    let ordered: Vec<Value> = features().iter()
        .filter(|f| hit.contains(&f.id.to_string()))
        .map(|f| Value::String(f.id.to_string()))
        .collect();
    Value::Array(ordered)
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
