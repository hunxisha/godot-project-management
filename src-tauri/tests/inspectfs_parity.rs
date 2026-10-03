//! 工具页四原语的**双端语义对齐**验收(JS `src-ztools/preload/lib/inspectfs.js` ↔
//! Rust `src-tauri/src/inspectfs.rs`)。运行:
//!
//! ```text
//! cargo test --test inspectfs_parity -- --ignored --nocapture
//! ```
//!
//! 为什么存在(Task 8 把 brief 里「手工开 devtools 贴 JSON 对一眼」换成自动化,是主控的裁定):
//! 手工检查跑不了第二遍,而「没人再打开 GUI」正是双端语义漂移的温床。这里把两端拉进同一次
//! 运行:**同一棵确定性夹具树**,JS 侧经 `node` 子进程跑真原语、Rust 侧在进程内跑镜像实现,
//! 逐字段比对。JS 是语义权威 —— 红了先修 Rust。
//!
//! # 覆盖清单
//! * `scanProjectTree` / `collect_tree`:默认(跳过任意层级 `.godot`)、`includeCache`、
//!   `exts` 过滤(含大写扩展名)、`skipDirs`、`maxEntries` 截断;逐条比对**排序后的 rel 序列**、
//!   每个 rel 的 `size` 与 `ext`、`truncated` 标志,并要求两端 `mtimeMs > 0`。
//! * `readProjectText` / `read_text_json`:普通文本、超限额(truncated)、前 512 字节含 NUL
//!   (skippedBinary)、`maxBytes:4`、`maxBytes:0` 回落默认、文件不存在、rel 指向目录、
//!   `..` 越界、绝对盘符、空 rel、无根('项目不存在')、**穿过项目内链接读到项目外**(包含闸)。
//! * `writeProjectText` / `write_text_json`:新建(无备份 → **省略 backupRel 键**)、覆写(备份
//!   marker 收尾)、`backup:false`、目标是目录、缺父目录、`..` 越界;并比对**落盘后果**
//!   (顶层名字序列、备份戳归一后、不留 `.gpm-tmp-*` 残骸)。
//! * `movePathsToTrash` / `trash_json`:空清单、闸拒绝(rel 原样回报)、缺失项(rel 归一回报)、
//!   重复点名、**非数组入参**(JS 视为空清单 ↔ Rust 的 `Vec<String>` 只能收到数组,故与空清单
//!   同形 —— 这条正是 tauri-shim 里 `Array.isArray` 归一的依据)。
//!
//! # 刻意排除(按规则,不是漏掉)
//! 1. **`mtimeMs` 的数值**:JS 是 `Math.round(st.mtimeMs)`、Rust 是整数截断,备份名里的
//!    `stamp_sec` 又是 UTC 民政历而 JS 是本地历(见 inspectfs.rs 模块头)。这里只断言两端
//!    `mtimeMs > 0`,并**不**比数值;备份名把 `\d{8}_\d{4}_\d{2}` 归一成 `TS` 后再比形状。
//! 2. **非 UTF-8 且不含 NUL 的分类**:JS 返回带 U+FFFD 的 text,Rust 判 `skippedBinary`
//!    (两端类型系统使然,inspectfs.rs 模块头已记为「已知且刻意保留」)。这一条不是「不比」,
//!    而是**钉住两端当前形态**,哪天哪边变了本测试会响。
//! 3. **遍历失败的错误文案**(Task 2 裁定):根不可读 / 不存在时,JS 给 `e.message` 或
//!    '项目目录已不存在',Rust 给 '项目目录不可读' —— **只有 `ok` 可比**。
//! 4. **`'内容不是文本'`**:Rust 的 `text: &str` 在类型层就挡死了非字符串(Tauri 反序列化先
//!    失败),这条串在 Rust 侧不可达;同样只钉住 JS 侧形态。
//! 5. **真正落回收站那一步**:两端各自依赖回收站 / PowerShell,机器相关(同一台机器上一边成功
//!    一边失败会假红)。移入回收站的**复核计数逻辑**由两侧各自的单测钉住
//!    (`inspectfs.rs::trash_reports_failures_without_interrupting` 与 `inspectfs.test.js` 第 6 节),
//!    这里只比对不碰盘的闸与形态。
//! 6. `'参数不合法'`(tauri-shim 的兜底文案)是**垫片专属**,不在 JS↔Rust 原语契约里,
//!    Rust 侧无需镜像,故不进本对照。
//! 7. **`maxEntries` 截断那一例只比 `truncated` 与条数**:两端遍历顺序不同(栈式 DFS vs 递归 DFS),
//!    截断时**留下的到底是哪几条**本就不同,比它等于比随机数。
//!
//! # 链接夹具
//! 夹具里放一条**指向树外的 junction** 和一条**悬空链接**(Windows 用 `cmd /C mklink /J`,
//! 不需要管理员权限;失败再退 `symlink_dir`)。链接**创建失败时相关断言可见地跳过**,
//! 绝不记成通过 —— 与 JS 侧 `skipAssert` 同一套诚实纪律。

#![cfg(test)]

use godot_workshop::inspectfs::{
    collect_tree, read_text_json, scan_json, trash_json, write_text_json, ScanOpts, TreeEntry, DEFAULT_MAX_BYTES,
};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// 夹具树里的一份普通文本(写/备份用例的目标)。
const TARGET_CONTENT: &[u8] = b"OLD-W\n";
/// 超过 `DEFAULT_MAX_BYTES` 的文件,用来比对 truncated + bytes。
const BIG_BYTES: usize = 1024 * 1024 + 4096;

/// 固定相对布局(正斜杠)。`collect_tree` 是栈式 DFS、`walkFiles` 是递归 DFS,
/// 两端**顺序必然不同**,所以对照一律在排序之后做。
fn fixture_files() -> Vec<(String, Vec<u8>)> {
    vec![
        ("project.godot".into(), b"[application]\nconfig_version=5\n".to_vec()),
        (".godot/editor.thm".into(), b"CACHE-ROOT\n".to_vec()),
        ("sub/child.gd".into(), b"extends Node\n".to_vec()),
        ("sub/.godot/x".into(), b"CACHE-NESTED\n".to_vec()),
        ("sub/deep/deep.txt".into(), b"DEEP\n".to_vec()),
        ("tools/main.gd".into(), b"@tool\nextends Node\n".to_vec()),
        ("sub.d/x".into(), b"DOTTED-DIR\n".to_vec()),
        ("README.MD".into(), b"# hi\n".to_vec()),
        (".gitignore".into(), b"*.import\n".to_vec()),
        ("LICENSE".into(), b"MIT\n".to_vec()),
        ("tiny.svg".into(), b"<svg/>".to_vec()),
        ("big.txt".into(), vec![b'a'; BIG_BYTES]),
        ("nul.bin".into(), b"AB\0CD\n".to_vec()),
        // 非法 UTF-8 且**不含** NUL:排除项 2 的钉桩样本
        ("notutf.dat".into(), vec![b'c', 0xC3, 0x28, b'a', b'\n']),
        ("tmp/skipme.txt".into(), b"TMP\n".to_vec()),
        ("w-target.txt".into(), TARGET_CONTENT.to_vec()),
    ]
}

fn fixture_dirs() -> Vec<&'static str> {
    vec![".godot", "empty", "sub", "sub/.godot", "sub/deep", "sub.d", "tmp", "tools"]
}

fn write_fixture_tree(base: &Path) {
    fs::create_dir_all(base).expect("建夹具根目录");
    for d in fixture_dirs() {
        fs::create_dir_all(base.join(d)).expect("建夹具子目录");
    }
    for (rel, content) in fixture_files() {
        fs::write(base.join(rel), content).expect("写夹具文件");
    }
}

/// 链接夹具的落地情况。`None` 一律配一条**可见** SKIP,不记通过。
struct Links {
    /// 指向树外目录的链接(树内条目 `evil-link`)
    junction: bool,
    /// 指向不存在的目录的悬空链接(`dangling`)
    dangling: bool,
    why: String,
}

#[cfg(windows)]
fn try_link(target: &Path, link: &Path) -> Result<(), String> {
    // 先试 junction(`cmd /C mklink /J`):无需管理员权限,而且它的 reparse tag 是
    // IO_REPARSE_TAG_MOUNT_POINT —— 正是「std 可能把它当普通目录」的那一类,
    // 而 Node 的 Dirent 对它报 isSymbolicLink()。两端在这里最容易分道扬镳。
    let out = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .map_err(|e| format!("exec mklink: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    // 退路:开发者模式下的真目录符号链接
    std::os::windows::fs::symlink_dir(target, link).map(|_| ()).map_err(|e| format!("symlink_dir: {e}"))
}

#[cfg(not(windows))]
fn try_link(target: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link).map(|_| ()).map_err(|e| format!("symlink: {e}"))
}

/// 在 `tree` 里造两条链接。任何一条失败都只是少一份覆盖(可见跳过)。
fn build_links(tree: &Path, outside: &Path, missing_target: &Path) -> Links {
    fs::create_dir_all(outside).expect("建树外目录");
    fs::write(outside.join("evil.txt"), b"OUTSIDE-SECRET\n").expect("写树外文件");
    let mut why: Vec<String> = Vec::new();
    let jl = tree.join("evil-link");
    let junction = match try_link(outside, &jl) {
        // 必须**真的穿过它看到树外内容**才算这条覆盖成立
        Ok(()) if fs::read(jl.join("evil.txt")).is_ok() => true,
        Ok(()) => {
            why.push("evil-link: 建出来了但落点读不到".to_string());
            false
        }
        Err(e) => {
            why.push(format!("evil-link: {e}"));
            false
        }
    };
    let dl = tree.join("dangling");
    let dangling = match try_link(missing_target, &dl) {
        Ok(()) => true,
        Err(e) => {
            why.push(format!("dangling: {e}"));
            false
        }
    };
    Links { junction, dangling, why: if why.is_empty() { "两条链接都建成".into() } else { why.join(" / ") } }
}

/// 顶层条目名(备份戳归一后),用来比对**落盘后果**。两端同法:只看顶层、排序。
fn top_names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default();
    v.sort();
    v.into_iter().map(|n| norm_stamp(&n)).collect()
}

/// 把 `gpm-bak-YYYYMMDD_HHmm_ss` 归一成 `gpm-bak-TS`(排除项 1:UTC vs 本地历)。
fn norm_stamp(s: &str) -> String {
    let i = match s.find("gpm-bak-") {
        Some(i) => i,
        None => return s.to_string(),
    };
    let tail = &s[i + "gpm-bak-".len()..];
    let cut = tail.char_indices().nth(16).map(|(n, _)| n).unwrap_or(tail.len());
    let head = &tail[..cut];
    if head.chars().count() == 16 && head.chars().all(|c| c.is_ascii_digit() || c == '_') {
        format!("{}gpm-bak-TS{}", &s[..i], &tail[cut..])
    } else {
        s.to_string()
    }
}

/// 递归把 Value 里的字符串过一遍 `norm_stamp`(写结果的 backupRel 靠它对齐形状)。
fn norm_value(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(norm_stamp(s)),
        Value::Array(a) => Value::Array(a.iter().map(norm_value).collect()),
        Value::Object(o) => {
            let mut m = serde_json::Map::new();
            for (k, val) in o {
                m.insert(k.clone(), norm_value(val));
            }
            Value::Object(m)
        }
        other => other.clone(),
    }
}

/// Rust 侧的 scan 结果,形状与 `scan_json` / JS `scanProjectTree` 一致。
fn rust_scan(root: &Path, opts: &ScanOpts) -> Value {
    let (files, truncated) = collect_tree(root, opts);
    let arr: Vec<Value> = files
        .iter()
        .map(|e: &TreeEntry| json!({ "rel": e.rel, "size": e.size, "mtimeMs": e.mtime_ms, "ext": e.ext }))
        .collect();
    json!({ "ok": true, "files": arr, "truncated": truncated })
}

// ---------------------------------------------------------------------------
// JS 侧脚本:同一个 node 进程里 stub window.ztools.db.get 后 require 真原语。
// 参数走**配置文件**(而不是命令行),免掉 Windows 上的引号地狱。
// ---------------------------------------------------------------------------
const JS_HARNESS: &str = r#"
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
global.window = { ztools: { db: { get: (id) => (cfg.roots[id] ? { path: cfg.roots[id] } : null) } } };
const F = require(path.join(cfg.repo, 'src-ztools', 'preload', 'lib', 'inspectfs.js'));

const norm = (s) => String(s).replace(/gpm-bak-\d{8}_\d{4}_\d{2}/, 'gpm-bak-TS');
const top = (dir) => fs.readdirSync(dir).map(norm).sort();

const out = { meta: {}, scan: {}, read: {}, write: {}, trash: {}, disk: {}, jsOnly: {} };
const linkPath = cfg.roots.tree + '/evil-link';
out.meta.hasLink = fs.existsSync(linkPath) && fs.existsSync(linkPath + '/evil.txt');

// ---------- scan ----------
out.scan.def = F.scanProjectTree('tree');
out.scan.cache = F.scanProjectTree('tree', { includeCache: true });
out.scan.exts = F.scanProjectTree('tree', { exts: ['gd', 'MD'] });
out.scan.skip = F.scanProjectTree('tree', { skipDirs: ['tmp'] });
out.scan.max3 = F.scanProjectTree('tree', { maxEntries: 3 });
out.scan.noRoot = F.scanProjectTree('nope');
cfg.roots.goneDir = cfg.roots.tree + '/no-such-dir-at-all';
out.scan.noDir = F.scanProjectTree('goneDir');

// ---------- read ----------
const rd = (rel, opts) => F.readProjectText('tree', rel, opts);
out.read.tiny = rd('tiny.svg');
out.read.big = rd('big.txt');
out.read.nul = rd('nul.bin');
out.read.notutf = rd('notutf.dat');
out.read.capped = rd('sub/child.gd', { maxBytes: 4 });
out.read.zero = rd('sub/child.gd', { maxBytes: 0 });
out.read.missing = rd('nope.txt');
out.read.dirAsRel = rd('sub');
out.read.escape = rd('../outside-secret');
out.read.dotdot = rd('sub/../../x.txt');
out.read.absRel = rd('C:/Windows/win.ini');
out.read.emptyRel = rd('');
out.read.noRoot = F.readProjectText('nope', 'tiny.svg');
out.read.thruLink = out.meta.hasLink ? rd('evil-link/evil.txt') : null;

// ---------- write ----------
out.write.fresh = F.writeProjectText('w', 'brand-new.txt', 'FRESH');
out.write.existing = F.writeProjectText('w', 'w-target.txt', 'NEW-CONTENT');
out.write.noBackup = F.writeProjectText('w', 'w-target.txt', 'NEW-CONTENT-2', { backup: false });
out.write.ontoDir = F.writeProjectText('w', 'sub', 'X');
out.write.missingParent = F.writeProjectText('w', 'no-such-dir/x.txt', 'X');
out.write.illegal = F.writeProjectText('w', '../escape.txt', 'X');
out.write.after = F.readProjectText('w', 'w-target.txt');
// 排除项 4:Rust 的 text 参数是 &str,这条在它那边类型层就不可达
out.jsOnly.writeNotText = F.writeProjectText('w', 'w-target.txt', 123);
// 排除项 5:真落回收站那一步机器相关,这里只比对不碰盘的闸与形态
out.trash.empty = F.movePathsToTrash('t', []);
out.trash.gates = F.movePathsToTrash('t', ['..', 'nope.txt', './nope.txt', 'sub/../../x.txt', 'C:/Windows/x']);
out.trash.dupMissing = F.movePathsToTrash('t', ['gone-a.txt', './gone-a.txt']);
out.jsOnly.trashNotArray = F.movePathsToTrash('t', 'gone-a.txt');
out.jsOnly.trashNoRoot = F.movePathsToTrash('nope', ['a.txt']);

out.disk.w = top(cfg.roots.w);
out.disk.t = top(cfg.roots.t);
out.disk.tree = top(cfg.roots.tree);

process.stdout.write(JSON.stringify(out));
"#;

/// 比对一份 scan 结果:排序后比 rel 序列,再比每个 rel 的 size/ext、truncated 与条数。
fn cmp_scan(name: &str, js: &Value, rs: &Value, diffs: &mut Vec<String>, notes: &mut Vec<String>) {
    let jok = js.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let rok = rs.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if jok != rok {
        diffs.push(format!(
            "scan[{name}] ok 不一致: JS={jok}({}) / Rust={rok}({})",
            js.get("error").map(|e| e.to_string()).unwrap_or_default(),
            rs.get("error").map(|e| e.to_string()).unwrap_or_default()
        ));
        return;
    }
    if !jok {
        // 排除项 3:遍历失败的错误文案不可比,只比 ok
        notes.push(format!(
            "  NOTE  scan[{name}] 两端都 ok:false(文案按排除项 3 不比:JS {} / Rust {})",
            js.get("error").map(|e| e.to_string()).unwrap_or_default(),
            rs.get("error").map(|e| e.to_string()).unwrap_or_default()
        ));
        return;
    }
    let je = js.get("files").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let re = rs.get("files").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let rels = |a: &Vec<Value>| -> Vec<String> {
        let mut v: Vec<String> = a.iter().filter_map(|e| e.get("rel").and_then(|r| r.as_str()).map(String::from)).collect();
        v.sort();
        v
    };
    let jtrunc = js.get("truncated").and_then(|v| v.as_bool()).unwrap_or(false);
    let rtrunc = rs.get("truncated").and_then(|v| v.as_bool()).unwrap_or(false);
    if jtrunc != rtrunc {
        diffs.push(format!("scan[{name}] truncated 不一致: JS={jtrunc} / Rust={rtrunc}"));
    }
    if jtrunc && rtrunc {
        // 排除项 7:截断时两端留下的到底是哪几条本就不同,只比条数
        if je.len() != re.len() {
            diffs.push(format!("scan[{name}] 截断时的条数不一致: JS {} / Rust {}", je.len(), re.len()));
        }
        notes.push(format!("  NOTE  scan[{name}] 两端都在 maxEntries 处截断,按排除项 7 只比 truncated + 条数({} 条)", je.len()));
    } else {
        let jrel = rels(&je);
        let rrel = rels(&re);
        if jrel != rrel {
            let only = |a: &Vec<String>, b: &Vec<String>| -> Vec<String> {
                a.iter().filter(|x| !b.contains(x)).take(10).cloned().collect()
            };
            let left = only(&jrel, &rrel);
            let right = only(&rrel, &jrel);
            let more = |n: usize| if n > 10 { format!(" (还有 {} 条未列)", n - 10) } else { String::new() };
            diffs.push(format!(
                "scan[{name}] rel 序列不一致(JS {} 条 / Rust {} 条)\n      只有 JS 有: {:?}{}\n      只有 Rust 有: {:?}",
                jrel.len(),
                rrel.len(),
                left,
                more(jrel.len().saturating_sub(rrel.len())),
                right
            ));
        }
        let by_rel = |a: &Vec<Value>| -> std::collections::BTreeMap<String, Value> {
            a.iter()
                .filter_map(|e| e.get("rel").and_then(|r| r.as_str()).map(|r| (r.to_string(), e.clone())))
                .collect()
        };
        let jm = by_rel(&je);
        let rm = by_rel(&re);
        for rel in jrel.iter().filter(|r| rm.contains_key(r.as_str())) {
            let j = &jm[rel.as_str()];
            let r = &rm[rel.as_str()];
            if j.get("size") != r.get("size") {
                diffs.push(format!("scan[{name}] {rel} 的 size 不一致: JS {} / Rust {}", j["size"], r["size"]));
            }
            if j.get("ext") != r.get("ext") {
                diffs.push(format!("scan[{name}] {rel} 的 ext 不一致: JS {} / Rust {}", j["ext"], r["ext"]));
            }
        }
    }
    let zero_mtime = |a: &Vec<Value>| -> Vec<String> {
        a.iter()
            .filter(|e| e.get("mtimeMs").and_then(|m| m.as_u64()).unwrap_or(0) == 0)
            .filter_map(|e| e.get("rel").and_then(|r| r.as_str()).map(String::from))
            .collect()
    };
    let (jbad, rbad) = (zero_mtime(&je), zero_mtime(&re));
    if !jbad.is_empty() || !rbad.is_empty() {
        diffs.push(format!(
            "scan[{name}] mtimeMs 必须 >0(数值本身按排除项 1 不比):JS 为 0 的 {jbad:?} / Rust 为 0 的 {rbad:?}"
        ));
    }
}

/// 比对两份 JSON(字符串里的备份戳先归一,再整体等值)。
fn cmp_json(name: &str, js: &Value, rs: &Value, diffs: &mut Vec<String>) {
    let (a, b) = (norm_value(js), norm_value(rs));
    if a != b {
        diffs.push(format!("{name} 不一致:\n      JS   {a}\n      Rust {b}"));
    }
}

fn key_set(v: &Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    k.sort();
    k
}

/// 双端逐节对照。返回 (通过的对照项数, 可见跳过项数, 差异清单, 说明清单)。
fn compare(js: &Value, rs: &Value, links: &Links) -> (usize, usize, Vec<String>, Vec<String>) {
    let mut diffs: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let (mut passes, mut skips) = (0usize, 0usize);

    // 键集合一致:防止「某端悄悄少跑了一节」把红变成绿
    for sec in ["scan", "read", "write", "trash", "disk"] {
        let (jk, rk) = (key_set(&js[sec]), key_set(&rs[sec]));
        if jk != rk {
            diffs.push(format!("{sec} 的用例键集合不一致(有一边漏跑):JS {jk:?} / Rust {rk:?}"));
        } else {
            passes += 1;
        }
    }

    for name in ["def", "cache", "exts", "skip", "max3", "noRoot", "noDir"] {
        cmp_scan(name, &js["scan"][name], &rs["scan"][name], &mut diffs, &mut notes);
        passes += 1;
    }
    for name in ["tiny", "big", "nul", "capped", "zero", "missing", "dirAsRel", "escape", "dotdot", "absRel", "emptyRel", "noRoot"] {
        cmp_json(&format!("read[{name}]"), &js["read"][name], &rs["read"][name], &mut diffs);
        passes += 1;
    }
    // 排除项 2:非 UTF-8 无 NUL —— 钉住两端当前形态,而不是放过
    if js["read"]["notutf"]["text"].is_string() && rs["read"]["notutf"]["skippedBinary"].is_boolean() {
        notes.push("  NOTE  read[notutf] 按排除项 2 保留分歧:JS 回 U+FFFD 文本,Rust 判 skippedBinary".into());
        passes += 1;
    } else {
        diffs.push(format!("read[notutf] 的「已知刻意分歧」不再成立,需要重新判定:JS {} / Rust {}", js["read"]["notutf"], rs["read"]["notutf"]));
    }
    // 包含闸的链接用例:两端各自判定,任一边没链接都会在这里露出来
    cmp_json("read[thruLink]", &js["read"]["thruLink"], &rs["read"]["thruLink"], &mut diffs);
    if links.junction && js["meta"]["hasLink"].as_bool() == Some(true) {
        passes += 1;
    } else {
        skips += 1;
        notes.push(format!("  SKIP  read[thruLink] 没能真跑:链接不可用({})", links.why));
    }
    if !links.dangling {
        skips += 1;
        notes.push(format!("  SKIP  悬空链接没能建出来,树里少一条「链接不可跟随」的形态({})", links.why));
    } else {
        passes += 1;
    }
    for name in ["fresh", "existing", "noBackup", "ontoDir", "missingParent", "illegal", "after"] {
        cmp_json(&format!("write[{name}]"), &js["write"][name], &rs["write"][name], &mut diffs);
        passes += 1;
    }
    // P-1 的跨宿主钉子:无备份时两端都**没有** backupRel 这个键(而不是给 null)
    for name in ["fresh", "noBackup"] {
        let (jhas, rhas) = (js["write"][name].get("backupRel").is_some(), rs["write"][name].get("backupRel").is_some());
        if jhas || rhas {
            diffs.push(format!("write[{name}] 无备份时不该带 backupRel 键:JS {} / Rust {}", js["write"][name], rs["write"][name]));
        } else {
            passes += 1;
        }
    }
    if js["jsOnly"]["writeNotText"].get("error").and_then(|e| e.as_str()) == Some("内容不是文本") {
        notes.push("  NOTE  write[非字符串] 按排除项 4 只在 JS 侧可达(Rust 的 text: &str 类型层挡死)".into());
        passes += 1;
    } else {
        diffs.push(format!("write[非字符串] 的 '内容不是文本' 不再成立: {}", js["jsOnly"]["writeNotText"]));
    }
    for name in ["empty", "gates", "dupMissing"] {
        cmp_json(&format!("trash[{name}]"), &js["trash"][name], &rs["trash"][name], &mut diffs);
        passes += 1;
    }
    // 垫片归一的依据:JS 收非数组 = 空清单;Rust 的 Vec<String> 只能收到数组
    cmp_json("trash[非数组入参 ↔ Rust 空清单]", &js["jsOnly"]["trashNotArray"], &rs["trash"]["empty"], &mut diffs);
    passes += 1;
    if js["jsOnly"]["trashNoRoot"].get("error").and_then(|e| e.as_str()) == Some("项目不存在") {
        notes.push("  NOTE  trash[无根] 的 '项目不存在' 出自 JS 原语的提前返回;Rust 同串在命令层(main.rs),按 P-2 由 bin 断言钉".into());
        passes += 1;
    } else {
        diffs.push(format!("trash[无根] 的 '项目不存在' 不再成立: {}", js["jsOnly"]["trashNoRoot"]));
    }
    for name in ["w", "t", "tree"] {
        cmp_json(&format!("disk[{name}] 落盘后果"), &js["disk"][name], &rs["disk"][name], &mut diffs);
        passes += 1;
    }

    (passes, skips, diffs, notes)
}

/// Rust 侧:与 JS 脚本逐条同形的用例集。
fn rust_side(tree: &Path, w: &Path, t: &Path, has_link: bool) -> Value {
    let def = ScanOpts::default();
    let mut scan_map = serde_json::Map::new();
    scan_map.insert("def".into(), rust_scan(tree, &def));
    scan_map.insert("cache".into(), rust_scan(tree, &ScanOpts { include_cache: true, ..def.clone() }));
    scan_map.insert("exts".into(), rust_scan(tree, &ScanOpts { exts: vec!["gd".into(), "MD".into()], ..def.clone() }));
    scan_map.insert("skip".into(), rust_scan(tree, &ScanOpts { skip_dirs: vec!["tmp".into()], ..def.clone() }));
    scan_map.insert("max3".into(), rust_scan(tree, &ScanOpts { max_entries: 3, ..def.clone() }));
    scan_map.insert("noRoot".into(), scan_json(Path::new(""), &def));
    scan_map.insert("noDir".into(), scan_json(&tree.join("no-such-dir-at-all"), &def));

    let rd = |rel: &str, max: u64| read_text_json(tree, rel, max);
    let mut read_map = serde_json::Map::new();
    read_map.insert("tiny".into(), rd("tiny.svg", DEFAULT_MAX_BYTES));
    read_map.insert("big".into(), rd("big.txt", DEFAULT_MAX_BYTES));
    read_map.insert("nul".into(), rd("nul.bin", DEFAULT_MAX_BYTES));
    read_map.insert("notutf".into(), rd("notutf.dat", DEFAULT_MAX_BYTES));
    read_map.insert("capped".into(), rd("sub/child.gd", 4));
    // maxBytes:0 → 两端都回落默认限额(JS `o.maxBytes && o.maxBytes > 0`,Rust `if max_bytes > 0`)
    read_map.insert("zero".into(), rd("sub/child.gd", 0));
    read_map.insert("missing".into(), rd("nope.txt", DEFAULT_MAX_BYTES));
    read_map.insert("dirAsRel".into(), rd("sub", DEFAULT_MAX_BYTES));
    read_map.insert("escape".into(), rd("../outside-secret", DEFAULT_MAX_BYTES));
    read_map.insert("dotdot".into(), rd("sub/../../x.txt", DEFAULT_MAX_BYTES));
    read_map.insert("absRel".into(), rd("C:/Windows/win.ini", DEFAULT_MAX_BYTES));
    read_map.insert("emptyRel".into(), rd("", DEFAULT_MAX_BYTES));
    read_map.insert("noRoot".into(), read_text_json(Path::new(""), "tiny.svg", DEFAULT_MAX_BYTES));
    read_map.insert("thruLink".into(), if has_link { rd("evil-link/evil.txt", DEFAULT_MAX_BYTES) } else { Value::Null });

    let mut write_map = serde_json::Map::new();
    write_map.insert("fresh".into(), write_text_json(w, "brand-new.txt", "FRESH", true));
    write_map.insert("existing".into(), write_text_json(w, "w-target.txt", "NEW-CONTENT", true));
    write_map.insert("noBackup".into(), write_text_json(w, "w-target.txt", "NEW-CONTENT-2", false));
    write_map.insert("ontoDir".into(), write_text_json(w, "sub", "X", true));
    write_map.insert("missingParent".into(), write_text_json(w, "no-such-dir/x.txt", "X", true));
    write_map.insert("illegal".into(), write_text_json(w, "../escape.txt", "X", true));
    write_map.insert("after".into(), read_text_json(w, "w-target.txt", DEFAULT_MAX_BYTES));

    let rels = |v: &[&str]| -> Vec<String> { v.iter().map(|x| x.to_string()).collect() };
    let mut trash_map = serde_json::Map::new();
    trash_map.insert("empty".into(), trash_json(t, &[]));
    trash_map.insert("gates".into(), trash_json(t, &rels(&["..", "nope.txt", "./nope.txt", "sub/../../x.txt", "C:/Windows/x"])));
    trash_map.insert("dupMissing".into(), trash_json(t, &rels(&["gone-a.txt", "./gone-a.txt"])));

    let mut disk = serde_json::Map::new();
    disk.insert("w".into(), json!(top_names(w)));
    disk.insert("t".into(), json!(top_names(t)));
    disk.insert("tree".into(), json!(top_names(tree)));

    json!({ "scan": Value::Object(scan_map), "read": Value::Object(read_map), "write": Value::Object(write_map),
            "trash": Value::Object(trash_map), "disk": Value::Object(disk) })
}

/// 收尾:先**摘掉链接本身**(绝不能穿过它删到树外),再整棵清掉。
/// 返回「树外内容此刻是否还在」—— 它就是删除从未穿过 junction 的证据。
/// (必须在删 `outside` 自己**之前**问,否则等于自己制造案发现场。)
fn cleanup(base: &Path, tree: &Path, outside: &Path) -> (bool, Vec<String>) {
    let mut left: Vec<String> = Vec::new();
    for l in ["evil-link", "dangling"] {
        let p = tree.join(l);
        if p.exists() {
            let _ = fs::remove_dir(&p); // junction / 目录链接:remove_dir 摘的是链接本身
            let _ = fs::remove_file(&p);
            if p.exists() {
                left.push(l.to_string());
            }
        }
    }
    let _ = fs::remove_dir_all(base);
    let outside_alive = fs::read(outside.join("evil.txt")).is_ok();
    let _ = fs::remove_dir_all(outside);
    (outside_alive, left)
}

#[test]
#[ignore]
fn js_and_rust_inspectfs_agree_on_one_fixture_tree() {
    let base = std::env::temp_dir().join(format!("gpm-inspectfs-parity-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    // 链接的**落点必须在 base 之外**,否则「删除有没有穿过链接」这条安全检查就成了自证:
    // 第一版把它放在 base 里,`remove_dir_all(base)` 当然会把「树外目录」一起删掉 —— 假红。
    let outside = std::env::temp_dir().join(format!("gpm-inspectfs-parity-outside-{}", std::process::id()));
    let missing_target = std::env::temp_dir().join(format!("gpm-inspectfs-parity-gone-{}", std::process::id()));
    let _ = fs::remove_dir_all(&outside);
    let _ = fs::remove_dir_all(&missing_target);
    // 一份确定性布局,多份拷贝:
    //   · `tree` 只读(scan / read 两端**共用同一棵**,这才是「同一棵树」的对照)
    //   · 写与删各自孪生 —— 共用一棵就会被**先后两次的改盘**污染(第一版就在这里把
    //     「新建文件不该有备份」跑成了「第二次写当然有备份」,假红)。
    let tree = base.join("tree");
    let (wjs, wrs) = (base.join("twin-write-js"), base.join("twin-write-rs"));
    let (tjs, trs) = (base.join("twin-trash-js"), base.join("twin-trash-rs"));
    for d in [&tree, &wjs, &wrs, &tjs, &trs] {
        write_fixture_tree(d);
    }
    let links = build_links(&tree, &outside, &missing_target);
    println!("夹具树 {} 已建(junction={} dangling={}):{}", base.display(), links.junction, links.dangling, links.why);

    // 先跑 Rust 侧(不依赖 node),再跑 JS 侧
    let rs = rust_side(&tree, &wrs, &trs, links.junction);

    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let script = base.join("js-harness.js");
    fs::write(&script, JS_HARNESS).unwrap();
    let cfg_file = base.join("js-cfg.json");
    let mut roots = serde_json::Map::new();
    roots.insert("tree".into(), json!(tree));
    roots.insert("w".into(), json!(wjs));
    roots.insert("t".into(), json!(tjs));
    roots.insert("nope".into(), Value::Null);
    fs::write(&cfg_file, json!({ "repo": repo, "roots": Value::Object(roots) }).to_string()).unwrap();

    let js: Value = match std::process::Command::new("node").arg(&script).arg(&cfg_file).output() {
        Err(e) => {
            println!("  SKIP  整轮跳过:环境里找不到 node({e})—— 双端对照没有 JS 这半边就没有意义");
            cleanup(&base, &tree, &outside);
            return;
        }
        Ok(out) => {
            if !out.status.success() {
                cleanup(&base, &tree, &outside);
                panic!("node 侧脚本跑挂了:\nstderr: {}\nstdout: {}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout));
            }
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            serde_json::from_str(text.trim()).unwrap_or_else(|e| {
                cleanup(&base, &tree, &outside);
                panic!("node 输出不是 JSON({e}):\n{text}")
            })
        }
    };

    let (passes, skips, diffs, notes) = compare(&js, &rs, &links);
    let (outside_alive, link_left) = cleanup(&base, &tree, &outside);
    for n in &notes {
        println!("{n}");
    }

    // 清理**不能穿过链接**吃掉树外的东西:这条断言就是那件事没发生的证据
    // (并进 diffs 一起报,红了也留得下现场说明)
    let mut all = diffs;
    if !outside_alive {
        all.push(format!(
            "删除穿过了 evil-link 把链接目标目录一起吃掉了(清理后残留的链接:{link_left:?})—— 夹具的链接语义失效"
        ));
    }
    assert!(all.is_empty(), "双端语义漂移({} 处):\n{}", all.len(), all.join("\n  ---\n"));
    println!("  PASS  双端对照通过 {passes} 项,可见跳过 {skips} 项(链接没建成时不为它记账)");
}
