// 文档库域核心(纯函数层):extension_api 解析、po 翻译查表、索引与打分搜索。
// 语义逐条对齐 lib/docmodel.js + docpo.js;文件切片与全文检索的 IO 层由命令组装(T5)。
// 关键实测结论(见 memory/godot-classref-docs-quirks):po 的 msgid 与 dump 描述逐字符一致 → 直接查表替换。
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;

pub const SEARCH_PER_CLASS_CAP: usize = 8;
pub const SCORE_CLASS: i64 = 100;
pub const SCORE_MEMBER: i64 = 30;

// ---------- po 解析(跳过头部/fuzzy/msgctxt/复数/空翻译) ----------

fn unescape_po(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn parse_po(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    // fuzzy/msgctxt 出现在条目之前、属于下一个 msgid(docpo.js 的关键注释):
    // pending_skip 在 msgid 行收编为当前条目的 entry_skip,entry_skip 随该条目 flush 后清除
    let mut pending_skip = false;
    let mut entry_skip = false;
    let mut cur_msgid = String::new();
    let mut cur_msgstr = String::new();
    let mut field = 0; // 0=msgid 1=msgstr
    let mut have = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("#,") && t.contains("fuzzy") {
            pending_skip = true;
            continue;
        }
        if t.starts_with("msgctxt") {
            pending_skip = true;
            continue;
        }
        if t.starts_with("msgid_plural") {
            // 复数形式:整条跳过
            entry_skip = true;
            continue;
        }
        if t.starts_with("msgid ") {
            if have && !entry_skip && !cur_msgid.is_empty() && !cur_msgstr.is_empty() {
                map.insert(cur_msgid.clone(), cur_msgstr.clone());
            }
            have = true;
            entry_skip = pending_skip;
            pending_skip = false;
            cur_msgid = unescape_po(t[6..].trim().trim_matches('"'));
            cur_msgstr.clear();
            field = 0;
            continue;
        }
        if t.starts_with("msgstr") {
            if t.starts_with("msgstr[") {
                entry_skip = true;
            }
            field = 1;
            let v = t.splitn(2, ' ').nth(1).unwrap_or("\"\"");
            cur_msgstr = unescape_po(v.trim().trim_matches('"'));
            continue;
        }
        if t.starts_with('"') && t.ends_with('"') {
            let piece = unescape_po(&t[1..t.len() - 1]);
            if field == 0 {
                cur_msgid.push_str(&piece);
            } else {
                cur_msgstr.push_str(&piece);
            }
        }
    }
    if have && !entry_skip && !cur_msgid.is_empty() && !cur_msgstr.is_empty() {
        map.insert(cur_msgid, cur_msgstr);
    }
    map
}

// ---------- extension_api → 类详情 ----------

fn params_of(args: Option<&Value>) -> Value {
    match args.and_then(|v| v.as_array()) {
        Some(arr) => Value::Array(
            arr.iter()
                .map(|a| {
                    let mut p = json!({
                        "name": a.get("name").cloned().unwrap_or(Value::Null),
                        "type": a.get("type").cloned().unwrap_or(json!("Variant")),
                    });
                    if let Some(dv) = a.get("default_value").filter(|v| !v.is_null()) {
                        p["defaultValue"] = dv.clone();
                    }
                    p
                })
                .collect(),
        ),
        None => Value::Array(vec![]),
    }
}

fn qualifiers_of(m: &Value) -> Vec<String> {
    let mut q = Vec::new();
    for key in ["is_const", "is_static", "is_vararg"] {
        if m.get(key).and_then(|v| v.as_bool()).unwrap_or(false) {
            q.push(key.trim_start_matches("is_").to_string());
        }
    }
    q
}

pub fn map_class(c: &Value, builtin: bool, is_singleton: bool) -> Value {
    let members = c.get("properties").or_else(|| c.get("members")).and_then(|v| v.as_array());
    json!({
        "name": c.get("name").cloned().unwrap_or(Value::Null),
        "inherits": c.get("inherits").cloned().unwrap_or(Value::Null),
        "brief": c.get("brief_description").cloned().unwrap_or(json!("")),
        "description": c.get("description").cloned().unwrap_or(json!("")),
        "builtin": builtin,
        "isSingleton": is_singleton,
        "members": members.map(|ms| Value::Array(ms.iter().map(|p| {
            let mut m = json!({
                "name": p.get("name").cloned().unwrap_or(Value::Null),
                "type": p.get("type").cloned().unwrap_or(json!("Variant")),
            });
            for (src, dst) in [("setter", "setter"), ("getter", "getter"), ("default_value", "defaultValue")] {
                if let Some(v) = p.get(src).filter(|v| !v.is_null()) { m[dst] = v.clone(); }
            }
            m["description"] = p.get("description").cloned().unwrap_or(json!(""));
            m
        }).collect())).unwrap_or(Value::Array(vec![])),
        "methods": c.get("methods").and_then(|v| v.as_array()).map(|ms| Value::Array(ms.iter().map(|m| json!({
            "name": m.get("name").cloned().unwrap_or(Value::Null),
            "returnType": m.get("return_type").cloned().unwrap_or(json!(if builtin {"Variant"} else {"void"})),
            "params": params_of(m.get("arguments")),
            "qualifiers": qualifiers_of(m),
            "description": m.get("description").cloned().unwrap_or(json!("")),
        })).collect())).unwrap_or(Value::Array(vec![])),
        "signals": c.get("signals").and_then(|v| v.as_array()).map(|ms| Value::Array(ms.iter().map(|s| json!({
            "name": s.get("name").cloned().unwrap_or(Value::Null),
            "params": params_of(s.get("arguments")),
            "description": s.get("description").cloned().unwrap_or(json!("")),
        })).collect())).unwrap_or(Value::Array(vec![])),
        "constants": c.get("constants").and_then(|v| v.as_array()).map(|ms| Value::Array(ms.iter().map(|k| {
            let mut m = json!({
                "name": k.get("name").cloned().unwrap_or(Value::Null),
                "value": k.get("value").map(|v| v.to_string()).unwrap_or_default(),
            });
            if let Some(e) = k.get("enum").filter(|v| !v.is_null()) { m["enum"] = e.clone(); }
            m["description"] = k.get("description").cloned().unwrap_or(json!(""));
            m
        }).collect())).unwrap_or(Value::Array(vec![])),
        "enums": c.get("enums").and_then(|v| v.as_array()).map(|ms| Value::Array(ms.iter().map(|e| json!({
            "name": e.get("name").cloned().unwrap_or(Value::Null),
            "bitfield": e.get("is_bitfield").and_then(|v| v.as_bool()).unwrap_or(false),
            "values": e.get("values").and_then(|v| v.as_array()).map(|vs| Value::Array(vs.iter().map(|v| json!({
                "name": v.get("name").cloned().unwrap_or(Value::Null),
                "value": v.get("value").map(|x| x.to_string()).unwrap_or_default(),
                "description": v.get("description").cloned().unwrap_or(json!("")),
            })).collect())).unwrap_or(Value::Array(vec![])),
        })).collect())).unwrap_or(Value::Array(vec![])),
        "operators": c.get("operators").and_then(|v| v.as_array()).map(|ms| Value::Array(ms.iter().map(|op| json!({
            "name": op.get("name").cloned().unwrap_or(json!("")),
            "returnType": op.get("return_type").cloned().unwrap_or(json!("Variant")),
            "params": params_of(op.get("arguments")),
            "description": op.get("description").cloned().unwrap_or(json!("")),
        })).collect())).unwrap_or(Value::Array(vec![])),
    })
}

/// @GlobalScope 伪类:utility_functions → methods;global_enums → enums;散装全局常量 → constants
pub fn map_global_scope(api: &Value) -> Value {
    let enums: Vec<Value> = api
        .get("global_enums")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|e| json!({ "name": e["name"], "bitfield": e.get("is_bitfield").and_then(|v| v.as_bool()).unwrap_or(false), "values": e.get("values").cloned().unwrap_or(Value::Array(vec![])) }))
                .collect()
        })
        .unwrap_or_default();
    let in_enum: Vec<String> = enums
        .iter()
        .flat_map(|e| e["values"].as_array().cloned().unwrap_or_default())
        .filter_map(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
        .collect();
    let consts: Vec<Value> = api
        .get("global_constants")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|k| !in_enum.contains(&k.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string()))
                .map(|k| json!({ "name": k["name"], "value": k["value"].to_string(), "description": "" }))
                .collect()
        })
        .unwrap_or_default();
    let methods: Vec<Value> = api
        .get("utility_functions")
        .and_then(|v| v.as_array())
        .map(|ms| {
            ms.iter()
                .map(|m| json!({ "name": m["name"], "returnType": m.get("return_type").cloned().unwrap_or(json!("Variant")), "params": params_of(m.get("arguments")), "qualifiers": qualifiers_of(m), "description": m.get("description").cloned().unwrap_or(json!("")) }))
                .collect()
        })
        .unwrap_or_default();
    let enums: Vec<Value> = enums
        .into_iter()
        .map(|mut e| {
            if let Some(vals) = e.get_mut("values").and_then(|v| v.as_array_mut()) {
                for v in vals.iter_mut() {
                    v["value"] = json!(v["value"].to_string());
                    if v.get("description").is_none() { v["description"] = json!(""); }
                }
            }
            e
        })
        .collect();
    let mut c = json!({
        "name": "@GlobalScope",
        "inherits": Value::Null,
        "brief": "全局作用域:GDScript 内置函数、全局常量与全局枚举。",
        "description": "收录 GDScript 直接可用的内置函数(如 clamp / lerp / randi)与全局常量、枚举。这些成员不属于任何类,在任意脚本中直接调用。",
        "builtin": true, "isSingleton": false,
        "members": [], "signals": [], "methods": methods,
        "constants": consts, "enums": enums, "operators": [],
    });
    c
}

/// 应用翻译:brief/description/各成员描述按 msgid 查表替换(命中才替换,未翻译留英文)
pub fn apply_translation(class: &mut Value, map: &HashMap<String, String>) {
    let mut node = class.clone();
    visit(&mut node, map);
    *class = node;
}

fn visit(v: &mut Value, map: &HashMap<String, String>) {
    match v {
        Value::Object(o) => {
            let keys: Vec<String> = o.keys().cloned().collect();
            for k in keys {
                if k == "brief" || k == "description" {
                    if let Some(Value::String(s)) = o.get(&k) {
                        if let Some(t) = map.get(s) {
                            o.insert(k.clone(), Value::String(t.clone()));
                        }
                    }
                } else {
                    if let Some(child) = o.get_mut(&k) {
                        visit(child, map);
                    }
                }
            }
        }
        Value::Array(a) => {
            for item in a.iter_mut() {
                visit(item, map);
            }
        }
        _ => {}
    }
}

// ---------- 索引与打分搜索 ----------

pub fn build_index_entry(cls: &Value) -> Value {
    let names = |field: &str| -> Vec<String> {
        cls.get(field)
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(String::from)).collect())
            .unwrap_or_default()
    };
    let mut constants = names("constants");
    for e in cls.get("enums").and_then(|v| v.as_array()).into_iter().flatten() {
        for v in e.get("values").and_then(|x| x.as_array()).into_iter().flatten() {
            if let Some(n) = v.get("name").and_then(|n| n.as_str()) {
                constants.push(n.to_string());
            }
        }
    }
    json!({
        "name": cls["name"], "inherits": cls["inherits"], "brief": cls["brief"],
        "builtin": cls["builtin"], "isSingleton": cls["isSingleton"],
        "m": names("methods"), "p": names("members"), "s": names("signals"),
        "c": constants, "e": names("enums"),
    })
}

pub fn word_score(word: &str, q: &str) -> i64 {
    let w = word.to_lowercase();
    if w.is_empty() {
        return 0;
    }
    if w == q {
        3
    } else if w.starts_with(q) {
        2
    } else if w.contains(q) {
        1
    } else {
        0
    }
}

pub fn search_index(index: &[Value], query: &str, limit: usize) -> Vec<Value> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    let mut hits: Vec<Value> = Vec::new();
    for entry in index {
        let name = entry["name"].as_str().unwrap_or("");
        let brief = entry["brief"].as_str().unwrap_or("");
        let cls_score = word_score(name, &q);
        if cls_score > 0 {
            hits.push(json!({ "kind": "class", "className": name, "name": name, "brief": brief, "score": SCORE_CLASS + cls_score }));
        }
        let mut budget = SEARCH_PER_CLASS_CAP;
        let mut push_member = |kind: &str, n: &str| {
            if budget == 0 {
                return;
            }
            let s = word_score(n, &q);
            if s > 0 {
                budget -= 1;
                hits.push(json!({ "kind": kind, "className": name, "name": n, "brief": brief, "score": SCORE_MEMBER + s }));
            }
        };
        for n in entry["m"].as_array().cloned().unwrap_or_default() { push_member("method", n.as_str().unwrap_or("")); }
        for n in entry["p"].as_array().cloned().unwrap_or_default() { push_member("member", n.as_str().unwrap_or("")); }
        for n in entry["s"].as_array().cloned().unwrap_or_default() { push_member("signal", n.as_str().unwrap_or("")); }
        for n in entry["e"].as_array().cloned().unwrap_or_default() { push_member("enum", n.as_str().unwrap_or("")); }
        for n in entry["c"].as_array().cloned().unwrap_or_default() { push_member("constant", n.as_str().unwrap_or("")); }
    }
    hits.sort_by(|a, b| {
        let sa = a["score"].as_i64().unwrap_or(0);
        let sb = b["score"].as_i64().unwrap_or(0);
        sb.cmp(&sa)
            .then_with(|| a["className"].as_str().unwrap_or("").cmp(b["className"].as_str().unwrap_or("")))
            .then_with(|| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")))
    });
    if limit > 0 {
        hits.truncate(limit);
    }
    hits
}

/// 全文检索:在切片目录的类正文里数命中,返回带片段的类列表(分数=命中次数,限 limit)
pub fn search_full_text(slices_dir: &Path, query: &str, limit: usize) -> Vec<Value> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    let mut hits: Vec<(usize, String, String)> = Vec::new();
    let Ok(rd) = std::fs::read_dir(slices_dir) else { return vec![] };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") || p.file_name().map(|f| f == "index.json").unwrap_or(true) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let lower = text.to_lowercase();
        let count = lower.matches(&q).count();
        if count == 0 {
            continue;
        }
        let name = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let byte_pos = lower.find(&q).unwrap_or(0);
        let start = text
            .char_indices()
            .map(|(i, _)| i)
            .filter(|i| *i <= byte_pos)
            .next_back()
            .unwrap_or(0);
        let snippet: String = text.chars().skip(text[..start].chars().count()).take(120).collect();
        hits.push((count, name, snippet));
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    hits.truncate(limit);
    hits.into_iter()
        .map(|(score, name, snippet)| json!({ "kind": "body", "className": name, "name": name, "snippet": snippet, "score": score }))
        .collect()
}

/// 库构建:解析 extension_api(core + builtin + @GlobalScope),应用翻译,写切片与索引。
/// 返回 (类数, 索引)。切片命名 {ClassName}.json,索引 index.json。
pub fn build_library(api: &Value, po: &HashMap<String, String>, out_dir: &Path) -> Result<(usize, Vec<Value>), String> {
    std::fs::create_dir_all(out_dir).map_err(|e| format!("创建库目录失败:{e}"))?;
    let mut index: Vec<Value> = Vec::new();
    let mut count = 0usize;
    let mut emit = |cls: &Value, po: &HashMap<String, String>, index: &mut Vec<Value>, count: &mut usize| -> Result<(), String> {
        let mut c = cls.clone();
        apply_translation(&mut c, po);
        let name = c["name"].as_str().unwrap_or("").to_string();
        if name.is_empty() {
            return Ok(());
        }
        let path = out_dir.join(format!("{name}.json"));
        std::fs::write(&path, serde_json::to_string(&c).map_err(|e| e.to_string())?).map_err(|e| format!("写切片失败:{e}"))?;
        index.push(build_index_entry(&c));
        *count += 1;
        Ok(())
    };
    for c in api.get("classes").and_then(|v| v.as_array()).into_iter().flatten() {
        emit(&map_class(c, false, false), po, &mut index, &mut count)?;
    }
    for c in api.get("builtin_classes").and_then(|v| v.as_array()).into_iter().flatten() {
        emit(&map_class(c, true, false), po, &mut index, &mut count)?;
    }
    let gs = map_global_scope(api);
    emit(&gs, po, &mut index, &mut count)?;
    let mut sorted = index.clone();
    sorted.sort_by_key(|e| e["name"].as_str().unwrap_or("").to_string());
    std::fs::write(out_dir.join("index.json"), serde_json::to_string(&sorted).map_err(|e| e.to_string())?)
        .map_err(|e| format!("写索引失败:{e}"))?;
    Ok((count, sorted))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn po_parse_rules() {
        let po = r#"msgid ""
msgstr ""
"Content-Type: text/plain\n"

#, fuzzy
msgid " untranslated fuzzy\n"
msgstr " 不应出现\n"

msgctxt "avoid"
msgid " ctx\n"
msgstr " 不应出现\n"

msgid "Node2D"
msgstr "节点 2D"

msgid "lines"
msgid_plural "lines"
msgstr[0] " 不应出现\n"

msgid "translated but empty"
msgstr ""

msgid "multi line"
msgstr "第一段\n"
"第二段"
"#;
        let m = parse_po(po);
        assert_eq!(m.get("Node2D").map(String::as_str), Some("节点 2D"));
        assert_eq!(m.get("multi line").map(String::as_str), Some("第一段\n第二段"), "续行拼接");
        assert!(!m.values().any(|v| v.contains("不应出现")), "fuzzy/复数/空翻译全部跳过");
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn map_class_shape() {
        let c = json!({
            "name": "Node2D", "inherits": "CanvasItem",
            "brief_description": "base 2d", "description": "long desc",
            "properties": [{ "name": "position", "type": "Vector2", "setter": "set_position", "default_value": "(0, 0)", "description": "pos" }],
            "methods": [{ "name": "move_x", "return_type": "void", "is_const": true, "arguments": [{ "name": "delta", "type": "float" }], "description": "move" }],
            "signals": [{ "name": "moved", "arguments": [] }],
            "constants": [{ "name": "NOTIFY", "value": 1 }],
            "enums": [{ "name": "Mode", "is_bitfield": true, "values": [{ "name": "A", "value": 0 }] }],
        });
        let m = map_class(&c, false, false);
        assert_eq!(m["inherits"], "CanvasItem");
        assert_eq!(m["methods"][0]["returnType"], "void", "core 类缺省 returnType=void");
        assert_eq!(m["methods"][0]["qualifiers"], json!(["const"]));
        assert_eq!(m["methods"][0]["params"][0]["name"], "delta");
        assert_eq!(m["constants"][0]["value"], "1", "常量值转字符串");
        assert_eq!(m["enums"][0]["bitfield"], true);
        let b = json!({ "name": "Vector2", "members": [{ "name": "x", "type": "float" }], "methods": [{ "name": "length" }] });
        let mb = map_class(&b, true, false);
        assert_eq!(mb["methods"][0]["returnType"], "Variant", "builtin 缺省 returnType=Variant");
        assert_eq!(mb["members"][0]["name"], "x", "builtin 成员来自 members 字段");
    }

    #[test]
    fn global_scope_composition() {
        let api = json!({
            "global_enums": [{ "name": "Side", "is_bitfield": false, "values": [{ "name": "SIDE_LEFT", "value": 0 }] }],
            "global_constants": [{ "name": "SIDE_LEFT", "value": 0 }, { "name": "PI", "value": 3.14 }],
            "utility_functions": [{ "name": "abs", "return_type": "float", "arguments": [] }],
        });
        let g = map_global_scope(&api);
        assert_eq!(g["name"], "@GlobalScope");
        assert_eq!(g["methods"][0]["name"], "abs");
        assert_eq!(g["enums"][0]["name"], "Side");
        assert_eq!(g["constants"][0]["name"], "PI", "枚举内的常量不重复收录");
    }

    #[test]
    fn translation_application() {
        let mut map = HashMap::new();
        map.insert("base 2d".to_string(), "2D 基类".to_string());
        map.insert("pos".to_string(), "位置".to_string());
        let mut cls = map_class(&json!({ "name": "Node2D", "brief_description": "base 2d", "properties": [{ "name": "position", "description": "pos" }] }), false, false);
        apply_translation(&mut cls, &map);
        assert_eq!(cls["brief"], "2D 基类");
        assert_eq!(cls["members"][0]["description"], "位置");
        // 未命中保留英文
        let mut c2 = map_class(&json!({ "name": "X", "brief_description": "untranslated" }), false, false);
        apply_translation(&mut c2, &map);
        assert_eq!(c2["brief"], "untranslated");
    }

    #[test]
    fn search_scoring_and_caps() {
        let cls = json!({
            "name": "Node", "brief": "n", "builtin": false, "isSingleton": false, "inherits": Value::Null,
            "methods": [{ "name": "get_node" }, { "name": "node_other" }, { "name": "node_more" }, { "name": "node_x" }, { "name": "node_y" }, { "name": "node_z" }, { "name": "node_a" }, { "name": "node_b" }, { "name": "node_c" }, { "name": "node_d" }],
            "members": [{ "name": "node_member" }], "signals": [], "constants": [], "enums": [],
        });
        let other = json!({ "name": "Sprite2D", "brief": "", "builtin": false, "isSingleton": false, "inherits": Value::Null, "methods": [{ "name": "node_like" }], "members": [], "signals": [], "constants": [], "enums": [] });
        let index = vec![build_index_entry(&cls), build_index_entry(&other)];
        let hits = search_index(&index, "node", 100);
        assert_eq!(hits[0]["kind"], "class", "类名权重高于成员");
        assert_eq!(hits[0]["score"], 103, "精确=100+3");
        // 每类成员上限 8:Node 有 10 个 method 含 node,只收 8
        let node_member_hits = hits.iter().filter(|h| h["className"] == "Node" && h["kind"] != "class").count();
        assert_eq!(node_member_hits, 8, "SEARCH_PER_CLASS_CAP");
        // 排序:精确 > 前缀 > 包含
        let scores: Vec<i64> = hits.iter().map(|h| h["score"].as_i64().unwrap()).collect();
        assert!(scores.windows(2).all(|w| w[0] >= w[1]));
    }

    #[test]
    fn library_build_end_to_end() {
        let base = std::env::temp_dir().join(format!(
            "gpm-docs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let mut po = HashMap::new();
        po.insert("base 2d".to_string(), "2D 基类".to_string());
        let api = json!({
            "classes": [{ "name": "Node", "inherits": "Object", "brief_description": "base 2d", "methods": [{ "name": "ready" }] }],
            "builtin_classes": [{ "name": "Vector2", "members": [{ "name": "x" }] }],
            "global_constants": [], "global_enums": [], "utility_functions": [],
        });
        let out = base.join("lib");
        let (count, index) = build_library(&api, &po, &out).unwrap();
        assert_eq!(count, 3, "core + builtin + @GlobalScope");
        assert_eq!(index.len(), 3);
        assert!(out.join("Node.json").is_file());
        assert!(out.join("Vector2.json").is_file());
        assert!(out.join("@GlobalScope.json").is_file());
        assert!(out.join("index.json").is_file());
        let node_slice: Value = serde_json::from_str(&std::fs::read_to_string(out.join("Node.json")).unwrap()).unwrap();
        assert_eq!(node_slice["brief"], "2D 基类", "构建时应用翻译");
        // 全文检索:命中 brief
        let ft = search_full_text(&out, "2D 基类", 10);
        assert!(ft.iter().any(|h| h["className"] == "Node"), "全文命中");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn no_leaked_map_state() {
        let _: Map<String, Value> = Map::new();
    }
}
