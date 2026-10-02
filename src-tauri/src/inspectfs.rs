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

/// 递归收集文件清单。
///
/// 两条与 JS 侧 `fsutil.walkFiles`(Node `Dirent`)对齐的红线:
///   · **不跟随链接**:类型只问 `DirEntry::file_type()`(它读 readdir 给的原始属性,不穿过
///     reparse point,Windows 上还省一次 stat)。`Path::is_dir()` / `metadata()` 都会跟随,
///     于是「指回祖先的目录链接」会把栈式 DFS 拖成死循环,项目外的文件也会借着链接以
///     目标大小/时间混进清单 —— 而那条 rel 后面会被 Task 7 的读写闸拒掉,桌面端等于渲染一排打不开的行。
///   · **嵌套目录读不了静默跳过**(与 JS 侧 statSync 失败即 continue 一致);根读不了是另一回事,
///     由 `scan_json` 翻成 ok:false。
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
            let ft = match ent.file_type() { Ok(t) => t, Err(_) => continue };
            if ft.is_dir() {
                if !opts.include_cache && name == ".godot" { continue; }
                if skip.contains(&name.to_lowercase()) { continue; }
                stack.push(ent.path());
                continue;
            }
            // 符号链接 / junction / FIFO / socket / 未知类型:既不进入也不列出(与 Dirent 同)。
            // 这里必须是**正向文件判定**,不能写成「不是目录就当文件」—— 那等于把链接全送进文件分支。
            if !ft.is_file() { continue; }
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
///
/// 根本身读不了(EACCES / ACL / 盘被弹走 / 根本就不是目录)时回 `ok:false` ——
/// JS 侧 `walkFiles` 会抛错并被 catch 成 `{ ok:false, error }`,清单为空 + ok:true
/// 那种「体检通过」的谎报比报错更坏。空**而可读**的目录不是错误(仍回 ok:true, files:[])。
pub fn scan_json(root: &Path, opts: &ScanOpts) -> Value {
    let (files, truncated) = collect_tree(root, opts);
    if files.is_empty() && fs::read_dir(root).is_err() {
        return serde_json::json!({ "ok": false, "error": "项目目录不可读" });
    }
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
        touch(&root, "res.godot/note.txt", b"x");
        let (files, tr) = collect_tree(&root, &ScanOpts::default());
        assert!(!tr, "小树不该截断");
        // 光断「清单里没有 .godot」是不够的:一个把名字**含有** .godot 的东西一概跳掉的实现
        // 照样全绿,而 project.godot 正是其余每个检查器都要读的那个文件 —— 缺席必须报红。
        let rels: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
        assert!(rels.contains(&"project.godot"), "project.godot 必须在清单里: {:?}", rels);
        assert!(rels.contains(&"res.godot/note.txt"),
            "目录名只是**包含** .godot 的合法目录不该被误跳: {:?}", rels);
        // 缺席判据按**路径段**比,不用子串:名字里带 ".godot" 的合法条目不该被算成违规
        assert!(files.iter().all(|f| !f.rel.split('/').any(|c| c == ".godot")), "默认跳过任意层级 .godot");
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
        touch(&root, "DIST/CFG.EXE", b"xyz");
        touch(&root, "x/build/y.res", b"xyz");
        touch(&root, "c.PNG", b"xy");
        // 遍历顺序两端不同,所以比对一律先排序(parity 只认排序后的 rel 序列)
        let rels_of = |o: &ScanOpts| -> Vec<String> {
            let mut v: Vec<String> = collect_tree(&root, o).0.into_iter().map(|f| f.rel).collect();
            v.sort();
            v
        };
        // 1) exts 收**点号 + 大写**形态(".PNG" 要能匹配 c.PNG),同请求里 build 整层被跳
        assert_eq!(
            rels_of(&ScanOpts { exts: vec![".PNG".into()], skip_dirs: vec!["build".into()], ..Default::default() }),
            vec!["b.png".to_string(), "c.PNG".to_string()],
            "exts 的点号与大小写都要容忍");
        // 2) skip_dirs 按目录名**大小写不敏感**(DIST ← 跳 "dist")且在**任意层级**生效(x/build)
        assert_eq!(
            rels_of(&ScanOpts { skip_dirs: vec!["build".into(), "dist".into()], ..Default::default() }),
            vec!["a.svg".to_string(), "b.png".to_string(), "c.PNG".to_string()],
            "根层 DIST 与嵌套 x/build 都要跳掉");
        // 3) 反向对照:名字不匹配时两层目录照收 —— 证明第 2 条跳的是**名字**,不是深度
        let r3 = rels_of(&ScanOpts { skip_dirs: vec!["nope".into()], ..Default::default() });
        assert!(r3.contains(&"x/build/y.res".to_string()), "不匹配时深层目录照常遍历: {:?}", r3);
        assert!(r3.contains(&"DIST/CFG.EXE".to_string()), "不匹配时大写目录照常遍历: {:?}", r3);
        assert!(r3.contains(&"build/out.exe".to_string()), "不匹配时 build 照常遍历: {:?}", r3);
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

    // ---------- 链接夹具助手(与 JS 侧 inspectfs.test.js 的 trySymlink 同纪律)----------
    // Windows 上建真符号链接要开发者模式或管理员权限(os error 1314),目录形态可以退到
    // NTFS junction:它同样是需要权限为零的 reparse point,而实测两端都把它报成
    // 「symlink」而非 dir/file —— Rust `DirEntry::file_type()` 与 Node `Dirent` 一致,
    // 正好是「既不进入也不列出」这条闸要挡的形态。
    #[cfg(windows)]
    fn make_dir_link(target: &Path, link: &Path) -> Result<(), String> {
        if let Err(e) = std::os::windows::fs::symlink_dir(target, link) {
            let out = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J", &link.to_string_lossy(), &target.to_string_lossy()])
                .output()
                .map_err(|oe| format!("symlink_dir:{e}; mklink 启动失败:{oe}"))?;
            if !out.status.success() || fs::symlink_metadata(link).is_err() {
                return Err(format!("symlink_dir:{e}; mklink /J 退出 {:?}", out.status.code()));
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    fn make_dir_link(target: &Path, link: &Path) -> Result<(), String> {
        std::os::unix::fs::symlink(target, link).map_err(|e| format!("symlink:{e}"))
    }
    /// 文件形态在 Windows 上只有符号链接一种(junction 只能指目录),没权限就如实 SKIP。
    #[cfg(windows)]
    fn make_file_link(target: &Path, link: &Path) -> Result<(), String> {
        std::os::windows::fs::symlink_file(target, link)
            .map_err(|e| format!("symlink_file:{e}(Windows 需开发者模式或管理员权限)"))
    }
    #[cfg(not(windows))]
    fn make_file_link(target: &Path, link: &Path) -> Result<(), String> {
        std::os::unix::fs::symlink(target, link).map_err(|e| format!("symlink:{e}"))
    }
    /// 造一个「存在但 read_dir 必然失败」的目录(真 EACCES 形态)。
    /// Unix 用 chmod 000;Windows 只能靠 icacls 改 ACL —— 测试不碰系统权限,一律回 Err,
    /// 由用例打成**可见** SKIP,绝不用 assert!(true) 冒充 PASS。
    #[cfg(not(windows))]
    fn make_unreadable(dir: &Path) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o000)).map_err(|e| format!("chmod:{e}"))?;
        if fs::read_dir(dir).is_ok() {
            restore_readable(dir);
            return Err("chmod 000 没挡住 read_dir(以 root 身份跑测试?)".into());
        }
        Ok(())
    }
    #[cfg(windows)]
    fn make_unreadable(_dir: &Path) -> Result<(), String> {
        Err("本机不模拟真 EACCES:Windows 要 icacls 改 ACL(安全敏感操作,测试不做)".into())
    }
    #[cfg(not(windows))]
    fn restore_readable(dir: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o755));
    }
    #[cfg(windows)]
    fn restore_readable(_dir: &Path) {}
    /// 可见 SKIP:照 JS 侧 skipAssert(inspectfs.test.js:30-40)—— 打印,但**不记 PASS**。
    /// 用 `cargo test ... inspectfs -- --nocapture` 看得到;SKIP 不新增断言数,头条数字不会虚高。
    fn skip_assert(label: &str, reason: &str) {
        println!("  SKIP  {label} → {reason}");
    }
    /// 项目根**之外**的一处目录(链接靶子)。名字带 name + pid,避免并行用例互相删靶子。
    fn outside_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("gpm-inspect-outside-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// F-1:指向**祖先**的目录链接成环。遍历必须终止,且清单里一条环上路径都不能有。
    ///
    /// 有界守卫(不靠线程超时):上限给 50,而成环子树里**有文件** ——
    /// 跟随链接的实现每下一层稳定产出 2 条,必定在 50 条处 `return (out, true)`,
    /// 既跑得出红(条数/形态都不对)也不会挂住整个测试进程,更不会真攒到 200_000 条。
    #[test]
    fn dir_link_pointing_at_ancestor_terminates_and_lists_nothing() {
        let root = tmp("link-cycle");
        touch(&root, "a.txt", b"x");
        touch(&root, "sub/b.txt", b"yy");
        // 对照:另一处**同名**的真目录必须照常遍历 —— 这样下面的断言钉的是「链接没被跟随」,
        // 而不是碰巧把 loop 这个名字当成了 skip_dirs。
        touch(&root, "scene/loop/c.txt", b"zzz");
        match make_dir_link(&root, &root.join("sub").join("loop")) {
            Err(why) => skip_assert("目录链接指回祖先 → 遍历终止且不重复列路径", &why),
            Ok(()) => {
                let (files, tr) = collect_tree(&root, &ScanOpts { max_entries: 50, ..Default::default() });
                let mut rels: Vec<String> = files.iter().map(|f| f.rel.clone()).collect();
                rels.sort();
                assert_eq!(rels,
                    vec!["a.txt".to_string(), "scene/loop/c.txt".to_string(), "sub/b.txt".to_string()],
                    "链接不进入也不列出,成环必须终止,同名真目录照常收");
                assert!(!tr, "三个文件的小树不该被截断");
            }
        }
        fs::remove_dir_all(&root).ok();
    }

    /// F-1:指向项目**外**目录的链接不得被列出(JS 侧 walkFiles 连看都不看它)。
    #[test]
    fn dir_link_to_outside_tree_is_not_listed() {
        let root = tmp("link-outside");
        touch(&root, "project.godot", b"[application]\n");
        let outside = outside_dir("tree");
        touch(&outside, "secret.txt", b"SECRET-OUTSIDE-TREE\n");
        match make_dir_link(&outside, &root.join("linkdir")) {
            Err(why) => skip_assert("指向项目外的目录链接 → 不进清单", &why),
            Ok(()) => {
                let (files, tr) = collect_tree(&root, &ScanOpts::default());
                let rels: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
                assert_eq!(rels, vec!["project.godot"], "外部文件不得借链接进清单: {:?}", rels);
                assert!(!tr, "不该被截断");
            }
        }
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    /// F-1:指向项目外**文件**的符号链接不得被列出(它的 rel/size/mtime 都属项目外)。
    #[test]
    fn symlink_to_outside_file_is_not_listed() {
        let root = tmp("link-file");
        touch(&root, "project.godot", b"[application]\n");
        let outside = outside_dir("file");
        touch(&outside, "secret.txt", b"SECRET-OUTSIDE-TREE\n");
        let secret = outside.join("secret.txt");
        match make_file_link(&secret, &root.join("link-out.txt")) {
            Err(why) => skip_assert("指向项目外的文件符号链接 → 不进清单", &why),
            Ok(()) => {
                let files = collect_tree(&root, &ScanOpts::default()).0;
                let rels: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
                assert_eq!(rels, vec!["project.godot"], "链接本身不该被当成项目内文件列出: {:?}", rels);
            }
        }
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    /// F-3:根读不了 → ok:false(与 JS 侧 walkFiles 抛错被 catch 后回 ok:false 同形);
    /// **嵌套**目录读不了仍要静默,不能因一个子树就没权限就判整个项目失败。
    #[test]
    fn unreadable_root_reports_error_while_nested_unreadable_dir_stays_silent() {
        // (a) 可移植形态:空而可读的根仍是成功;根不是目录 / 根已消失都是确定的 read_dir 错误
        let root = tmp("root-bad");
        let v = scan_json(&root, &ScanOpts::default());
        assert_eq!(v["ok"], Value::Bool(true), "空但可读的根不是错误");
        assert_eq!(v["files"].as_array().unwrap().len(), 0, "空目录回空清单");
        assert_eq!(v["truncated"], Value::Bool(false));
        let not_a_dir = root.join("file-as-root");
        fs::write(&not_a_dir, b"x").unwrap();
        let v2 = scan_json(&not_a_dir, &ScanOpts::default());
        assert_eq!(v2["ok"], Value::Bool(false), "根 read_dir 失败必须 ok:false(与 JS 一致)");
        assert!(v2["error"].as_str().map(|s| !s.is_empty()).unwrap_or(false), "ok:false 要带原因: {:?}", v2);
        let _ = fs::remove_dir_all(&root);
        assert_eq!(scan_json(&root, &ScanOpts::default())["ok"], Value::Bool(false), "根已消失同样 ok:false");

        // (b) 真 EACCES 形态:能造出来就断言,造不了打**可见** SKIP
        let nroot = tmp("nested-lock");
        touch(&nroot, "keep.txt", b"x");
        let locked = nroot.join("locked");
        fs::create_dir_all(&locked).unwrap();
        match make_unreadable(&locked) {
            Ok(()) => {
                let v3 = scan_json(&nroot, &ScanOpts::default());
                restore_readable(&locked);
                assert_eq!(v3["ok"], Value::Bool(true), "嵌套目录读不了要静默跳过,不能整棵树报错");
                let rels: Vec<&str> = v3["files"].as_array().unwrap().iter()
                    .map(|f| f["rel"].as_str().unwrap()).collect();
                assert_eq!(rels, vec!["keep.txt"], "只丢那棵子树: {:?}", rels);
            }
            Err(why) => skip_assert("嵌套不可读目录 → 静默跳过(真 EACCES 形态)", &why),
        }
        let rroot = tmp("root-eacces");
        match make_unreadable(&rroot) {
            Ok(()) => {
                let v4 = scan_json(&rroot, &ScanOpts::default());
                restore_readable(&rroot);
                assert_eq!(v4["ok"], Value::Bool(false), "EACCES 根必须 ok:false");
            }
            Err(why) => skip_assert("根为 EACCES/ACL 拒绝 → ok:false", &why),
        }
        fs::remove_dir_all(&rroot).ok();
        fs::remove_dir_all(&nroot).ok();
    }
}
