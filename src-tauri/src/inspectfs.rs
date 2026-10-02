//! 项目体检用的文件系统原语(与 src-ztools/preload/lib/inspectfs.js 同语义)。
//!
//! 两端必须逐字段一致(docs/tools-page-plan.md §5.4):rel 正斜杠、默认跳过任意层级
//! `.godot`、命中 max_entries 时 truncated=true 而不是报错。遍历顺序两端不同
//! (这里用栈式 DFS),所以 parity 只比对**排序后**的 rel/size 序列。

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_MAX_BYTES: u64 = 1024 * 1024;
pub const DEFAULT_MAX_ENTRIES: usize = 200_000;

#[derive(Debug, Clone)]
pub struct TreeEntry {
    pub rel: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub ext: String,
}

#[derive(Debug, Clone)]
pub struct ScanOpts {
    pub include_cache: bool,
    pub exts: Vec<String>,
    pub skip_dirs: Vec<String>,
    pub max_entries: usize,
}

impl Default for ScanOpts {
    fn default() -> Self {
        ScanOpts { include_cache: false, exts: Vec::new(), skip_dirs: Vec::new(), max_entries: DEFAULT_MAX_ENTRIES }
    }
}

fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}

fn mtime_ms_of(md: &fs::Metadata) -> u64 {
    md.modified().ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// rel → 绝对路径;`..`、绝对路径、盘符、空串一律 None。
pub fn resolve_rel(root: &Path, rel: &str) -> Option<PathBuf> {
    let norm = rel.replace('\\', "/");
    if norm.is_empty() || norm.starts_with('/') { return None; }
    if norm.as_bytes().get(1) == Some(&b':') { return None; }
    let mut stack: Vec<&str> = Vec::new();
    for p in norm.split('/') {
        if p.is_empty() || p == "." { continue; }
        if p == ".." { return None; }
        stack.push(p);
    }
    if stack.is_empty() { return None; }
    let mut out = root.to_path_buf();
    for p in stack { out.push(p); }
    Some(out)
}

/// 递归收集文件清单。目录缺失/无权限的分支静默跳过(与 JS 侧 statSync 失败即 continue 对齐)。
pub fn collect_tree(root: &Path, opts: &ScanOpts) -> (Vec<TreeEntry>, bool) {
    let mut out: Vec<TreeEntry> = Vec::new();
    let skip: Vec<String> = opts.skip_dirs.iter().map(|s| s.to_lowercase()).collect();
    let keep: Option<Vec<String>> = if opts.exts.is_empty() {
        None
    } else {
        Some(opts.exts.iter().map(|e| e.trim_start_matches('.').to_lowercase()).collect())
    };
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            let is_dir = ent.path().is_dir();
            if is_dir {
                if !opts.include_cache && name == ".godot" { continue; }
                if skip.contains(&name.to_lowercase()) { continue; }
                stack.push(ent.path());
                continue;
            }
            let rel = match ent.path().strip_prefix(root) {
                Ok(p) => p.components()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join("/"),
                Err(_) => continue,
            };
            let ext = ext_of(&name);
            if let Some(ref k) = keep {
                if !k.contains(&ext) { continue; }
            }
            let md = match ent.path().metadata() { Ok(m) => m, Err(_) => continue };
            out.push(TreeEntry { rel, size: md.len(), mtime_ms: mtime_ms_of(&md), ext });
            if out.len() >= opts.max_entries { return (out, true); }
        }
    }
    (out, false)
}

/// 命令复用:输出与 JS 侧 scanProjectTree 同形的 JSON。
pub fn scan_json(root: &Path, opts: &ScanOpts) -> Value {
    let (files, truncated) = collect_tree(root, opts);
    let arr: Vec<Value> = files
        .into_iter()
        .map(|e| serde_json::json!({ "rel": e.rel, "size": e.size, "mtimeMs": e.mtime_ms, "ext": e.ext }))
        .collect();
    serde_json::json!({ "ok": true, "files": arr, "truncated": truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("gpm-inspect-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn touch(dir: &std::path::Path, rel: &str, bytes: &[u8]) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, bytes).unwrap();
    }

    #[test]
    fn skips_cache_by_default_and_includes_on_demand() {
        let root = tmp("cache");
        touch(&root, "project.godot", b"[application]\n");
        touch(&root, ".godot/imported/a.stex", b"x");
        touch(&root, "scene/.godot/x.bin", b"x");
        let (files, tr) = collect_tree(&root, &ScanOpts::default());
        assert!(!tr, "小树不该截断");
        assert!(files.iter().all(|f| !f.rel.contains(".godot/")), "默认跳过任意层级 .godot");
        let all = collect_tree(&root, &ScanOpts { include_cache: true, ..Default::default() }).0;
        assert!(all.iter().any(|f| f.rel.starts_with(".godot/")), "include_cache 时进清单");
        assert!(all.iter().any(|f| f.rel == "scene/.godot/x.bin"), "嵌套 .godot 也进清单");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rel_is_forward_slash_with_size_ext_mtime() {
        let root = tmp("rel");
        touch(&root, "sub/Icon.SVG", b"<svg/>");
        let (files, _) = collect_tree(&root, &ScanOpts::default());
        let e = files.iter().find(|f| f.rel.ends_with("Icon.SVG")).expect("该有这条");
        assert_eq!(e.rel, "sub/Icon.SVG", "rel 正斜杠且保留原大小写");
        assert_eq!(e.ext, "svg", "ext 小写无点");
        assert_eq!(e.size, 6, "size 是文件真实字节数(<svg/> 共 6 字节,与 JS 侧同一份夹具)");
        assert!(e.mtime_ms > 0);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn skip_dirs_and_exts_filters_apply() {
        let root = tmp("filter");
        touch(&root, "a.svg", b"x");
        touch(&root, "b.png", b"xy");
        touch(&root, "build/out.exe", b"xyz");
        let o = ScanOpts { exts: vec!["png".into()], skip_dirs: vec!["build".into()], ..Default::default() };
        let (files, _) = collect_tree(&root, &o);
        let rels: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, vec!["b.png"], "只留 png 且跳过 build");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn max_entries_marks_truncated() {
        let root = tmp("cap");
        for i in 0..10 { touch(&root, &format!("f{}.txt", i), b"x"); }
        let (files, tr) = collect_tree(&root, &ScanOpts { max_entries: 3, ..Default::default() });
        assert_eq!(files.len(), 3, "命中上限就停在 3 条");
        assert!(tr, "truncated 必须 true");
        fs::remove_dir_all(&root).ok();
    }
}
