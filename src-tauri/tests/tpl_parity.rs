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
use godot_workshop::tpl::probe as tp;
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

/// 探测层 + 链式（真探测 → 真 profile）的第二轮对照。
/// 为什么单开一轮：第一轮比的是「给定一张选项表，两端算出的 profile 一样」，
/// 那还没证明**选项表本身**两端读得一样 —— 这一轮从真源码树开始，把探测也纳入逐字节对照，
/// 最后一格 `chain-profile` 才是「两端拿同一份源码会编出同一个产物」的正证。
const JS_PROBE_HARNESS: &str = r###"
const fs = require('node:fs')
const path = require('node:path')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const B = require(path.join(cfg.repo, 'src-ztools/preload/lib/tplprobe.js'))
const P = require(path.join(cfg.repo, 'src-ztools/preload/lib/tplprofile.js'))
const tree = cfg.tree

;(async () => {
  const cases = {}
  const a = await B.probeSource(tree)
  cases['probe'] = JSON.stringify(a)
  cases['probe-tag-same'] = JSON.stringify(await B.probeSource(tree, { targetTag: '4.7.2-stable' }))
  cases['probe-tag-other'] = JSON.stringify(await B.probeSource(tree, { targetTag: '4.3-stable' }))
  cases['probe-not-root'] = JSON.stringify(await B.probeSource(path.join(tree, 'platform')))
  cases['probe-missing'] = JSON.stringify(await B.probeSource(path.join(tree, 'no-such-dir')))
  const sel = P.initialSelection(a.options)
  const r = P.buildProfile(sel, a.options, { mode: 'default-on' })
  cases['chain-profile'] = P.profileText(r.json) + '\n' + JSON.stringify(r.commandExtras)
  process.stdout.write(JSON.stringify({ cases }))
})()
"###;

fn rust_probe_side(tree: &Path) -> Map<String, Value> {
    let s = |v: Value| Value::String(serde_json::to_string(&v).unwrap());
    let a = tp::probe_source(tree, None);
    let mut cases = Map::new();
    cases.insert("probe".into(), s(a.clone()));
    cases.insert("probe-tag-same".into(), s(tp::probe_source(tree, Some("4.7.2-stable"))));
    cases.insert("probe-tag-other".into(), s(tp::probe_source(tree, Some("4.3-stable"))));
    cases.insert("probe-not-root".into(), s(tp::probe_source(&tree.join("platform"), None)));
    cases.insert("probe-missing".into(), s(tp::probe_source(&tree.join("no-such-dir"), None)));
    let options = a.get("options").cloned().unwrap_or(json!({}));
    let sel = rp::initial_selection(&options);
    let r = rp::build_profile(&sel, &options, "default-on");
    cases.insert(
        "chain-profile".into(),
        Value::String(format!("{}\n{}", rp::profile_text(&r.json), serde_json::to_string(&r.command_extras).unwrap())),
    );
    cases
}

/// 递归按键排序后再紧凑序列化。
/// 为什么探测结果要这么做而 profile 不用：`options` 里模块键的**插入顺序**由 `readdir` 决定，
/// 那是操作系统的行为不是语义（node 与 Rust 的 read_dir 不保证同一序）；把它算成两端不一致
/// 就是拿环境问题冒充判据漂移。profile 那一侧顺序由构造保证（sortKeys + token 字典序），
/// 所以 `chain-profile` 这一例仍按原样逐字节比（本函数对非 JSON 串直接原样返回）。
fn canon(s: &str) -> String {
    let Ok(v) = serde_json::from_str::<Value>(s) else {
        return s.to_string();
    };
    fn sort_deep(v: Value) -> Value {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<String> = m.keys().cloned().collect();
                keys.sort();
                let mut out = Map::new();
                for k in keys {
                    out.insert(k.clone(), sort_deep(m[&k].clone()));
                }
                Value::Object(out)
            }
            Value::Array(a) => Value::Array(a.into_iter().map(sort_deep).collect()),
            other => other,
        }
    }
    serde_json::to_string(&sort_deep(v)).unwrap()
}

#[test]
fn tpl_probe_and_profile_chain_are_byte_identical() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let tree = repo.join("src-tauri/tests/fixtures/tplsrc");
    assert!(tree.join("SConstruct").exists(), "夹具树没了：重造方法见 tplsrc/MANIFEST.md");

    let base = std::env::temp_dir().join(format!("gpm-tpl-probe-parity-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let script = base.join("js-probe.js");
    fs::write(&script, JS_PROBE_HARNESS).unwrap();
    let cfg_file = base.join("js-cfg.json");
    fs::write(&cfg_file, json!({ "repo": repo, "tree": tree }).to_string()).unwrap();

    let js: Value = match Command::new("node").arg(&script).arg(&cfg_file).output() {
        Err(e) => panic!("环境里找不到 node({e})—— 按失败处理,不静默跳过"),
        Ok(out) => {
            if !out.status.success() {
                panic!("JS probe harness 退出非零:{}", String::from_utf8_lossy(&out.stderr));
            }
            serde_json::from_slice(&out.stdout).expect("JS 侧输出的是 JSON")
        }
    };

    let jc = js["cases"].as_object().unwrap().clone();
    let rc = rust_probe_side(&tree);
    let mut keys: Vec<&String> = jc.keys().collect();
    keys.sort();
    let mut rkeys: Vec<&String> = rc.keys().collect();
    rkeys.sort();
    assert_eq!(keys, rkeys, "探测对照用例集合两端不一致");
    assert!(jc.len() >= 6, "只有 {} 例,少于 6 说明取数方式错了", jc.len());

    // 自检:这几例本就两两不同,若 harness 忘了传 targetTag 就会全等 → 下面的比对成了自证
    assert_ne!(jc["probe"], jc["probe-tag-same"], "probe 与 probe-tag-same 相同 = targetTag 没生效");
    assert_ne!(jc["probe-tag-same"], jc["probe-tag-other"], "两个 targetTag 结果相同 = tagMatched 没参与判定");

    let n = keys.len();
    for k in keys {
        let j = canon(jc[k].as_str().unwrap());
        let r = canon(rc[k].as_str().unwrap());
        assert_eq!(j, r, "探测对照用例 {k} 不是逐字节相同 → {}", first_diff(&j, &r));
    }
    println!("  探测 parity OK:{n} 例逐字节相同(含 chain-profile)");
    let _ = fs::remove_dir_all(&base);
}

/// 第三轮：校验层与连带层（`validateSelection` / `selectionSuppressed` / `PRESETS.apply`）。
/// 这一层是「用户勾坏了什么、我们敢不敢让他编」的判据所在，三条硬拦与五条软问题
/// 每一条都有真实成因（见 tplprofile.js:422-580 的注释），所以逐格对照而不是抽查。
const JS_VALIDATE_HARNESS: &str = r###"
const fs = require('node:fs')
const path = require('node:path')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const B = require(path.join(cfg.repo, 'src-ztools/preload/lib/tplprobe.js'))
const P = require(path.join(cfg.repo, 'src-ztools/preload/lib/tplprofile.js'))
const F = require(path.join(cfg.repo, 'src-ztools/preload/lib/tplfeatures.js'))

;(async () => {
  const probe = await B.probeSource(cfg.tree)
  const opts = probe.options
  const sel = P.initialSelection(opts)
  const allOff = Object.fromEntries(F.TPL_FEATURES.map((f) => [f.id, false]))
  const cases = {}
  const put = (k, v) => { cases[k] = JSON.stringify(v) }
  put('v:default', P.validateSelection(sel, opts, { mode: 'default-on' }))
  put('v:off-mode', P.validateSelection(sel, opts, { mode: 'default-off' }))
  put('v:sdk-missing', P.validateSelection(sel, opts, { mode: 'default-on', d3d12SdkInstalled: false, accesskitSdkInstalled: false }))
  put('v:untested', P.validateSelection(sel, opts, { mode: 'default-on', untestedSource: true }))
  put('v:all-off', P.validateSelection(allOff, opts, { mode: 'default-off' }))
  put('v:no-selection', P.validateSelection({}, opts, { mode: 'default-on' }))
  put('v:no-options', P.validateSelection(sel, undefined, { mode: 'default-on' }))
  put('v:no-ctx', P.validateSelection(sel, opts))
  put('s:default', P.selectionSuppressed(sel, probe.cascades))
  const off3d = Object.assign({}, sel, { sys3d: false })
  put('s:3d-off', P.selectionSuppressed(off3d, probe.cascades))
  put('s:no-selection', P.selectionSuppressed({}, probe.cascades))
  put('s:no-graph', P.selectionSuppressed(off3d, undefined))
  put('p:full', P.PRESETS.apply('full', opts))
  put('p:minimal', P.PRESETS.apply('minimal', opts))
  process.stdout.write(JSON.stringify({ cases, sourceVersion: probe.sourceVersion }))
})()
"###;

fn rust_validate_side(tree: &Path) -> (Map<String, Value>, String) {
    use rp::ValidateCtx;
    let probe = tp::probe_source(tree, None);
    let opts = probe.get("options").cloned().unwrap_or(json!({}));
    let cascades = probe.get("cascades").cloned().unwrap_or(json!({}));
    let sel = rp::initial_selection(&opts);
    let all_off = {
        let mut m = Map::new();
        for f in features::features() {
            m.insert(f.id.to_string(), Value::Bool(false));
        }
        Value::Object(m)
    };
    let mut cases = Map::new();
    let mut put = |k: &str, v: Value| {
        cases.insert(k.to_string(), Value::String(serde_json::to_string(&v).unwrap()));
    };
    let c = |mode: &str, d3d: Option<bool>, ak: Option<bool>, untested: Option<bool>| ValidateCtx {
        mode: mode.to_string(),
        d3d12_sdk_installed: d3d,
        accesskit_sdk_installed: ak,
        untested_source: untested,
    };
    put("v:default", rp::validate_selection(&sel, &opts, Some(&c("default-on", None, None, None))));
    put("v:off-mode", rp::validate_selection(&sel, &opts, Some(&c("default-off", None, None, None))));
    put("v:sdk-missing", rp::validate_selection(&sel, &opts, Some(&c("default-on", Some(false), Some(false), None))));
    put("v:untested", rp::validate_selection(&sel, &opts, Some(&c("default-on", None, None, Some(true)))));
    put("v:all-off", rp::validate_selection(&all_off, &opts, Some(&c("default-off", None, None, None))));
    put("v:no-selection", rp::validate_selection(&json!({}), &opts, Some(&c("default-on", None, None, None))));
    put("v:no-options", rp::validate_selection(&sel, &Value::Null, Some(&c("default-on", None, None, None))));
    put("v:no-ctx", rp::validate_selection(&sel, &opts, None));
    put("s:default", rp::selection_suppressed(&sel, &cascades));
    let off3d = {
        let mut m = sel.as_object().cloned().unwrap();
        m.insert("sys3d".into(), Value::Bool(false));
        Value::Object(m)
    };
    put("s:3d-off", rp::selection_suppressed(&off3d, &cascades));
    put("s:no-selection", rp::selection_suppressed(&json!({}), &cascades));
    put("s:no-graph", rp::selection_suppressed(&off3d, &Value::Null));
    put("p:full", rp::presets_apply("full", &opts));
    put("p:minimal", rp::presets_apply("minimal", &opts));
    let sv = probe.get("sourceVersion").and_then(|v| v.as_str()).unwrap_or("").to_string();
    (cases, sv)
}

#[test]
fn tpl_validate_and_cascade_rules_are_byte_identical() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let tree = repo.join("src-tauri/tests/fixtures/tplsrc");
    let base = std::env::temp_dir().join(format!("gpm-tpl-validate-parity-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let script = base.join("js-validate.js");
    fs::write(&script, JS_VALIDATE_HARNESS).unwrap();
    let cfg_file = base.join("js-cfg.json");
    fs::write(&cfg_file, json!({ "repo": repo, "tree": tree }).to_string()).unwrap();

    let js: Value = match Command::new("node").arg(&script).arg(&cfg_file).output() {
        Err(e) => panic!("环境里找不到 node({e})—— 按失败处理,不静默跳过"),
        Ok(out) => {
            if !out.status.success() {
                panic!("JS validate harness 退出非零:{}", String::from_utf8_lossy(&out.stderr));
            }
            serde_json::from_slice(&out.stdout).expect("JS 侧输出的是 JSON")
        }
    };

    let (rc, rs_sv) = rust_validate_side(&tree);
    assert_eq!(js["sourceVersion"], json!(rs_sv), "两端读出的源码版本串不一致");
    assert_eq!(rs_sv, "4.7.2-stable", "夹具版本变了?对照用例的期望要跟着重看");

    let jc = js["cases"].as_object().unwrap().clone();
    let mut jkeys: Vec<&String> = jc.keys().collect();
    let mut rkeys: Vec<&String> = rc.keys().collect();
    jkeys.sort();
    rkeys.sort();
    assert_eq!(jkeys, rkeys, "校验层用例集合两端不一致");
    assert!(jkeys.len() >= 14, "只有 {} 例,少于 14 说明漏跑了", jkeys.len());

    // 自检:这一轮的产出不能全同(全同 = ctx 与 selection 压根没参与判定,harness 白跑)。
    // 刻意**不**去钉「哪两例必须不同」：第一版写了 `v:default != v:off-mode`，实跑直接假红 ——
    // 初始勾选下没有任何项被关，这两例的产物本就一样。哪对例子有区分度由数据说，不由猜说。
    use std::collections::HashSet;
    let distinct: HashSet<String> = jkeys
        .iter()
        .filter_map(|k| jc.get((*k).as_str()).and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    assert!(
        distinct.len() >= 4,
        "校验层 {} 例只产出 {} 种结果,ctx 或 selection 没参与判定",
        jkeys.len(),
        distinct.len()
    );

    for k in jkeys {
        let j = canon(jc[k].as_str().unwrap());
        let r = canon(rc[k].as_str().unwrap());
        assert_eq!(j, r, "校验层用例 {k} 不是逐字节相同 → {}", first_diff(&j, &r));
    }
    println!("  校验层 parity OK:{} 例逐字节相同", jc.len());
    let _ = fs::remove_dir_all(&base);
}

/// 第四轮：宿主组合层（`services.js:61-131` ↔ `tpl/api.rs`）。
///
/// 为什么值得单开一轮：这份组合在 JS 侧**没有运行时测试**（`services.test.js` 比的是方法名与类型，
/// 判据那部分它直接调 lib 拿），所以桌面版面板真正吃的这一层是第一次被测。
/// harness 里的组合是 services.js 的**镜像**，镜像会漂 —— 于是 `SERVICES_GUARD` 拿源码扫描钉住
/// 四句承重文案与判据：改了 services.js 而没同步 harness，红在这里，而不是让桌面版悄悄分叉。
const JS_API_HARNESS: &str = r###"
const fs = require('node:fs')
const path = require('node:path')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const B = require(path.join(cfg.repo, 'src-ztools/preload/lib/tplprobe.js'))
const P = require(path.join(cfg.repo, 'src-ztools/preload/lib/tplprofile.js'))
const F = require(path.join(cfg.repo, 'src-ztools/preload/lib/tplfeatures.js'))

// ---- 以下三段逐字镜像 services.js:63-131（受 SERVICES_GUARD 约束）----
async function listTemplateFeatures(srcDir) {
  const probe = await B.probeSource(srcDir)
  if (!probe.ok) return { ok: false, error: probe.error }
  if (Object.keys(probe.options).length === 0) {
    return { ok: false, error: '无法解析此版本源码的构建选项（源码结构可能已变）' }
  }
  const sel = P.initialSelection(probe.options)
  const cascadeSources = Object.keys(probe.cascades)
  const items = F.TPL_FEATURES.map((f) => {
    const present = f.flags.some((k) => probe.options[k] && probe.options[k].exists)
    const cascadedBy = cascadeSources.find((srcFlag) => probe.cascades[srcFlag].some((t) => f.flags.includes(t)))
    return {
      id: f.id, label: f.label, group: f.group, desc: f.desc,
      sizeImpact: f.sizeImpact, risk: f.risk, flags: f.flags,
      present,
      defaultOn: !!sel[f.id],
      ...(cascadedBy ? { cascadedBy } : {})
    }
  })
  return { ok: true, items }
}
async function validateTemplateConfig(params) {
  const probe = await B.probeSource(params.srcDir)
  const untestedSource = !probe.tested
  const r = P.validateSelection(params.features, probe.options || {}, {
    mode: params.mode,
    d3d12SdkInstalled: params.d3d12SdkInstalled,
    accesskitSdkInstalled: params.accesskitSdkInstalled,
    untestedSource
  })
  return {
    ok: r.hardBlocks.length === 0,
    issues: r.issues,
    hardBlocks: r.hardBlocks,
    suppressed: P.selectionSuppressed(params.features, probe.cascades || {})
  }
}
async function applyTemplatePreset(name, srcDir) {
  const probe = await B.probeSource(srcDir)
  if (!probe.ok) return { ok: false, error: probe.error || '无法探测这份源码' }
  const r = P.PRESETS.apply(name, probe.options)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, features: r.features, mode: r.mode }
}

;(async () => {
  const t = cfg.tree
  const probe = await B.probeSource(t)
  const sel = P.initialSelection(probe.options)
  const cases = {}
  cases['features'] = JSON.stringify(await listTemplateFeatures(t))
  cases['features-notroot'] = JSON.stringify(await listTemplateFeatures(path.join(t, 'platform')))
  cases['features-empty'] = JSON.stringify(await listTemplateFeatures(cfg.junk))
  cases['validate'] = JSON.stringify(await validateTemplateConfig({ srcDir: t, features: sel, mode: 'default-on' }))
  cases['validate-off'] = JSON.stringify(await validateTemplateConfig({ srcDir: t, features: sel, mode: 'default-off', d3d12SdkInstalled: false }))
  cases['validate-notroot'] = JSON.stringify(await validateTemplateConfig({ srcDir: path.join(t, 'platform'), features: {}, mode: 'default-on' }))
  cases['preset-minimal'] = JSON.stringify(await applyTemplatePreset('minimal', t))
  cases['preset-unknown'] = JSON.stringify(await applyTemplatePreset('nope', t))
  cases['preset-notroot'] = JSON.stringify(await applyTemplatePreset('full', path.join(t, 'platform')))
  process.stdout.write(JSON.stringify({ cases }))
})()
"###;

/// harness 镜像的判据必须仍是 services.js 里的那几句 —— 改了那边不同步这里就该红
const SERVICES_GUARD: [&str; 5] = [
    "return { ok: false, error: probe.error }",
    "无法解析此版本源码的构建选项（源码结构可能已变）",
    "const present = f.flags.some((k) => probe.options[k] && probe.options[k].exists)",
    "suppressed: tplprofile.selectionSuppressed(params.features, probe.cascades || {})",
    "if (!probe.ok) return { ok: false, error: probe.error || '无法探测这份源码' }",
];

fn rust_api_side(tree: &Path, junk: &Path) -> Map<String, Value> {
    use godot_workshop::tpl::api;
    let probe = tp::probe_source(tree, None);
    let options = probe.get("options").cloned().unwrap_or(json!({}));
    let sel = rp::initial_selection(&options);
    let mut cases = Map::new();
    let mut put = |k: &str, v: Value| {
        cases.insert(k.to_string(), Value::String(serde_json::to_string(&v).unwrap()));
    };
    let notroot = tree.join("platform");
    put("features", api::list_template_features(&tree.to_string_lossy()));
    put("features-notroot", api::list_template_features(&notroot.to_string_lossy()));
    put("features-empty", api::list_template_features(&junk.to_string_lossy()));
    put("validate", api::validate_template_config(&json!({ "srcDir": tree.to_string_lossy(), "features": sel, "mode": "default-on" })));
    put("validate-off", api::validate_template_config(&json!({ "srcDir": tree.to_string_lossy(), "features": sel, "mode": "default-off", "d3d12SdkInstalled": false })));
    put("validate-notroot", api::validate_template_config(&json!({ "srcDir": notroot.to_string_lossy(), "features": {}, "mode": "default-on" })));
    put("preset-minimal", api::apply_template_preset("minimal", &tree.to_string_lossy()));
    put("preset-unknown", api::apply_template_preset("nope", &tree.to_string_lossy()));
    put("preset-notroot", api::apply_template_preset("full", &notroot.to_string_lossy()));
    cases
}

#[test]
fn tpl_host_composition_matches_services_js_byte_for_byte() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let tree = repo.join("src-tauri/tests/fixtures/tplsrc");

    let services = fs::read_to_string(repo.join("src-ztools/preload/services.js")).unwrap();
    for line in SERVICES_GUARD.iter() {
        assert!(services.contains(line), "services.js 的组合层改了,但 harness 镜像没同步:缺 {line:?}");
    }

    let base = std::env::temp_dir().join(format!("gpm-tpl-api-parity-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    // 两支闸的第②支要的是「SConstruct 在、但一个构建选项都解析不出来」——现造一棵这种树,
    // 两端共用同一个路径(不是各造一份),否则比的不是同一份输入。
    let junk = base.join("junksrc");
    fs::create_dir_all(&junk).unwrap();
    fs::write(junk.join("SConstruct"), "# 一个 BoolVariable 都没有的源码根\n").unwrap();

    let script = base.join("js-api.js");
    fs::write(&script, JS_API_HARNESS).unwrap();
    let cfg_file = base.join("js-cfg.json");
    fs::write(&cfg_file, json!({ "repo": repo, "tree": tree, "junk": junk }).to_string()).unwrap();

    let js: Value = match Command::new("node").arg(&script).arg(&cfg_file).output() {
        Err(e) => panic!("环境里找不到 node({e})—— 按失败处理,不静默跳过"),
        Ok(out) => {
            if !out.status.success() {
                panic!("JS api harness 退出非零:{}", String::from_utf8_lossy(&out.stderr));
            }
            serde_json::from_slice(&out.stdout).expect("JS 侧输出的是 JSON")
        }
    };

    let rc = rust_api_side(&tree, &junk);
    let jc = js["cases"].as_object().unwrap().clone();
    let mut jkeys: Vec<&String> = jc.keys().collect();
    let mut rkeys: Vec<&String> = rc.keys().collect();
    jkeys.sort();
    rkeys.sort();
    assert_eq!(jkeys, rkeys, "组合层用例集合两端不一致");
    assert!(jkeys.len() >= 9, "只有 {} 例,少于 9 说明漏跑了", jkeys.len());

    let n = jkeys.len();
    for k in jkeys {
        let j = canon(jc[k].as_str().unwrap());
        let r = canon(rc[k].as_str().unwrap());
        assert_eq!(j, r, "组合层用例 {k} 不是逐字节相同 → {}", first_diff(&j, &r));
    }
    println!("  组合层 parity OK:{n} 例逐字节相同(含两支拒绝进面板的闸)", );
    let _ = fs::remove_dir_all(&base);
}
