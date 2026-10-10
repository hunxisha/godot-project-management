//! P0e-1 的验收面：`tplprofile.js` ↔ `tpl/profile.rs` 的**逐字节** parity。
//!
//! 为什么这么写（`docs/tplrust-plan.md` §0 第 1 拍）：profile 的等价性只在「两边都跑真代码」时才有意义。
//! 所以这里 JS 侧 `require` 的是仓库里那份真源（不是预生成的期望文件），Rust 侧调的是 `tpl::profile`，
//! 两边共吃同一份夹具 `tests/fixtures/tpl_options.json`，产出的 profile **按字符串比**而不是按 JSON 深比较
//! —— 母计划 `:571` 那句「逐字节相同的 profile」要的就是这个。
//!
//! 与姊妹测试 `inspectfs_parity.rs` 的两处刻意不同，都写在下面对应位置：
//!   1. 不加 `#[ignore]`：本测试只 spawn 一次 node、纯函数、不碰真盘，够轻，常驻才有意义
//!      （§7 的验收标准写的是「parity 常驻 cargo test」，加了 ignore 那句话就是假的）。
//!   2. 找不到 node 时**判失败而不是 SKIP**：本仓库的开发环境 node 是硬前提，
//!      静默跳过就是本项目最恨的那种假绿。

use godot_workshop::tpl::features;
use godot_workshop::tpl::profile as rp;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::Path;
use std::process::Command;

/// 十例对照。`sel` 以 `preset:` 开头时 mode 由预设给（`case.mode` 留空串）。
struct CaseSpec {
    name: &'static str,
    sel: &'static str,
    opts: &'static str,
    mode: &'static str,
}

const CASES: [CaseSpec; 10] = [
    CaseSpec { name: "initial", sel: "initial", opts: "fixture", mode: "default-on" },
    CaseSpec { name: "lite2d", sel: "preset:lite2d", opts: "fixture", mode: "" },
    CaseSpec { name: "minimal", sel: "preset:minimal", opts: "fixture", mode: "" },
    CaseSpec { name: "allOn", sel: "allOn", opts: "fixture", mode: "default-on" },
    CaseSpec { name: "allOff", sel: "allOff", opts: "fixture", mode: "default-off" },
    CaseSpec { name: "shuffled", sel: "shuffled", opts: "fixture", mode: "default-on" },
    CaseSpec { name: "initial-empty", sel: "initial", opts: "empty", mode: "default-on" },
    CaseSpec { name: "initial-null", sel: "initial", opts: "null", mode: "default-on" },
    CaseSpec { name: "allOff-empty", sel: "allOff", opts: "empty", mode: "default-off" },
    CaseSpec { name: "unknown-preset", sel: "preset:nope", opts: "fixture", mode: "" },
];

const JS_HARNESS: &str = r###"
const fs = require('node:fs')
const path = require('node:path')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const P = require(path.join(cfg.repo, 'src-ztools/preload/lib/tplprofile.js'))
const { TPL_FEATURES, TPL_GROUPS } = require(path.join(cfg.repo, 'src-ztools/preload/lib/tplfeatures.js'))
const fixture = JSON.parse(fs.readFileSync(cfg.optsFile, 'utf8'))
const OMITTED = ['brotli', 'module_astcenc_enabled']

const ids = TPL_FEATURES.map((f) => f.id)
const flagsMissing = []
for (const f of TPL_FEATURES) {
  for (const k of f.flags) if (!(k in fixture) && OMITTED.indexOf(k) < 0) flagsMissing.push(k)
}

const optionsOf = (kind) => (kind === 'fixture' ? fixture : kind === 'empty' ? {} : null)

function selectionOf(kind, options) {
  if (kind === 'initial') return P.initialSelection(options)
  if (kind === 'allOn') return Object.fromEntries(ids.map((id) => [id, true]))
  if (kind === 'allOff') return Object.fromEntries(ids.map((id) => [id, false]))
  // 乱序勾选:值取 initial 的结果,键按 ids 的逆序插入 —— 照出 written 的排序与 skipped 的遇到顺序
  const base = P.initialSelection(options)
  const out = {}
  for (const id of ids.slice().reverse()) out[id] = base[id] === undefined ? false : base[id]
  return out
}

function resolve(selKind, options, caseMode) {
  if (selKind.indexOf('preset:') === 0) {
    const r = P.PRESETS.apply(selKind.slice(7), options)
    return r.ok ? { features: r.features, mode: r.mode } : { error: r.error }
  }
  return { features: selectionOf(selKind, options), mode: caseMode }
}

const out = {
  ids,
  groups: TPL_GROUPS,
  features: TPL_FEATURES.map((f) => ({
    id: f.id, label: f.label, group: f.group, desc: f.desc,
    sizeImpact: f.sizeImpact, risk: f.risk, flags: f.flags
  })),
  flagsMissing,
  cases: {}
}
for (const c of JSON.parse(cfg.cases)) {
  const options = optionsOf(c.opts)
  const s = resolve(c.sel, options, c.mode)
  if (s.error) { out.cases[c.name] = { presetError: s.error }; continue }
  const r = P.buildProfile(s.features, options, { mode: s.mode })
  out.cases[c.name] = {
    mode: s.mode,
    profile: P.profileText(r.json),
    written: r.written,
    skipped: r.skipped,
    commandExtras: r.commandExtras
  }
}
process.stdout.write(JSON.stringify(out))
"###;

fn cases_spec_json() -> String {
    let v: Vec<Value> = CASES
        .iter()
        .map(|c| json!({ "name": c.name, "sel": c.sel, "opts": c.opts, "mode": c.mode }))
        .collect();
    serde_json::to_string(&v).unwrap()
}

fn options_of(kind: &str, fixture: &Value) -> Value {
    match kind {
        "fixture" => fixture.clone(),
        "empty" => json!({}),
        _ => Value::Null,
    }
}

fn selection_of(kind: &str, options: &Value, ids: &[String]) -> Value {
    match kind {
        "initial" => rp::initial_selection(options),
        "allOn" => {
            let mut m = Map::new();
            for id in ids {
                m.insert(id.clone(), json!(true));
            }
            Value::Object(m)
        }
        "allOff" => {
            let mut m = Map::new();
            for id in ids {
                m.insert(id.clone(), json!(false));
            }
            Value::Object(m)
        }
        // 与 JS 侧同一形态:值取 initial 的结果,键按 ids 逆序插入
        _ => {
            let base = rp::initial_selection(options);
            let mut m = Map::new();
            for id in ids.iter().rev() {
                let v = base
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| json!(false));
                m.insert(id.clone(), v);
            }
            Value::Object(m)
        }
    }
}

fn rust_table() -> Value {
    let rows: Vec<Value> = features::features()
        .iter()
        .map(|f| {
            json!({
                "id": f.id,
                "label": f.label,
                "group": f.group,
                "desc": f.desc,
                "sizeImpact": f.size_impact,
                "risk": f.risk,
                "flags": f.flags
            })
        })
        .collect();
    json!({ "groups": features::groups(), "features": rows })
}

fn rust_side(fixture: &Value) -> Value {
    let ids: Vec<String> = rp::initial_selection(fixture)
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let mut cases = Map::new();
    for c in CASES.iter() {
        let options = options_of(c.opts, fixture);
        let (features, mode, preset_error) = match c.sel.strip_prefix("preset:") {
            Some(name) => {
                let r = rp::presets_apply(name, &options);
                if r.get("ok") == Some(&json!(true)) {
                    (
                        r.get("features").cloned().unwrap_or(Value::Null),
                        r.get("mode").and_then(|m| m.as_str()).unwrap_or("").to_string(),
                        None,
                    )
                } else {
                    (
                        Value::Null,
                        String::new(),
                        Some(
                            r.get("error")
                                .and_then(|e| e.as_str())
                                .unwrap_or("")
                                .to_string(),
                        ),
                    )
                }
            }
            None => (
                selection_of(c.sel, &options, &ids),
                c.mode.to_string(),
                None,
            ),
        };
        let entry = match preset_error {
            Some(err) => json!({ "presetError": err }),
            None => {
                let r = rp::build_profile(&features, &options, &mode);
                json!({
                    "mode": mode,
                    "profile": rp::profile_text(&r.json),
                    "written": r.written,
                    "skipped": r.skipped,
                    "commandExtras": r.command_extras
                })
            }
        };
        cases.insert(c.name.to_string(), entry);
    }
    let mut table = rust_table().as_object().unwrap().clone();
    table.insert("ids".to_string(), json!(ids));
    table.insert("cases".to_string(), Value::Object(cases));
    Value::Object(table)
}

/// 两边都是 `{...}` 时给第一个不同的字符位置，否则只说长度 —— 失败信息要能直接指到那一格。
fn first_diff(a: &str, b: &str) -> String {
    if a == b {
        return "两串相同".to_string();
    }
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    let n = ab.len().min(bb.len());
    for i in 0..n {
        if ab[i] != bb[i] {
            // 按字节切会在多字节字符中间 panic(skipped 的 why 里有中文),把切点挪到字符边界
            let mut s = i.saturating_sub(24);
            while !a.is_char_boundary(s) {
                s += 1;
            }
            let mut ea = (i + 24).min(a.len());
            while !a.is_char_boundary(ea) {
                ea -= 1;
            }
            let mut eb = (i + 24).min(b.len());
            while !b.is_char_boundary(eb) {
                eb -= 1;
            }
            return format!("第 {i} 字节起不同:a={:?} b={:?}", &a[s..ea], &b[s..eb]);
        }
    }
    format!("前 {n} 字节相同但长度不同:a={} 字节 b={} 字节", a.len(), b.len())
}

#[test]
fn tpl_profile_text_is_byte_identical_between_js_and_rust() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let opts_file = repo.join("src-tauri/tests/fixtures/tpl_options.json");
    let fixture: Value = serde_json::from_str(&fs::read_to_string(&opts_file).expect("读夹具"))
        .expect("夹具是合法 JSON");

    // 自检(同 tauriShimHonesty 第 0 节的道理):比对式必须分得开「相同」与「差一个字符」,
    // 否则下面那一整圈 assert 会一起静默通过。
    assert_eq!(first_diff("abc", "abc"), "两串相同", "first_diff 把相同说成了不同");
    assert!(
        first_diff("ab c", "ab x").contains("第 3 字节"),
        "first_diff 指不出差异位置:{}",
        first_diff("ab c", "ab x")
    );

    let base = std::env::temp_dir().join(format!("gpm-tpl-parity-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let script = base.join("js-harness.js");
    fs::write(&script, JS_HARNESS).unwrap();
    let cfg_file = base.join("js-cfg.json");
    fs::write(
        &cfg_file,
        json!({ "repo": repo, "optsFile": opts_file, "cases": cases_spec_json() }).to_string(),
    )
    .unwrap();

    let js: Value = match Command::new("node").arg(&script).arg(&cfg_file).output() {
        Err(e) => panic!(
            "环境里找不到 node({e})—— 双端对照没有 JS 这半边就没有意义,这里按失败处理而不是跳过"
        ),
        Ok(out) => {
            if !out.status.success() {
                panic!(
                    "JS harness 退出非零:{}",
                    String::from_utf8_lossy(&out.stderr)
                );
            }
            serde_json::from_slice(&out.stdout).expect("JS 侧输出的是 JSON")
        }
    };

    let rs = rust_side(&fixture);

    // 1) 夹具覆盖度:JS 表里出现而夹具没有(且不在留白名单里)的 flag —— 有人加功能没重造夹具就会红
    assert_eq!(
        js["flagsMissing"],
        json!([]),
        "夹具缺 flag:请重造 tests/fixtures/tpl_options.json"
    );

    // 2) 能力表逐格对照(含顺序):表一漂移,后面的 profile 差异根本无从归因
    assert_eq!(js["groups"], rs["groups"], "TPL_GROUPS 分组顺序两端不一致");
    assert_eq!(
        js["features"], rs["features"],
        "TPL_FEATURES 两端不一致(含 id/label/group/desc/sizeImpact/risk/flags 每一格与每一行顺序)"
    );
    assert_eq!(js["ids"], rs["ids"], "TPL_FEATURES 的 id 序列两端不一致");
    let ids_len = js["ids"].as_array().map(|a| a.len()).unwrap_or(0);
    assert!(ids_len >= 50, "拆出 {ids_len} 个面板项,少于 50 说明取数方式错了而不是表干净了");

    // 3) 用例键集合双向核账:一边漏跑某例不能算绿
    let jc = js["cases"].as_object().unwrap();
    let rc = rs["cases"].as_object().unwrap();
    assert_eq!(jc.keys().collect::<Vec<_>>(), rc.keys().collect::<Vec<_>>(), "用例集合不一致");
    assert_eq!(jc.len(), CASES.len(), "用例数对不上 CASES 表");

    // 3.5) 序列化器自己的逐字节口径(§5.2 取证表里最尖的一格:空 dbo 必须是内联 `{}`)
    assert_eq!(
        rp::profile_text(&json!({ "disabled_build_options": {} })),
        "{\n  \"disabled_build_options\": {}\n}",
        "空 dbo 的内联形态不对,后面所有例都会跟着偏"
    );

    // 4) 逐例逐字节
    let mut compared = 0usize;
    for c in CASES.iter() {
        let j = &jc[c.name];
        let r = &rc[c.name];
        if let (Some(je), Some(re)) = (j.get("presetError"), r.get("presetError")) {
            assert_eq!(je, re, "用例 {} 的预设报错文案不一致", c.name);
            compared += 1;
            continue;
        }
        assert_eq!(
            j["presetError"], r["presetError"],
            "用例 {} 一边判成预设报错、一边不是",
            c.name
        );
        assert_eq!(j["mode"], r["mode"], "用例 {} 的 mode 两端不一致", c.name);
        let jp = j["profile"].as_str().unwrap();
        let rp_text = r["profile"].as_str().unwrap();
        assert_eq!(
            jp, rp_text,
            "用例 {} 的 profile 不是逐字节相同 → {}",
            c.name,
            first_diff(jp, rp_text)
        );
        assert_eq!(j["commandExtras"], r["commandExtras"], "用例 {} 的 commandExtras 不一致", c.name);
        assert_eq!(j["written"], r["written"], "用例 {} 的 written(排序后)不一致", c.name);
        assert_eq!(j["skipped"], r["skipped"], "用例 {} 的 skipped(遇到顺序)不一致", c.name);
        compared += 1;
    }
    assert!(compared >= CASES.len(), "实际比对 {compared} 例,少于 {}", CASES.len());
    println!("  parity OK:{compared} 例逐字节相同,面板项 {ids_len} 个两端一致");

    let _ = fs::remove_dir_all(&base);
}
