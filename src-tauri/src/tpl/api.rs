//! 契约层：把探测/输出两层拼成 `src/types/services.ts` 那四条方法的返回体。
//!
//! 真源 = `src-ztools/preload/services.js:61-131`（宿主侧组合）。这里只做**同构搬运**：
//! 判据全在 `probe.rs` / `profile.rs`，本文件里不该出现任何一条新判据 —— 出现了就是第二个真源。

use crate::tpl::features;
use crate::tpl::probe;
use crate::tpl::profile::{self, ValidateCtx};
use serde_json::{json, Map, Value};

/// 对应 services.js:61 probeTemplateSource —— 原样透传，契约层不加产品语言（策划书 §5.2）
pub fn probe_template_source(src_dir: &str) -> Value {
    probe::probe_source(std::path::Path::new(src_dir), None)
}

/// 对应 services.js:63 listTemplateFeatures —— 能力表(语义) × 探测结果(这份源码认不认)
pub fn list_template_features(src_dir: &str) -> Value {
    let p = probe::probe_source(std::path::Path::new(src_dir), None);
    // 两支闸成因不同、建议也就不同，不合并成一支（真源 :65-70 那段注释）
    if p.get("ok") != Some(&json!(true)) {
        return json!({ "ok": false, "error": p.get("error").cloned().unwrap_or(Value::Null) });
    }
    let options = p.get("options").cloned().unwrap_or(json!({}));
    if options.as_object().map(|m| m.is_empty()).unwrap_or(true) {
        return json!({ "ok": false, "error": "无法解析此版本源码的构建选项（源码结构可能已变）" });
    }
    let sel = profile::initial_selection(&options);
    let cascades = p.get("cascades").cloned().unwrap_or(json!({}));
    let cascade_sources: Vec<String> = cascades.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    let mut items = Vec::new();
    for f in features::features() {
        let present = f.flags.iter().any(|k| {
            options.get(*k).and_then(|o| o.get("exists")).and_then(|e| e.as_bool()).unwrap_or(false)
        });
        let cascaded_by = cascade_sources.iter().find(|src| {
            cascades
                .get(src.as_str())
                .and_then(|t| t.as_array())
                .map(|list| list.iter().any(|t| t.as_str().map(|s| f.flags.contains(&s)).unwrap_or(false)))
                .unwrap_or(false)
        });
        let mut m = Map::new();
        m.insert("id".into(), json!(f.id));
        m.insert("label".into(), json!(f.label));
        m.insert("group".into(), json!(f.group));
        m.insert("desc".into(), json!(f.desc));
        m.insert("sizeImpact".into(), json!(f.size_impact));
        m.insert("risk".into(), json!(f.risk));
        m.insert("flags".into(), json!(f.flags));
        m.insert("present".into(), json!(present));
        m.insert("defaultOn".into(), sel.get(f.id).cloned().unwrap_or(json!(false)));
        // 连带关系只报这份源码自己声明的，没探到就不给这个键（键缺席 ≠ false，渲染层据此分两态）
        if let Some(src) = cascaded_by {
            m.insert("cascadedBy".into(), json!(src));
        }
        items.push(Value::Object(m));
    }
    json!({ "ok": true, "items": items })
}

/// 对应 services.js:95 validateTemplateConfig —— 勾选 + 探测 → 软问题 / 硬拦 / 当前连带抑制表
pub fn validate_template_config(params: &Value) -> Value {
    let src_dir = params.get("srcDir").and_then(|v| v.as_str()).unwrap_or("");
    let features_sel = params.get("features").cloned().unwrap_or(json!({}));
    let p = probe::probe_source(std::path::Path::new(src_dir), None);
    let options = p.get("options").cloned().unwrap_or(json!({}));
    // untestedSource 由宿主按探测给的 tested 布尔算，不接受渲染层同名键（真源 :97-100）
    let untested = p.get("tested") != Some(&json!(true));
    let ctx = ValidateCtx {
        mode: params.get("mode").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        d3d12_sdk_installed: params.get("d3d12SdkInstalled").and_then(|v| v.as_bool()),
        accesskit_sdk_installed: params.get("accesskitSdkInstalled").and_then(|v| v.as_bool()),
        untested_source: Some(untested),
    };
    let r = profile::validate_selection(&features_sel, &options, Some(&ctx));
    let hard = r.get("hardBlocks").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut out = Map::new();
    out.insert("ok".into(), json!(hard.is_empty()));
    out.insert("issues".into(), r.get("issues").cloned().unwrap_or(json!([])));
    out.insert("hardBlocks".into(), Value::Array(hard));
    out.insert(
        "suppressed".into(),
        profile::selection_suppressed(&features_sel, &p.get("cascades").cloned().unwrap_or(json!({}))),
    );
    Value::Object(out)
}

/// 对应 services.js:124 applyTemplatePreset —— 渲染层只报名字，取消哪些项与 mode 都由输出层给
pub fn apply_template_preset(name: &str, src_dir: &str) -> Value {
    let p = probe::probe_source(std::path::Path::new(src_dir), None);
    if p.get("ok") != Some(&json!(true)) {
        let err = p.get("error").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("无法探测这份源码");
        return json!({ "ok": false, "error": err });
    }
    let r = profile::presets_apply(name, &p.get("options").cloned().unwrap_or(json!({})));
    if r.get("ok") != Some(&json!(true)) {
        return json!({ "ok": false, "error": r.get("error").cloned().unwrap_or(Value::Null) });
    }
    json!({ "ok": true, "features": r.get("features").cloned().unwrap_or(json!({})), "mode": r.get("mode").cloned().unwrap_or(Value::Null) })
}
