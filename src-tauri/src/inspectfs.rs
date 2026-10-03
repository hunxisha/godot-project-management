//! 项目体检用的文件系统原语(与 src-ztools/preload/lib/inspectfs.js 同语义)。
//!
//! 两端必须逐字段一致(docs/tools-page-plan.md §5.4):rel 正斜杠、默认跳过任意层级
//! `.godot`、命中 max_entries 时 truncated=true 而不是报错。遍历顺序两端不同
//! (这里用栈式 DFS),所以 parity 只比对**排序后**的 rel/size 序列。
//!
//! 两道闸(读 / 写 / 删三翼共用,遍历不走):`resolve_rel` 挡字面越界(`..`、绝对、盘符),
//! `resolve_inside` 再挡「项目内的链接指向项目外」(canonicalize 后必须仍在根内)。
//! 包含失败与字面越界**共用 '非法路径'**这一句,不留 oracle。
//!
//! 与 JS 侧已知且刻意保留的两处分歧(两端类型系统使然,Task 8 对照时按此判定):
//!   · `'内容不是文本'` 在 Rust 里不可达 —— `write_text_json` 的 `text` 就是 `&str`,
//!     非字符串在 Tauri 反序列化阶段就失败了,拿不到原语里。
//!   · 含非 UTF-8 字节又不含 NUL 的文件:JS 返回带 U+FFFD 的 text,Rust 判 `skippedBinary`
//!     (JS 测试没有覆盖这一形态;工具页显示乱码不如不显示)。
//! 另有一处形状相同、数值不同的:`stamp_sec` 用手搓的 **UTC** 民政历(std 无本地时区 API,
//! 且本任务禁止新增依赖),JS 侧是本地历 —— `YYYYMMDD_HHmm_ss` 逐字同形,本机差 8 小时。
//!
//! 返回形状的一条硬约定(Task 8 双端对齐钉住):`write_text_json` 成功且**没有备份**时
//! **省略 `backupRel` 键**,不给 `null` —— `src/types/godot.ts` 声明的是 `backupRel?: string`,
//! `null` 不在该类型里;JS 侧 `{ ok:true, backupRel: undefined }` 序列化后同样是「键不存在」。

use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const DEFAULT_MAX_BYTES: u64 = 1024 * 1024;
pub const DEFAULT_MAX_ENTRIES: usize = 200_000;

/// 读 / 写 / 删三原语的错误返回(本模块红线:一律不抛异常,一律 `{ ok:false, error }`)。
fn err_json(error: &str) -> Value {
    serde_json::json!({ "ok": false, "error": error })
}

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

impl ScanOpts {
    /// 命令层的 `opts` JSON → `ScanOpts`(D-6:解析收口到库里,`main.rs` 不再逐键 `o.get(...)`)。
    ///
    /// `maxEntries` 在这里归一:0 / 负数 / 非数字 / 缺省一律退默认 —— 0 不是「不限」而是非法值,
    /// `collect_tree` 的上限检查在 push **之后**,原样透传就变成「回 1 条 + truncated:true」,
    /// 体检结论整个反了。与 JS 侧 `o.maxEntries && o.maxEntries > 0 ? … : DEFAULT`
    /// (inspectfs.js:249)同归一;`opts` 不是对象(字符串 / null)时退全默认,不 panic。
    pub fn from_json(v: &Value) -> ScanOpts {
        let list = |key: &str| -> Vec<String> {
            v.get(key).and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default()
        };
        ScanOpts {
            include_cache: v.get("includeCache").and_then(|x| x.as_bool()).unwrap_or(false),
            exts: list("exts"),
            skip_dirs: list("skipDirs"),
            max_entries: v.get("maxEntries").and_then(|x| x.as_u64())
                .filter(|n| *n > 0)
                .map(|n| n as usize).unwrap_or(DEFAULT_MAX_ENTRIES),
        }
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

/// rel → 绝对路径 + **真实路径包含校验**(D-1;镜像 JS 侧 `resolveInside`,inspectfs.js:65-97)。
///
/// `resolve_rel` 只做字面判断(`..` / 绝对 / 盘符),而 `fs::metadata` / `fs::read` / `fs::copy`
/// 都会**跟随**符号链接与 junction —— 项目内一条指向 `~/.ssh/id_rsa` 的链接就读得出去(泄漏内容),
/// 换成写 / 删时改的就是**别人家的文件**。资产站 zip 解压正是项目内长链接的主路径。
/// 所以读 / 写 / 删三翼都过这道闸:根与目标各自 canonicalize,结果必须等于根或落在根 + 分隔符之下。
///
/// 目标还不存在(将要新建的文件)时退到**最近的已存在祖先**做包含校验,再把剩余段接回去 ——
/// 新建文件不该被闸挡掉,但「项目内链接目录 / 新文件」必须挡。
///
/// 错误串与 JS 侧逐字一致,且**刻意复用** '非法路径':包含失败与字面越界不作区分,
/// 不给调用方(或攻击者)留一个「到底是哪一类被挡」的 oracle。
/// canonicalize 用 `std::fs::canonicalize`(= Windows `GetFinalPathNameByHandle`),
/// 与 Node 的 `fs.realpathSync` 在本仓库测试覆盖的每个形态上判定一致:
/// NTFS junction 会被解析到真实落点(Task 6 已实测 `symlink_metadata().file_type()` 两端都报成链接)。
pub fn resolve_inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // JS 侧的 `!root`(项目文档没有 path / projectId 认不到)在 Rust 里只可能是空路径:
    // 命令层的 project_doc_root_of 已经先一步回 '项目不存在',这里留着只为两端语义逐字对齐。
    if root.as_os_str().is_empty() { return Err("项目不存在".to_string()); }
    let abs = match resolve_rel(root, rel) {
        Some(p) => p,
        None => return Err("非法路径".to_string()),
    };
    let real_root = match fs::canonicalize(root) { Ok(p) => p, Err(_) => return Err("路径无法解析".to_string()) };
    let real = if abs.exists() {
        // realpath 问不到(权限 / 成环 / ACL)按保守处理:拒绝
        match fs::canonicalize(&abs) { Ok(p) => p, Err(_) => return Err("路径无法解析".to_string()) }
    } else {
        // 逐级上溯到最近的已存在祖先,canonical 它,再把剩余段接回去
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        let mut cursor = abs.clone();
        let ancestor = loop {
            if let Some(n) = cursor.file_name() { tail.push(n.to_os_string()); }
            let parent = match cursor.parent() {
                Some(p) => p.to_path_buf(),
                // 一路走到文件系统根还是不存在(JS 侧的 `parent === cursor` 收口)
                None => return Err("目标目录不存在".to_string()),
            };
            cursor = parent;
            if cursor.exists() {
                break match fs::canonicalize(&cursor) { Ok(a) => a, Err(_) => return Err("路径无法解析".to_string()) };
            }
        };
        let mut real = ancestor;
        for seg in tail.iter().rev() { real.push(seg); }
        real
    };
    // 包含比较用 `Path::starts_with`(按**路径段**比,不看字符):
    // 既不会把 `E:\proj2` 算进 `E:\proj`,也不必像 JS 那样先剥尾分隔符再补一个
    // (JS 的坑在 realpathSync 对文件系统根保留尾分隔符,Rust 的 Path 段比较天生没这个问题)。
    if real != real_root && !real.starts_with(&real_root) { return Err("非法路径".to_string()); }
    // 返回 resolve_rel 的原始 abs:普通文件的行为与只用字面闸时逐字节一致,rel 仍是对外唯一的键
    Ok(abs)
}

/// 年份是否为公历闰年(4 闰、100 不闰、400 闰)。
fn is_leap(y: i64) -> bool { (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 }

/// Unix 秒 → `YYYYMMDD_HHmm_ss`(与 `fsutil.stampSec` 同**形状**)。
///
/// 民政历换算是手搓的:`std` 没有本地时区 API,而本任务禁止新增 cargo 依赖。
/// **偏差**:JS 侧走 `new Date()` 的本地历,这里只能用 **UTC** —— 字段宽度与分隔符逐字一致,
/// 数值在本机差 8 小时。备份名只是「同一文件多份退路」的键,不参与任何比对逻辑,
/// 两端各自生成的名字在自己那侧唯一即可(Task 8 的 parity 比 rel/size 与错误串,不比备份名)。
fn stamp_from_secs(secs: i64) -> String {
    let (mut days, day_secs) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let mut y = 1970i64;
    loop {
        let len = if is_leap(y) { 366 } else { 365 };
        if days < len { break; }
        days -= len;
        y += 1;
    }
    const MD: [i64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0usize;
    for (i, len) in MD.iter().enumerate() {
        // 2 月的长度随闰年 +1:闰年才有 2 月 29 日,平年则 2 月 28 日的下一天直接翻到 3 月 1 日
        let l = if i == 1 && is_leap(y) { *len + 1 } else { *len };
        if days < l { m = i; break; }
        days -= l;
    }
    format!("{:04}{:02}{:02}_{:02}{:02}_{:02}",
        y, m as i64 + 1, days + 1,
        day_secs / 3600, (day_secs % 3600) / 60, day_secs % 60)
}

/// 备份名里的秒级时间戳(= `fsutil.stampSec()`,只到秒 → 同秒撞名由 `unique_path` 避开)。
fn stamp_sec() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    stamp_from_secs(secs)
}

/// 毫秒级 Unix 时间戳(临时名用,对应 JS 的 `Date.now()`)。
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 文件名 → (去扩展名的基名, 含点的扩展名)。规矩与 Node `path.extname` 一致:
/// 点在最前面(纯 dotfile)或压根没点 → 无扩展名。
fn split_name_ext(name: &str) -> (String, String) {
    match name.rfind('.').filter(|i| *i > 0) {
        Some(i) => (name[..i].to_string(), name[i..].to_string()),
        None => (name.to_string(), String::new()),
    }
}

/// 同目录临时文件名形态(JS:`.gpm-tmp-${Date.now()}-${base}${ext}`)。
/// 以目标**真实扩展名**结尾 —— `fsutil.tempPath` 给文件加的是 `.zip`,这里不能用它。
fn tmp_name(ms: u64, base: &str, ext: &str) -> String {
    format!(".gpm-tmp-{}-{}{}", ms, base, ext)
}

/// 目标已存在时在**最后一个点之前**插入 `_2 / _3 …`(镜像 `fsutil.uniquePath`:189-198)。
/// 备份名 marker 收尾全靠它:`dup.txt.gpm-bak-<ts>` 撞名时退到 `dup.txt_2.gpm-bak-<ts>`,
/// 而不是把上一次的备份(用户以为还能还原到那一版的那份)静默销毁。
fn unique_path(target: &Path) -> PathBuf {
    if !target.exists() { return target.to_path_buf(); }
    let name = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let (base, ext) = split_name_ext(&name);
    let parent = target.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    for i in 2..1000usize {
        let cand = parent.join(format!("{}_{}{}", base, i, ext));
        if !cand.exists() { return cand; }
    }
    parent.join(format!("{}_{}{}", base, now_ms(), ext))
}

/// rel → **目录前缀**(规范正斜杠 + 尾斜杠;项目根下的文件返回空串)。与 JS 的 `relDirPrefix`
/// 用同一套切段归一(`./`、重复斜杠、反斜杠都吃掉),于是 `backupRel` 与 `scanProjectTree`
/// 给出的 rel **同形** —— 渲染层就是按 rel 找文件的。
fn rel_dir_prefix(rel: &str) -> String {
    let norm = rel.replace('\\', "/");
    let mut stack: Vec<&str> = Vec::new();
    for p in norm.split('/') {
        if p.is_empty() || p == "." { continue; }
        if p == ".." { return String::new(); } // 越界早被闸拒了,这里只是防御性收口
        stack.push(p);
    }
    stack.pop(); // 最后一段是文件名,不属于前缀
    if stack.is_empty() { String::new() } else { format!("{}/", stack.join("/")) }
}

/// 静默删除(清理临时产物用,失败不抛)—— 对应 `fsutil.rmQuiet`。
/// 目录 / 文件两条形态都要覆盖:`rmSync({recursive:true, force:true})` 在 JS 侧是通吃的。
fn remove_quietly(p: &Path) {
    match fs::symlink_metadata(p) {
        Ok(md) if md.is_dir() => { let _ = fs::remove_dir_all(p); }
        Ok(_) => { let _ = fs::remove_file(p); }
        Err(_) => {}
    }
}

/// 备份用的复制:与 JS 的 `copyFileSync` 同位(字节数对调用方无意义,抹掉以适配钩子签名)。
fn real_copy(src: &Path, dst: &Path) -> io::Result<()> {
    fs::copy(src, dst).map(|_| ())
}

/// 读项目内文本文件:限额内且非二进制才返回 text(语义与 JS 侧逐条对齐)。
/// 前 512 字节含 NUL 视为二进制(不按扩展名维护黑名单);超限只报 truncated 不给内容。
pub fn read_text_json(root: &Path, rel: &str, max_bytes: u64) -> Value {
    read_text_with(root, rel, max_bytes, &|p| fs::read(p))
}

/// `read_text_json` 的实现体。读取步注入是为了钉住 D-2(`bytes` 必须跟着**实际读到的字节**走):
/// stat 与 read 之间 Godot 编辑器可能改写过文件,只有刚进内存的那段字节才描述返回的 text。
fn read_text_with(
    root: &Path,
    rel: &str,
    max_bytes: u64,
    slurp: &dyn Fn(&Path) -> io::Result<Vec<u8>>,
) -> Value {
    let abs = match resolve_inside(root, rel) { Ok(p) => p, Err(e) => return err_json(&e) };
    let md = match fs::metadata(&abs) { Ok(m) => m, Err(_) => return err_json("文件不存在") };
    if !md.is_file() { return err_json("文件不存在"); } // 目录 / 特殊文件都收敛到这一句
    // maxBytes 归一:0 在 JS 侧(`o.maxBytes && o.maxBytes > 0 ? … : DEFAULT`)是非法值不是「一字节都不给」
    let max = if max_bytes > 0 { max_bytes } else { DEFAULT_MAX_BYTES };
    if md.len() > max { return serde_json::json!({ "ok": true, "bytes": md.len(), "truncated": true }); }
    let buf = match slurp(&abs) { Ok(b) => b, Err(_) => return err_json("读取失败") };
    let read_len = buf.len();
    if buf.iter().take(512).any(|&b| b == 0) {
        return serde_json::json!({ "ok": true, "bytes": md.len(), "skippedBinary": true });
    }
    match String::from_utf8(buf) {
        // D-2:bytes 取**实际读到的字节数**(JS 成功分支的 buf.length),不是 md.len()
        Ok(text) => serde_json::json!({ "ok": true, "text": text, "bytes": read_len, "truncated": false }),
        // 含非 UTF-8 字节又没 NUL:与 JS 有分歧(JS 会返回带 U+FFFD 的 text),这里按二进制跳过。
        // 见模块头的「已知且刻意保留的分歧」—— 工具页显示半个乱码文件不如不显示。
        Err(_) => serde_json::json!({ "ok": true, "bytes": md.len(), "skippedBinary": true }),
    }
}

/// 写项目内文本文件:**同目录临时文件(独占创建)+ rename** 原子落盘,默认先把原文件备份成
/// `<名><扩展>.gpm-bak-<stampSec>`(marker 收尾,例 `player.gd.gpm-bak-20261003_1200_00`)。
/// 不自动创建目录(避免把 typo 路径变成新文件),目标是目录一律拒。
pub fn write_text_json(root: &Path, rel: &str, text: &str, backup: bool) -> Value {
    write_at(root, rel, text, backup, now_ms(), &stamp_sec(), real_copy)
}

/// `write_text_json` 的实现体。`ms` / `stamp` / `copy` 三个钩子是测试接缝:
/// 临时名与备份名都可预测(`.gpm-tmp-<毫秒>-<base><ext>`、`<名>.gpm-bak-<秒级戳>`),
/// 不给确定值就没法**预占**它们,也就没法证明「独占创建」与「同秒不覆盖」真的在起作用;
/// `copy` 则用来复现「备份写到一半才失败」这个真实形态(半截备份必须当场清掉)。
fn write_at(
    root: &Path,
    rel: &str,
    text: &str,
    backup: bool,
    ms: u64,
    stamp: &str,
    copy: fn(&Path, &Path) -> io::Result<()>,
) -> Value {
    let abs = match resolve_inside(root, rel) { Ok(p) => p, Err(e) => return err_json(&e) };
    // JS 侧的 `typeof text !== 'string'` → '内容不是文本' 在 Rust 的签名里**类型系统已经挡死**
    // (text 就是 &str,命令层拿不到非字符串:Tauri 反序列化先失败),这条串在 Rust 侧不可达。
    let mut existed = false;
    match fs::metadata(&abs) {
        Ok(md) if md.is_dir() => return err_json("不能覆盖目录"),
        Ok(md) if md.is_file() => existed = true,
        // stat 问得到、但既不是目录也不是**普通文件**(FIFO / socket / 设备):
        // 当普通文件去 fs::copy 会读一个没人写的 FIFO 把线程挂死,当不存在去 rename 就是把名字覆到特殊文件上。
        Ok(_) => return err_json("写入失败"),
        Err(e) if e.kind() == io::ErrorKind::NotFound => { /* 新建文件:本来就不需要备份 */ }
        // **只有 NotFound** 才是「原文件不存在」。权限 / 成环 / IO 错意味着文件在、只是问不到:
        // 当成不存在就等于不备份直接覆写,把用户唯一的退路烧掉 —— 比这次干脆不写更糟(D-4a)。
        Err(_) => return err_json("写入失败"),
    }
    let dir = match abs.parent() {
        Some(d) => d.to_path_buf(),
        None => return err_json("目标目录不存在"),
    };
    // 缺父目录一律拒绝而不是 mkdir -p:否则一个拼错的 rel 会在项目里静默长出垃圾目录树。
    if fs::metadata(&dir).is_err() { return err_json("目标目录不存在"); }
    let name = abs.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let (base, ext) = split_name_ext(&name);

    let mut backup_rel: Value = Value::Null;
    if existed && backup {
        // D-3:marker **收尾**。旧形态 `<base>.gpm-bak-<ts><ext>` 仍以原扩展名结尾,
        // Godot 会把备份当真脚本导入、scanProjectTree 把它数成一份真实 .gd 资源、
        // 导出预设 `filter include *` 甚至能把它一起打进发布包。
        // stamp 只到秒 → 同秒第二次改同一个文件必然撞同一个名字,交给 unique_path 换名(D-3)。
        let bak = unique_path(&dir.join(format!("{}.gpm-bak-{}", name, stamp)));
        if copy(&abs, &bak).is_err() {
            // copy 失败前往往已经写了一半:半份备份比没有备份更危险(用户会拿它还原)。
            // 这里的删除**无条件安全** —— bak 由 unique_path 挑出来,挑的时候那个名字还不存在,
            // 那个路径上若有东西一定是这次刚写出来的半截(Task 4 撤掉的 bakPreExisted 守卫不回来了)。
            // 备份失败一律停在覆写**之前**:原文件此刻还是旧的。
            remove_quietly(&bak);
            return err_json("备份失败");
        }
        let bak_name = bak.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        backup_rel = Value::String(format!("{}{}", rel_dir_prefix(rel), bak_name));
    }
    // 临时名可预测 → **独占创建**(create_new = JS 的 `{flag:'wx'}`):包含闸只审过最终 abs、**没审 tmp**,
    // 项目里预置一个同名文件(最坏是同名链接指向项目外)时普通写入会跟随它把内容落到别人名下;
    // create_new 让「名字已被占」当场失败 —— 宁可这次不写。
    let tmp = dir.join(tmp_name(ms, &base, &ext));
    let landed = (|| -> io::Result<()> {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(text.as_bytes())?;
        drop(f);
        fs::rename(&tmp, &abs)
    })();
    if landed.is_err() {
        // 失败路径无条件清临时文件:原文件还是旧的,磁盘上不该留下 .gpm-tmp-* 残骸。
        remove_quietly(&tmp);
        return err_json("写入失败");
    }
    // **没有备份时省略 backupRel 键**,而不是给 null:`src/types/godot.ts:633` 声明的是
    // `backupRel?: string`,null 不在可选类型里;JS 侧 `{ ok:true, backupRel: undefined }`
    // 经 JSON 序列化后同样「键不存在」。两端形状逐字一致,消费方不必为 null 特判。
    let mut out = serde_json::Map::new();
    out.insert("ok".to_string(), Value::Bool(true));
    if !backup_rel.is_null() { out.insert("backupRel".to_string(), backup_rel); }
    Value::Object(out)
}

/// 批量移入回收站;单个失败**不中断其余**。
/// 删除一律交 `fsutil::delete_to_trash`(src-tauri/src/fsutil.rs:52-57):它对**所有平台**都调
/// `trash::delete`,没有按 OS 分叉的那条分支 —— 于是这一句 JS/Rust 两侧共用的文档不再声称
/// 「其他平台永久删除」(旧措辞与代码不符)。能不能还原取决于 `trash` crate 的平台后端。
/// 渲染层按 OS 分叉的那句「非 Windows 是永久删除」是**保守措辞**,不是本函数的行为描述。
/// 计数**以磁盘实况为准**,不信删除调用自己的回报(D-5)。
pub fn trash_json(root: &Path, rels: &[String]) -> Value {
    trash_json_with(root, rels, &crate::fsutil::delete_to_trash)
}

/// `trash_json` 的实现体(删除步注入是测试接缝:用来复现「谎报成功但盘上还在」
/// 与「同一个 abs 被点名两次」两种真实形态)。
///
/// 三条与 JS 侧逐字对齐的约定:
///   · **按解析后的绝对路径去重**,同一个文件被点名两次只交批量一次,回报沿用**首次**那条 rel;
///     不去重时 moved 会算歪(失败集合是去重的、items 不是)。
///   · **批后按盘复核**:还在的一律记 '移入回收站失败',已经不在的一律计入 moved
///     (被父目录连带带走的子文件算成功 —— 它本来就是用户点名要删的东西)。
///     于是 `['sub','sub/d.txt']` 与 `['sub/d.txt','sub']` 给出**逐字一致**的结果,不依赖输入顺序。
///   · failed 的 rel 分两态:闸拒绝的项回报**调用方原样**的串(那一项根本没碰到盘,
///     归一化后对不回用户点名的哪一条);存在性检查与复核阶段回报归一后的 rel。
fn trash_json_with(root: &Path, rels: &[String], del: &dyn Fn(&Path) -> Result<(), String>) -> Value {
    let mut items: Vec<(PathBuf, String)> = Vec::new();
    let mut queued: HashSet<PathBuf> = HashSet::new();
    let mut failed: Vec<Value> = Vec::new();
    for raw in rels {
        let rel = raw.replace('\\', "/");
        let abs = match resolve_inside(root, &rel) {
            Ok(p) => p,
            Err(e) => { failed.push(serde_json::json!({ "rel": raw.clone(), "error": e })); continue; }
        };
        // 闸的 '目标目录不存在' 在删除侧够不着(项目根总是那个已存在的祖先),
        // 缺失形态一律由这里收敛到 '文件不存在' —— JS 侧同句。
        if !abs.exists() {
            failed.push(serde_json::json!({ "rel": rel, "error": "文件不存在" }));
            continue;
        }
        if queued.contains(&abs) { continue; } // 重复点名:沿用首次那条 rel
        queued.insert(abs.clone());
        items.push((abs, rel));
    }
    for (abs, _) in &items {
        let _ = del(abs); // 回报不作计数依据:Windows 侧退出 0 不等于盘上真没了
    }
    let mut moved = 0usize;
    for (abs, rel) in &items {
        if abs.exists() {
            failed.push(serde_json::json!({ "rel": rel, "error": "移入回收站失败" }));
            continue;
        }
        moved += 1;
    }
    serde_json::json!({ "ok": failed.is_empty(), "moved": moved, "failed": failed })
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

    // =====================================================================
    // Task 7:读 / 写 / 回收三原语(逐条镜像 inspectfs.test.js 的 163 条断言)
    // =====================================================================
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 删除探针的调用计数(证明去重真的只交了一次批量)。
    static DEL_CALLS: AtomicUsize = AtomicUsize::new(0);
    /// 一律失败且**不动盘**的删除钩子(模拟 PowerShell 报错 / EPERM)。
    fn counting_failing_del(_p: &std::path::Path) -> Result<(), String> {
        DEL_CALLS.fetch_add(1, Ordering::SeqCst);
        Err("simulated recycle-bin failure".to_string())
    }
    /// 正常复制(等价实现里用的 fs::copy)。
    fn copy_ok(src: &Path, dst: &Path) -> io::Result<()> { fs::copy(src, dst).map(|_| ()) }
    /// 先落半截再失败:与 JS 侧 `halfThenThrow` 同形(copyFileSync 失败前往往已经写了一半)。
    fn half_then_throw(_src: &Path, dst: &Path) -> io::Result<()> {
        fs::write(dst, b"HALF")?;
        Err(io::Error::from_raw_os_error(28)) // ENOSPC
    }

    /// 目录条目名清单(比 OsString 更直观,断言失败时能直接读出名字)。
    fn names(dir: &std::path::Path) -> Vec<String> {
        fs::read_dir(dir).unwrap().filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect()
    }
    fn rels(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    /// 项目内是否留有 `.gpm-tmp-*` 残骸(含子目录)。
    fn tmp_residue(dir: &std::path::Path) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let p = e.path();
                if name.starts_with(".gpm-tmp-") { out.push(p.to_string_lossy().to_string()); }
                if p.is_dir() { out.extend(tmp_residue(&p)); }
            }
        }
        out
    }
    /// 备份名形状判据:等价 JS 的 `/^<base>(_N)?\.gpm-bak-\d{8}_\d{4}_\d{2}$/`。
    /// 返回 `.gpm-bak-` 之前那段(即被备份的文件名);形状不合返回 None。
    fn bak_prefix(name: &str) -> Option<&str> {
        let i = name.find(".gpm-bak-")?;
        let ts = &name[i + ".gpm-bak-".len()..];
        let d = |r: &str| r.bytes().all(|b| b.is_ascii_digit());
        let shape = ts.len() == 16
            && d(&ts[..8]) && ts.as_bytes()[8] == b'_'
            && d(&ts[9..13]) && ts.as_bytes()[13] == b'_'
            && d(&ts[14..]);
        if shape && !name[..i].is_empty() && !name[i + ".gpm-bak-".len()..].is_empty() { Some(&name[..i]) } else { None }
    }

    // ---------- 字面闸 resolve_rel(JS §1b)----------
    #[test]
    fn resolve_rel_rejects_escape_absolute_and_empty() {
        let root = std::path::Path::new("E:/proj");
        let lossy = |p: std::path::PathBuf| p.to_string_lossy().replace('\\', "/");
        assert_eq!(lossy(resolve_rel(root, "a/b.txt").unwrap()), "E:/proj/a/b.txt");
        assert!(resolve_rel(root, "../x").is_none(), "上层越界");
        assert!(resolve_rel(root, "a/../../x").is_none(), "内嵌 ..");
        assert!(resolve_rel(root, "/etc/passwd").is_none(), "POSIX 绝对");
        assert!(resolve_rel(root, "C:/Windows/a").is_none(), "Windows 绝对");
        assert!(resolve_rel(root, "c:\\Windows\\x.exe").is_none(), "反斜杠 + 盘符");
        assert!(resolve_rel(root, "").is_none(), "空串");
        assert!(resolve_rel(root, ".").is_none(), "只有 .");
        assert!(resolve_rel(root, "//").is_none(), "只有斜杠");
        assert_eq!(lossy(resolve_rel(root, "./a//b").unwrap()), "E:/proj/a/b", "容忍 . 与重复斜杠");
        assert_eq!(lossy(resolve_rel(root, "scene\\main.tscn").unwrap()), "E:/proj/scene/main.tscn",
            "Windows 反斜杠形态同样接受(与 JS resolveRel 一致)");
    }

    // ---------- 真实路径包含闸 resolveInside(JS §3 / §5b)----------
    #[test]
    fn resolve_inside_passes_normal_and_not_yet_existing_paths() {
        let root = tmp("gate");
        touch(&root, "scene/main.tscn", b"x");
        // 普通项目内文件:放行,且返回的是 resolve_rel 的 abs 形态(canonical 路径不外泄)
        let abs = resolve_inside(&root, "scene/main.tscn").expect("普通文件必须放行");
        assert_eq!(abs, resolve_rel(&root, "scene/main.tscn").unwrap(), "闸返回 abs 而不是 canonical 形态");
        // 目标尚不存在(将要新建的文件):退到最近的已存在祖先做包含校验后照常放行
        let fresh = resolve_inside(&root, "scene/new/holder.tscn").expect("新建文件不被闸挡掉");
        assert!(fresh.to_string_lossy().replace('\\', "/").ends_with("scene/new/holder.tscn"), "{:?}", fresh);
        // 多级 rel 里目录不存在但祖先存在:同样放行(与 JS s4 同形)
        assert!(resolve_inside(&root, "./scene//deep/holder.tscn").is_ok(), ". 与重复斜杠不影响闸");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resolve_inside_maps_every_failure_to_the_js_string() {
        let root = tmp("gate-err");
        touch(&root, "a.txt", b"x");
        for bad in ["", ".", "..", "../x", "a/../../x", "/etc/passwd", "C:/Windows/x.exe", "c:\\Windows\\x.exe", "//"] {
            assert_eq!(resolve_inside(&root, bad).unwrap_err(), "非法路径", "字面越界 {}", bad);
        }
        // root 为空:与 JS 的 `!root` 同形态(命令层拿不到项目时也是这句)
        assert_eq!(resolve_inside(std::path::Path::new(""), "a.txt").unwrap_err(), "项目不存在");
        fs::remove_dir_all(&root).ok();
    }

    /// D-1:目录形态用 junction 挡(Windows 无需权限),文件形态需特权 → 无特权时打可见 SKIP。
    #[test]
    fn resolve_inside_rejects_link_pointing_outside_the_tree() {
        let root = tmp("gate-link");
        touch(&root, "a.txt", b"x");
        let outside = outside_dir("gate");
        touch(&outside, "secret.txt", b"SECRET-OUTSIDE-TREE\n");
        match make_dir_link(&outside, &root.join("linkdir")) {
            Err(why) => skip_assert("resolveInside:目录链接外指 → 非法路径", &why),
            Ok(()) => {
                assert_eq!(resolve_inside(&root, "linkdir").unwrap_err(), "非法路径", "链接本身就落在闸外");
                assert_eq!(resolve_inside(&root, "linkdir/secret.txt").unwrap_err(), "非法路径",
                    "穿过链接的已存在目标同样拒");
                // 目标还不存在时也要拒:退到最近已存在祖先 = 链接目录 → realpath 到项目外
                assert_eq!(resolve_inside(&root, "linkdir/pwn.txt").unwrap_err(), "非法路径",
                    "穿过链接的新建路径同样拒(写侧的形态)");
                assert!(resolve_inside(&root, "a.txt").is_ok(), "普通文件不受新闸误伤");
            }
        }
        match make_file_link(&outside.join("secret.txt"), &root.join("link-out.txt")) {
            Err(why) => skip_assert("resolveInside:文件链接外指 → 非法路径", &why),
            Ok(()) => assert_eq!(resolve_inside(&root, "link-out.txt").unwrap_err(), "非法路径"),
        }
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    /// JS §5b:项目正好装在盘根时,包含比较不得因「根带尾分隔符」误伤。
    #[test]
    fn resolve_inside_does_not_misfire_when_project_root_is_filesystem_root() {
        let probe_root = tmp("gate-fsroot");
        let fs_root = probe_root.ancestors().last().unwrap().to_path_buf(); // 'C:\\' / '/'
        let candidate = fs::read_dir(&fs_root).ok().map(|rd| rd.filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .find(|n| {
                let p = fs_root.join(n);
                // 与 JS 同纪律:lstat 问得到的**非链接**目录、且 canonicalize 问得到的才用
                // (受保护目录的 realpath 会抛,链接目录会把包含校验真的判成越界)
                fs::symlink_metadata(&p)
                    .map(|m| m.is_dir() && !m.file_type().is_symlink() && fs::canonicalize(&p).is_ok())
                    .unwrap_or(false)
            })
            .unwrap_or_default());
        let cand = match candidate {
            Some(c) if !c.is_empty() => c,
            _ => { skip_assert("文件系统根包含校验", "根目录读不到,或没有一个 canonicalize 问得到的子目录");
                   fs::remove_dir_all(&probe_root).ok(); return; }
        };
        assert!(resolve_inside(&fs_root, &cand).is_ok(),
            "项目根为文件系统根时,根内已存在目录不得被误判为 '非法路径'({})", cand);
        assert!(resolve_inside(&fs_root, &format!("{}/gpm-not-here.txt", cand)).is_ok(),
            "项目根为文件系统根时,根内尚未存在的路径也放行");
        fs::remove_dir_all(&probe_root).ok();
    }

    // ---------- read_text_json(JS §2 / §3 / §4)----------
    #[test]
    fn read_text_respects_limit_and_nul_sniff() {
        let root = tmp("read");
        touch(&root, "a.txt", b"hello");
        touch(&root, "bin.dat", &[b'a', b'b', 0, b'c']);
        touch(&root, "cn.txt", "中文内容\n".as_bytes());
        touch(&root, "sub/b.txt", b"in-sub");
        let v = read_text_json(&root, "a.txt", DEFAULT_MAX_BYTES);
        assert_eq!(v["ok"], true);
        assert_eq!(v["text"], "hello");
        assert_eq!(v["truncated"], false);
        assert_eq!(v["bytes"], 5);
        assert_eq!(read_text_json(&root, "sub/b.txt", DEFAULT_MAX_BYTES)["text"], "in-sub", "多级 rel 读得到");
        let b = read_text_json(&root, "bin.dat", DEFAULT_MAX_BYTES);
        assert_eq!(b["skippedBinary"], true, "前 512 字节含 NUL 判二进制");
        assert_eq!(b["text"], Value::Null, "skippedBinary 时不返回 text");
        assert_eq!(b["bytes"], 4, "skippedBinary 的 bytes 取磁盘大小(没有 text 可描述)");
        let t = read_text_json(&root, "a.txt", 2);
        assert_eq!(t["truncated"], true, "超限额只标 truncated");
        assert_eq!(t["text"], Value::Null, "truncated 时不返回内容");
        assert_eq!(t["bytes"], 5, "truncated 的 bytes 取 st.size");
        assert_eq!(t["ok"], true, "超限不是错误");
        // UTF-8 中文按原文返回(与 JS 同一份夹具)
        assert_eq!(read_text_json(&root, "cn.txt", DEFAULT_MAX_BYTES)["text"], "中文内容\n");
        // 缺失 / 目录 / 越界
        assert_eq!(read_text_json(&root, "nope.txt", DEFAULT_MAX_BYTES)["error"], "文件不存在");
        assert_eq!(read_text_json(&root, "sub", DEFAULT_MAX_BYTES)["error"], "文件不存在", "目录不可当文件读");
        assert_eq!(read_text_json(&root, "../x", DEFAULT_MAX_BYTES)["error"], "非法路径");
        assert_eq!(read_text_json(&root, "", DEFAULT_MAX_BYTES)["error"], "非法路径");
        assert_eq!(read_text_json(&root, "C:/Windows/a.txt", DEFAULT_MAX_BYTES)["error"], "非法路径");
        fs::remove_dir_all(&root).ok();
    }

    /// D-2:`bytes` 取**实际读到的字节数**,不是 stat 的 size —— 与 JS 成功分支的 buf.length 同形。
    #[test]
    fn read_text_bytes_describe_the_text_actually_returned() {
        let root = tmp("read-bytes");
        touch(&root, "cn.txt", "中文内容\n".as_bytes());
        let v = read_text_json(&root, "cn.txt", DEFAULT_MAX_BYTES);
        let text = v["text"].as_str().expect("读到文本");
        assert_eq!(v["bytes"].as_u64().unwrap() as usize, text.len(),
            "bytes 等于返回文本的真实 UTF-8 字节数(中文夹具)");
        assert_eq!(text.len(), 13, "夹具字节数与 JS 侧一致(4 个汉字 ×3 + 换行)");

        // 决定性判据:stat 与 read 之间文件被改写过(JS 注释里的那条竞态)—— 注入一个
        // 比磁盘大小**更长**的读取结果,bytes 必须跟着读取结果走,而不是跟着 md.len() 走。
        let grown = read_text_with(&root, "cn.txt", DEFAULT_MAX_BYTES,
            &|_p| Ok(Vec::from("改写后更多内容\n".as_bytes())));
        assert_eq!(grown["ok"], true);
        assert_eq!(grown["skippedBinary"], Value::Null, "注入的内容不含 NUL,不该被判二进制");
        let want = "改写后更多内容\n".len(); // str::len 就是 UTF-8 字节数
        assert_eq!(grown["bytes"].as_u64().unwrap() as usize, want,
            "bytes 必须是刚读进内存的字节数(旧实现返回 md.len() 会在这里红)");
        assert_eq!(grown["text"], "改写后更多内容\n");
        // 注入读取失败 → '读取失败'(与 JS 的 readFileSync catch 同形)
        let fail = read_text_with(&root, "cn.txt", DEFAULT_MAX_BYTES,
            &|_p| Err(io::Error::from(io::ErrorKind::PermissionDenied)));
        assert_eq!(fail["ok"], false);
        assert_eq!(fail["error"], "读取失败");
        fs::remove_dir_all(&root).ok();
    }

    /// maxBytes 归一:0 不是「一个字节都不给」而是非法值(JS `o.maxBytes && o.maxBytes > 0`)。
    #[test]
    fn read_text_normalizes_non_positive_max_bytes() {
        let root = tmp("read-max");
        touch(&root, "a.txt", b"hello");
        assert_eq!(read_text_json(&root, "a.txt", 0)["text"], "hello", "maxBytes=0 退默认限额");
        assert_eq!(read_text_json(&root, "a.txt", 0)["truncated"], false);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_text_refuses_link_pointing_outside_the_tree() {
        let root = tmp("read-link");
        touch(&root, "project.godot", b"[application]\n");
        let outside = outside_dir("read");
        touch(&outside, "secret.txt", b"SECRET-OUTSIDE-TREE\n");
        match make_dir_link(&outside, &root.join("linkdir")) {
            Err(why) => skip_assert("读取穿过项目内目录链接 → 非法路径", &why),
            Ok(()) => {
                let v = read_text_json(&root, "linkdir/secret.txt", DEFAULT_MAX_BYTES);
                assert_eq!(v["ok"], false, "不得读到项目外内容: {:?}", v);
                assert_eq!(v["error"], "非法路径", "包含闸失败与字面闸同串(不透露是哪一类)");
                assert_eq!(v["text"], Value::Null, "被挡住时不能带出任何内容");
            }
        }
        match make_file_link(&outside.join("secret.txt"), &root.join("link-out.txt")) {
            Err(why) => skip_assert("读取穿过项目内文件链接 → 非法路径", &why),
            Ok(()) => {
                let v = read_text_json(&root, "link-out.txt", DEFAULT_MAX_BYTES);
                assert_eq!(v["error"], "非法路径", "{:?}", v);
                assert_eq!(v["text"], Value::Null);
            }
        }
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    // ---------- write_text_json(JS §5 / R-1 / R-7 / R-2 / R-9)----------
    #[test]
    fn write_text_backs_up_and_is_atomic() {
        let root = tmp("write");
        touch(&root, "c.txt", b"OLD");
        let r = write_text_json(&root, "c.txt", "NEW", true);
        assert_eq!(r["ok"], true, "{:?}", r);
        assert_eq!(fs::read_to_string(root.join("c.txt")).unwrap(), "NEW");
        let bak = r["backupRel"].as_str().expect("有备份名");
        // D-3:marker 收尾 —— 原扩展名不再留在结尾(`c.gpm-bak-<ts>.txt` 那种形态会被 Godot 导入)
        assert_eq!(bak_prefix(bak), Some("c.txt"), "备份名形如 c.txt.gpm-bak-YYYYMMDD_HHmm_ss: {}", bak);
        assert_eq!(fs::read_to_string(root.join(bak)).unwrap(), "OLD", "备份里是原内容");
        let nobak = write_text_json(&root, "c.txt", "X", false);
        assert!(nobak.get("backupRel").is_none(),
            "backup:false 不产生备份,且**省略** backupRel 键(不给 null,与 JS 的 undefined 序列化同形): {:?}", nobak);
        assert_eq!(fs::read_to_string(root.join("c.txt")).unwrap(), "X");
        assert_eq!(write_text_json(&root, "sub/x.txt", "A", true)["error"], "目标目录不存在", "不自动建目录");
        assert_eq!(write_text_json(&root, "", "A", true)["error"], "非法路径");
        assert_eq!(write_text_json(&root, "../x", "A", true)["error"], "非法路径");
        fs::create_dir_all(root.join("d")).unwrap();
        assert_eq!(write_text_json(&root, "d", "A", true)["error"], "不能覆盖目录");
        assert_eq!(fs::read_to_string(root.join("c.txt")).unwrap(), "X", "被拒绝的写不改原文件");
        assert!(tmp_residue(&root).is_empty(), "不留临时残骸: {:?}", tmp_residue(&root));
        // 新文件(原不存在)不产生备份
        let n = write_text_json(&root, "brand-new.txt", "FRESH", true);
        assert_eq!(n["ok"], true, "{:?}", n);
        assert!(n.get("backupRel").is_none(), "原文件不存在时不产生备份 → 省略 backupRel 键: {:?}", n);
        assert_eq!(fs::read_to_string(root.join("brand-new.txt")).unwrap(), "FRESH");
        fs::remove_dir_all(&root).ok();
    }

    /// D-3 + JS R-1:备份名以 marker 收尾,`.gd` 的备份 extname 不再是 `.gd`。
    #[test]
    fn write_text_backup_name_is_marker_last_so_godot_never_imports_it() {
        let root = tmp("write-bak");
        touch(&root, "player.gd", b"extends Node\n");
        let r = write_at(&root, "player.gd", "extends Node2D\n", true, 1_700_000_000_000, "20261003_1200_00", copy_ok);
        assert_eq!(r["ok"], true, "{:?}", r);
        assert_eq!(r["backupRel"], "player.gd.gpm-bak-20261003_1200_00",
            "备份名 = <名><扩展>.gpm-bak-<stampSec>");
        let bak = r["backupRel"].as_str().unwrap();
        assert!(!bak.ends_with(".gd"), "备份的 extname 不再是 .gd(Godot / exts 过滤都看不见它)");
        assert_eq!(fs::read_to_string(root.join(bak)).unwrap(), "extends Node\n");
        assert_eq!(fs::read_to_string(root.join("player.gd")).unwrap(), "extends Node2D\n");
        // R-7:backupRel 保留**归一后**的目录前缀(渲染层就是按 scan 的 rel 找文件的)
        touch(&root, "scene/deep2.txt", b"E1\n");
        let d = write_at(&root, "./scene//deep2.txt", "E2\n", true, 1_700_000_000_001, "20261003_1200_01", copy_ok);
        assert_eq!(d["backupRel"], "scene/deep2.txt.gpm-bak-20261003_1200_01",
            "rel 写成 './scene//deep2.txt' → 前缀归一为 scene/,不带 ./");
        assert_eq!(fs::read_to_string(root.join(d["backupRel"].as_str().unwrap())).unwrap(), "E1\n");
        fs::remove_dir_all(&root).ok();
    }

    /// D-3:同一秒内改两次 → 第二次必须换名(uniquePath 的 `_N` 插在**最后一个点之前**)。
    #[test]
    fn write_text_two_backups_in_the_same_second_do_not_clobber_each_other() {
        let root = tmp("write-dup");
        touch(&root, "dup.txt", b"V1\n");
        let d1 = write_at(&root, "dup.txt", "V2\n", true, 1_700_000_000_000, "20261003_1200_00", copy_ok);
        let d2 = write_at(&root, "dup.txt", "V3\n", true, 1_700_000_000_500, "20261003_1200_00", copy_ok);
        assert_eq!(d1["backupRel"], "dup.txt.gpm-bak-20261003_1200_00", "无碰撞时保持规范形状");
        assert_eq!(d2["backupRel"], "dup.txt_2.gpm-bak-20261003_1200_00",
            "换名后缀落在 dup.txt 与 marker 之间(_N 插在最后一个点之前),不是接在名字末尾: {:?}", d2);
        assert_ne!(d1["backupRel"], d2["backupRel"], "同秒两次写入的备份名必须不同");
        let mut baks = names(&root).into_iter().filter(|n| bak_prefix(n) == Some("dup.txt") || bak_prefix(n) == Some("dup.txt_2")).collect::<Vec<_>>();
        baks.sort();
        assert_eq!(baks, vec!["dup.txt.gpm-bak-20261003_1200_00".to_string(),
                             "dup.txt_2.gpm-bak-20261003_1200_00".to_string()], "目录里两份备份都在");
        assert_eq!(fs::read_to_string(root.join(&baks[0])).unwrap(), "V1\n", "第一份存着当时的原文");
        assert_eq!(fs::read_to_string(root.join(&baks[1])).unwrap(), "V2\n", "第二份存着上一次的原文");
        assert_eq!(fs::read_to_string(root.join("dup.txt")).unwrap(), "V3\n", "两次写入都落到了目标");
        // 第三次:再撞 → _3
        let d3 = write_at(&root, "dup.txt", "V4\n", true, 1_700_000_000_900, "20261003_1200_00", copy_ok);
        assert_eq!(d3["backupRel"], "dup.txt_3.gpm-bak-20261003_1200_00", "{:?}", d3);
        assert_eq!(fs::read_to_string(root.join("dup.txt")).unwrap(), "V4\n");
        assert!(tmp_residue(&root).is_empty(), "不留残骸");
        fs::remove_dir_all(&root).ok();
    }

    /// D-4(c):临时名可预测 → 必须**独占创建**;被预占时宁可这次不写,且不留残骸。
    #[test]
    fn write_text_temp_file_is_created_exclusively_and_leaves_no_residue() {
        let root = tmp("write-wx");
        touch(&root, "cfg.txt", b"ORIGINAL\n");
        let ms = 1_700_000_000_123;
        let predicted = tmp_name(ms, "cfg", ".txt");
        assert!(predicted.starts_with(".gpm-tmp-"), "临时名以 .gpm-tmp- 开头: {}", predicted);
        assert!(predicted.ends_with(".txt"), "临时名以目标**真实扩展名**结尾(不用 fsutil.tempPath 的 .zip 形态)");
        assert!(!predicted.ends_with(".zip"), "红线:这里不能用 fsutil.tempPath");
        // 预占那个可预测的名字(最坏情形是同名链接,这里用普通文件即可证明「不跟随/不复用」)
        fs::write(root.join(&predicted), b"PRE-PLANTED-BY-OTHER\n").unwrap();
        let w = write_at(&root, "cfg.txt", "WX-MUST-NOT-LAND", true, ms, "20261003_1200_00", copy_ok);
        assert_eq!(w["ok"], false, "临时名被预占必须失败而不是复用: {:?}", w);
        assert_eq!(w["error"], "写入失败", "钉住这条串(Rust 与 JS 逐字一致)");
        assert_eq!(fs::read_to_string(root.join("cfg.txt")).unwrap(), "ORIGINAL\n", "被挡掉的写没碰原文件");
        // 与 JS 同形:备份在**覆写之前**就落盘,写入失败不回滚它(宁可多一份备份,不少一份退路)
        let baks = names(&root).into_iter().filter(|n| bak_prefix(n).is_some()).collect::<Vec<_>>();
        assert_eq!(baks, vec!["cfg.txt.gpm-bak-20261003_1200_00".to_string()], "备份已先行落盘: {:?}", baks);
        assert_eq!(fs::read_to_string(root.join(&baks[0])).unwrap(), "ORIGINAL\n", "备份里是原文件原文");
        assert!(tmp_residue(&root).is_empty(), "wx 失败后同样清掉残骸(含被预占的那个名字): {:?}", tmp_residue(&root));
        // 独占创建本身的行为:名字空着时写得进去
        let ok = write_at(&root, "cfg.txt", "AFTER\n", false, ms + 1, "20261003_1200_00", copy_ok);
        assert_eq!(ok["ok"], true, "{:?}", ok);
        assert_eq!(fs::read_to_string(root.join("cfg.txt")).unwrap(), "AFTER\n");
        assert!(tmp_residue(&root).is_empty());
        fs::remove_dir_all(&root).ok();
    }

    /// JS R-4:备份失败 = 停在覆写之前 + 自己刚写的半截备份当场清掉(无条件,不看是否预存)。
    #[test]
    fn write_text_backup_failure_keeps_original_and_removes_half_written_backup() {
        let root = tmp("write-bakfail");
        touch(&root, "bf.txt", b"BF-ORIG\n");
        // ① 规范名已被「上一份真备份」占着 → 新的半截备份必须写到别处,哨兵一字节都不动
        let sentinel = "bf.txt.gpm-bak-20261003_1200_00";
        fs::write(root.join(sentinel), b"SENTINEL-PREV-BACKUP\n").unwrap();
        let a = write_at(&root, "bf.txt", "MUST-NOT-LAND", true, 1_700_000_001_000, "20261003_1200_00", half_then_throw);
        assert_eq!(a["ok"], false);
        assert_eq!(a["error"], "备份失败", "{:?}", a);
        assert_eq!(fs::read_to_string(root.join(sentinel)).unwrap(), "SENTINEL-PREV-BACKUP\n",
            "上一份同名备份既没被覆写也没被清理误删");
        assert_eq!(fs::read_to_string(root.join("bf.txt")).unwrap(), "BF-ORIG\n", "备份失败时原文件原封不动");
        let baks = || names(&root).into_iter().filter(|n| bak_prefix(n).is_some()).collect::<Vec<_>>();
        assert_eq!(baks(), vec![sentinel.to_string()], "半截备份被清掉,目录里只剩哨兵那一份: {:?}", baks());
        assert!(tmp_residue(&root).is_empty(), "备份失败同样不留 .gpm-tmp-* 残骸");
        // ② 名字空着时:半截备份同样必须清干净(半份备份比没有备份更危险)
        fs::remove_file(root.join(sentinel)).unwrap();
        let b = write_at(&root, "bf.txt", "MUST-NOT-LAND", true, 1_700_000_002_000, "20261003_1200_00", half_then_throw);
        assert_eq!(b["error"], "备份失败", "{:?}", b);
        assert!(baks().is_empty(), "自己刚写的半截备份没留在盘上: {:?}", baks());
        assert_eq!(fs::read_to_string(root.join("bf.txt")).unwrap(), "BF-ORIG\n");
        assert!(tmp_residue(&root).is_empty());
        fs::remove_dir_all(&root).ok();
    }

    /// D-1 写侧:穿过项目内链接写到项目外 → '非法路径',项目外磁盘零改动。
    #[test]
    fn write_text_refuses_link_pointing_outside_the_tree() {
        let root = tmp("write-link");
        touch(&root, "project.godot", b"[application]\n");
        let outside = outside_dir("write");
        touch(&outside, "secret.txt", b"SECRET-OUTSIDE-TREE\n");
        match make_dir_link(&outside, &root.join("linkdir")) {
            Err(why) => skip_assert("写入穿过项目内目录链接 → 非法路径", &why),
            Ok(()) => {
                let w = write_text_json(&root, "linkdir/pwn.txt", "PWNED", true);
                assert_eq!(w["ok"], false, "{:?}", w);
                assert_eq!(w["error"], "非法路径");
                assert!(!outside.join("pwn.txt").exists(), "被挡住的写在项目外没留下文件");
                let w2 = write_text_json(&root, "linkdir/secret.txt", "PWNED", true);
                assert_eq!(w2["error"], "非法路径", "{:?}", w2);
                assert_eq!(fs::read_to_string(outside.join("secret.txt")).unwrap(), "SECRET-OUTSIDE-TREE\n",
                    "被挡住的写没有改动项目外的原文件");
            }
        }
        match make_file_link(&outside.join("secret.txt"), &root.join("link-out.txt")) {
            Err(why) => skip_assert("覆盖项目内文件链接 → 非法路径", &why),
            Ok(()) => {
                let w = write_text_json(&root, "link-out.txt", "PWNED", true);
                assert_eq!(w["error"], "非法路径", "{:?}", w);
                assert_eq!(fs::read_to_string(outside.join("secret.txt")).unwrap(), "SECRET-OUTSIDE-TREE\n");
            }
        }
        assert!(tmp_residue(&root).is_empty(), "被拒的写不留残骸");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    /// D-4(a)(b):stat 问到的不是「不存在」也不是普通文件 → 拒写 '写入失败'。
    /// ELOOP 形态要靠链接(与 JS 的 R-3 ELOOP 同一形态),非法文件名形态只在 Windows 造得出非 NotFound 错:
    /// 两者都造不出来时打**可见** SKIP,绝不记 PASS。
    #[test]
    fn write_text_refuses_when_stat_error_is_not_enoent_or_target_is_not_a_regular_file() {
        let root = tmp("write-stat");
        touch(&root, "cfg.txt", b"ORIGINAL\n");
        let before = fs::read_to_string(root.join("cfg.txt")).unwrap();
        let bak_count = |r: &std::path::Path| names(r).into_iter().filter(|n| bak_prefix(n).is_some()).count();
        assert_eq!(bak_count(&root), 0);

        // (a) 成环的链接对:statSync 在 JS 侧是 ELOOP、Rust 侧是 FilesystemLoop —— 都不是 ENOENT。
        let l1 = root.join("l1");
        let l2 = root.join("l2");
        match make_dir_link(&l2, &l1).and_then(|()| make_dir_link(&l1, &l2)) {
            Err(why) => skip_assert("stat 非 ENOENT 失败(ELOOP 形态)→ 写入失败", &why),
            Ok(()) => {
                assert!(!l1.exists(), "夹具前提:lstat 问得到、stat 问不到(成环)");
                let w = write_text_json(&root, "l1", "BLIND-WRITE", true);
                assert_eq!(w["ok"], false, "成环目标不得被当作「原文件不存在」裸写: {:?}", w);
                assert_eq!(w["error"], "写入失败", "钉住这条串(Rust 与 JS 逐字一致)");
                assert_eq!(fs::read_to_string(root.join("cfg.txt")).unwrap(), before, "原文件完好");
                assert_eq!(bak_count(&root), 0, "stat 失败时不产生备份");
                assert!(tmp_residue(&root).is_empty(), "也不留临时残骸: {:?}", tmp_residue(&root));
            }
        }
        // (b) 非法文件名形态:Windows 上 stat 得到 InvalidFilename(非 NotFound),POSIX 上它是合法名字
        let odd = root.join("q?.txt");
        let odd_kind = fs::metadata(&odd).map(|_| ()).map_err(|e| e.kind())
            .err().unwrap_or(std::io::ErrorKind::NotFound);
        if odd_kind == std::io::ErrorKind::NotFound {
            skip_assert("stat 非 ENOENT 失败(InvalidFilename 形态)",
                &format!("本机 stat('q?.txt') 的错型是 {:?},不是「非 NotFound」", odd_kind));
        } else {
            let w = write_text_json(&root, "q?.txt", "BLIND-WRITE", true);
            assert_eq!(w["error"], "写入失败", "stat 出错不等于「没有原文件」: {:?}", w);
            assert!(tmp_residue(&root).is_empty(), "被拒的写不留残骸: {:?}", tmp_residue(&root));
        }
        fs::remove_dir_all(&root).ok();
    }

    /// D-4(b):stat 问得到、但既不是目录也不是普通文件 → 拒写。POSIX 用 mkfifo 造真 FIFO;
    /// Windows 上没有可零权限造出的非目录非普通文件(device/socket 都要特权或不是路径形态)→ 可见 SKIP。
    #[test]
    fn write_text_refuses_special_file_targets() {
        let root = tmp("write-special");
        let target = root.join("fifo.txt");
        #[cfg(unix)]
        let made = (|| -> Result<(), String> {
            use std::os::unix::fs::FileTypeExt;
            let st = std::process::Command::new("mkfifo").arg(&target).status()
                .map_err(|e| format!("mkfifo 启动失败:{e}"))?;
            if !st.success() { return Err("mkfifo 退出非零".to_string()); }
            match fs::symlink_metadata(&target) {
                Ok(m) if m.file_type().is_fifo() => Ok(()),
                Ok(_) => { let _ = fs::remove_file(&target); Err("mkfifo 没造出 FIFO".to_string()) }
                Err(e) => Err(format!("mkfifo 后问不到:{e}")),
            }
        })();
        #[cfg(not(unix))]
        let made: Result<(), String> = {
            let _ = &target; // Windows 上造不出这个夹具,只有 POSIX 分支用得到它
            Err("Windows 无零权限可造的非目录非普通文件(FIFO/socket/device)".into())
        };
        match made {
            Err(why) => skip_assert("非普通文件(FIFO/socket)→ 写入失败", &why),
            Ok(()) => {
                let w = write_text_json(&root, "fifo.txt", "X", true);
                assert_eq!(w["ok"], false, "特殊文件既不能当可备份的普通文件、也不能当不存在覆掉: {:?}", w);
                assert_eq!(w["error"], "写入失败", "钉住这条串(Rust 与 JS 逐字一致)");
                assert!(tmp_residue(&root).is_empty(), "拒写不留残骸");
            }
        }
        fs::remove_dir_all(&root).ok();
    }

    /// 缺父目录 / 目标是目录 / 越界 rel:三种拒绝都不留痕迹。
    #[test]
    fn write_text_refusals_leave_no_trace() {
        let root = tmp("write-refuse");
        fs::create_dir_all(root.join("d")).unwrap();
        assert_eq!(write_text_json(&root, "nosub/x.txt", "A", true)["error"], "目标目录不存在");
        assert!(!root.join("nosub").exists(), "被拒绝的写入不留任何痕迹");
        assert_eq!(write_text_json(&root, "d", "A", true)["error"], "不能覆盖目录");
        assert_eq!(write_text_json(&root, "d/", "A", true)["error"], "不能覆盖目录", "rel 尾部斜杠同样归到目录");
        assert_eq!(write_text_json(&root, "C:/Windows/a.txt", "A", true)["error"], "非法路径");
        assert!(tmp_residue(&root).is_empty());
        assert_eq!(names(&root), vec!["d".to_string()], "目录树没被改动");
        fs::remove_dir_all(&root).ok();
    }

    /// JS §5 原子过程:内容先落同目录临时文件、再 rename 到目标,全程不直写目标。
    /// Rust 侧钩不到 fs.writeFileSync,所以钉「结果」:目标同目录出现过 .gpm-tmp-* 形态的名字
    /// (由 tmp_name 的确定性形态保证),且失败路径清空。
    #[test]
    fn write_text_renames_within_the_target_directory() {
        let root = tmp("write-atomic");
        touch(&root, "sub/cfg.txt", b"OLD\n");
        let ms = 1_700_000_003_000;
        // 预占**目标同目录**(sub/)里那个可预测的临时名:根目录放同名文件挡不住它 ——
        // 探针命中即同时钉住「临时文件与目标同目录(rename 才不跨盘、才谈得上原子)」。
        let predicted = root.join("sub").join(tmp_name(ms, "cfg", ".txt"));
        fs::write(&predicted, b"PLANTED\n").unwrap();
        let w = write_at(&root, "sub/cfg.txt", "NEW\n", false, ms, "20261003_1200_00", copy_ok);
        assert_eq!(w["ok"], false, "{:?}", w);
        assert_eq!(w["error"], "写入失败");
        assert_eq!(fs::read_to_string(root.join("sub/cfg.txt")).unwrap(), "OLD\n", "原子替换:失败时原文件保持旧内容");
        assert!(!predicted.exists(), "独占创建撞名后不留残骸");
        let ok = write_at(&root, "sub/cfg.txt", "NEW\n", false, ms + 5, "20261003_1200_00", copy_ok);
        assert_eq!(ok["ok"], true, "{:?}", ok);
        assert_eq!(fs::read_to_string(root.join("sub/cfg.txt")).unwrap(), "NEW\n", "子目录写入的落点正确");
        assert!(tmp_residue(&root).is_empty(), "子目录写入同样不留残骸");
        fs::remove_dir_all(&root).ok();
    }

    // ---------- trash_json(JS §6 / §6b / §6f / §6g)----------
    #[test]
    fn trash_reports_failures_without_interrupting() {
        let root = tmp("trash");
        touch(&root, "a.txt", b"x");
        touch(&root, "b.txt", b"x");
        touch(&root, "sub/c.txt", b"x");
        let r = trash_json(&root, &rels(&["a.txt", "nope.txt", "../evil"]));
        assert!(!names(&root).contains(&"a.txt".to_string()), "a.txt 应已消失: {:?}", names(&root));
        assert!(names(&root).contains(&"b.txt".to_string()), "未点名的文件不受影响");
        assert!(names(&root).contains(&"sub".to_string()), "没点名的目录不受影响");
        assert_eq!(r["moved"], 1, "{:?}", r);
        let failed = r["failed"].as_array().unwrap();
        assert_eq!(failed.len(), 2, "缺失 + 越界各一条: {:?}", failed);
        assert!(failed.iter().any(|f| f["rel"] == "nope.txt" && f["error"] == "文件不存在"), "{:?}", failed);
        assert!(failed.iter().any(|f| f["rel"] == "../evil" && f["error"] == "非法路径"),
            "闸拒绝的那一项回报**调用方原样**的串: {:?}", failed);
        assert_eq!(r["ok"], false);
        // 空清单不是错误
        let e = trash_json(&root, &[]);
        assert_eq!(e["ok"], true);
        assert_eq!(e["moved"], 0);
        assert_eq!(e["failed"].as_array().unwrap().len(), 0);
        // 反斜杠形态的 rel 照常解析并删除,回报里给的是归一后的 rel
        touch(&root, "sub2/y.txt", b"Y\n");
        let bs = trash_json(&root, &rels(&["sub2\\y.txt"]));
        assert_eq!(bs["ok"], true, "{:?}", bs);
        assert_eq!(bs["moved"], 1);
        assert!(!root.join("sub2/y.txt").exists(), "反斜杠 rel 的落点正确");
        let empty_dir = trash_json(&root, &rels(&["sub2"]));
        assert_eq!(empty_dir["ok"], true, "清空后的目录本身也是合法删除对象: {:?}", empty_dir);
        assert!(!root.join("sub2").exists());
        // 父目录也不存在的缺失项 → 统一收敛到 '文件不存在'(闸的 '目标目录不存在' 在删除侧够不着)
        let miss = trash_json(&root, &rels(&["nodir/x.txt"]));
        assert_eq!(miss["ok"], false);
        assert_eq!(miss["moved"], 0);
        assert_eq!(miss["failed"][0]["error"], "文件不存在", "{:?}", miss);
        assert_eq!(miss["failed"][0]["rel"], "nodir/x.txt", "回报归一后的 rel");
        assert!(!root.join("nodir").exists(), "被拒绝的删除没在项目里长出目录树");
        assert!(tmp_residue(&root).is_empty(), "删除流程不产生 .gpm-tmp-* 残骸");
        fs::remove_dir_all(&root).ok();
    }

    /// D-5 复核:计数以磁盘实况为准,不信删除调用自己的回报。
    #[test]
    fn trash_rechecks_disk_instead_of_trusting_the_delete_report() {
        let root = tmp("trash-lie");
        touch(&root, "fake.txt", b"F");
        // 谎报成功(退出 0 但盘上没删)→ 复核必须补进 failed
        let r = trash_json_with(&root, &rels(&["fake.txt"]), &|_p| Ok(()));
        assert_eq!(r["ok"], false, "{:?}", r);
        assert_eq!(r["moved"], 0, "底层报成功而文件仍在 → 不算 moved");
        assert_eq!(r["failed"][0]["error"], "移入回收站失败", "钉住这条串(Rust 与 JS 逐字一致)");
        assert_eq!(r["failed"][0]["rel"], "fake.txt");
        assert!(root.join("fake.txt").exists(), "被复核揪出来的那一项确实还在原地");
        // 谎报失败(其实删掉了)→ 复核按盘计成功
        let root2 = tmp("trash-lie2");
        touch(&root2, "gone.txt", b"G");
        let r2 = trash_json_with(&root2, &rels(&["gone.txt"]), &|p| { fs::remove_file(p).map_err(|e| e.to_string()) });
        assert_eq!(r2["ok"], true, "删除回报 Err 但盘上已经没了 → 以磁盘为准记成功: {:?}", r2);
        assert_eq!(r2["moved"], 1);
        assert_eq!(r2["failed"].as_array().unwrap().len(), 0);
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&root2).ok();
    }

    /// D-5 去重:同一个解析后绝对路径只交批量一次,回报沿用首次那条 rel。
    #[test]
    fn trash_dedupes_by_resolved_absolute_path() {
        let root = tmp("trash-dup");
        touch(&root, "g.txt", b"G");
        touch(&root, "keep.txt", b"K");
        DEL_CALLS.store(0, std::sync::atomic::Ordering::SeqCst);
        // 探针:删除一律抛错(全失败)且**不删盘**,调用次数即去重证据
        let r = trash_json_with(&root, &rels(&["g.txt", "./g.txt", "g.txt"]), &counting_failing_del);
        assert_eq!(DEL_CALLS.load(std::sync::atomic::Ordering::SeqCst), 1,
            "同一个 abs 只交给批量一次(三种 rel 写法算同一个文件)");
        assert_eq!(r["ok"], false, "{:?}", r);
        assert_eq!(r["moved"], 0, "全部失败时 moved:0(旧算法这里会报 moved:1)");
        let failed = r["failed"].as_array().unwrap();
        assert_eq!(failed.len(), 1, "failed 去重:同一个 rel 不出现两遍: {:?}", failed);
        assert_eq!(failed[0]["rel"], "g.txt", "沿用首次出现的那个 rel 串");
        assert_eq!(failed[0]["error"], "移入回收站失败");
        assert!(root.join("g.txt").exists() && root.join("keep.txt").exists(), "去重这批一个字节都没少");
        // 三种写法只计一次成功
        let r2 = trash_json(&root, &rels(&["g.txt", "./g.txt", "g.txt"]));
        assert_eq!(r2["ok"], true, "{:?}", r2);
        assert_eq!(r2["moved"], 1, "同一文件的三种 rel 写法只计一次 moved(不是 3)");
        assert!(!root.join("g.txt").exists(), "去重不影响删除效果");
        assert!(root.join("keep.txt").exists());
        fs::remove_dir_all(&root).ok();
    }

    /// D-5 顺序无关:父在前 / 子在前必须给出逐字一致的结果。
    #[test]
    fn trash_nested_parent_and_child_agree_in_both_orders() {
        let a = tmp("trash-nest-a");
        touch(&a, "sub/d.txt", b"D");
        let ra = trash_json(&a, &rels(&["sub", "sub/d.txt"]));
        assert_eq!(ra["ok"], true, "父在前:连带走的不算失败 {:?}", ra);
        assert_eq!(ra["moved"], 2, "{:?}", ra);
        assert_eq!(ra["failed"].as_array().unwrap().len(), 0);
        assert_eq!(names(&a), Vec::<String>::new(), "父在前这批确实把项目清空了");

        let b = tmp("trash-nest-b");
        touch(&b, "sub/d.txt", b"D");
        let rb = trash_json(&b, &rels(&["sub/d.txt", "sub"]));
        assert_eq!(rb["ok"], true, "子在前:与父在前一致(结果不依赖输入顺序) {:?}", rb);
        assert_eq!(rb["moved"], 2, "{:?}", rb);
        assert_eq!(rb["failed"], ra["failed"], "两个顺序的 failed 逐字一致");
        assert_eq!(names(&b), names(&a), "两个顺序的磁盘结果一致");
        fs::remove_dir_all(&a).ok();
        fs::remove_dir_all(&b).ok();
    }

    /// D-5 删除侧的包含闸:这一条是「实现真用了 resolve_inside」的唯一证据。
    #[test]
    fn trash_refuses_link_pointing_outside_the_tree() {
        let root = tmp("trash-link");
        touch(&root, "b.txt", b"B");
        let outside = outside_dir("trash");
        touch(&outside, "victim.txt", b"MUST-SURVIVE\n");
        match make_dir_link(&outside, &root.join("link-out-dir")) {
            Err(why) => skip_assert("删除穿过项目内目录链接 → 非法路径", &why),
            Ok(()) => {
                let t = trash_json(&root, &rels(&["link-out-dir"]));
                assert_eq!(t["ok"], false, "{:?}", t);
                assert_eq!(t["moved"], 0, "被闸拒绝的项不进 moved");
                let failed = t["failed"].as_array().unwrap();
                assert_eq!(failed.len(), 1, "{:?}", failed);
                assert_eq!(failed[0]["rel"], "link-out-dir");
                assert_eq!(failed[0]["error"], "非法路径");
                assert!(outside.join("victim.txt").exists(), "被挡住的删除没有波及项目外的文件");
                assert_eq!(fs::read_to_string(outside.join("victim.txt")).unwrap(), "MUST-SURVIVE\n");
                assert!(root.join("link-out-dir").exists(), "链接本身也还在(拒绝即不动盘)");
                assert!(root.join("b.txt").exists(), "未点名项零改动");
            }
        }
        let left: Vec<String> = { let mut v = names(&root); v.sort(); v };
        let want: Vec<String> = {
            let mut v = vec!["b.txt".to_string()];
            if root.join("link-out-dir").exists() { v.push("link-out-dir".to_string()); }
            v.sort(); v
        };
        assert_eq!(left, want, "trash 根里只剩预期条目");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    /// 非字符串 / 空 rel 逐项标非法路径(Rust 的 Vec<String> 签名挡掉了非字符串,
    /// 这里钉的是「空串与畸形串不得误删任何东西、不得 panic」)。
    #[test]
    fn trash_tolerates_degenerate_rels_without_touching_disk() {
        let root = tmp("trash-degenerate");
        touch(&root, "a", b"SINGLE-CHAR");
        touch(&root, "a.txt", b"A2");
        let r = trash_json(&root, &rels(&["", "\\", "..", "/", "./.."]));
        assert_eq!(r["ok"], false);
        assert_eq!(r["moved"], 0, "{:?}", r);
        let failed = r["failed"].as_array().unwrap();
        assert_eq!(failed.len(), 5, "每项一条失败: {:?}", failed);
        assert!(failed.iter().all(|f| f["error"] == "非法路径"), "{:?}", failed);
        assert!(root.join("a").exists(), "单字符文件 'a' 不得被误删");
        assert!(root.join("a.txt").exists());
        fs::remove_dir_all(&root).ok();
    }

    // ---------- stamp_sec / 民政历换算(与 fsutil.stampSec 同形)----------
    #[test]
    fn stamp_from_secs_matches_known_utc_instants() {
        // 基准值由 node 的 Date#getUTC* 逐一核对(`node -e 'd=new Date(s*1e3)'`),
        // 覆盖:纪元零点、闰 400(2000)、闰 4(2024)、平年 2 月翻页(2026)、年末最后一秒。
        assert_eq!(stamp_from_secs(0), "19700101_0000_00");
        assert_eq!(stamp_from_secs(86_399), "19700101_2359_59");
        assert_eq!(stamp_from_secs(86_400), "19700102_0000_00");
        assert_eq!(stamp_from_secs(951_782_400), "20000229_0000_00", "能被 400 整除的闰年 2 月 29 日");
        assert_eq!(stamp_from_secs(1_709_164_800), "20240229_0000_00", "普通闰年的 2 月 29 日");
        assert_eq!(stamp_from_secs(1_709_164_800 + 86_400), "20240301_0000_00", "闰日之后是 3 月 1 日");
        assert_eq!(stamp_from_secs(1_700_000_000), "20231114_2213_20");
        assert_eq!(stamp_from_secs(1_234_567_890), "20090213_2331_30");
        assert_eq!(stamp_from_secs(1_735_689_599), "20241231_2359_59", "年末最后一秒");
        assert_eq!(stamp_from_secs(1_893_456_000), "20300101_0000_00", "2030-01-01 零点");
        // 2026 不是闰年:2 月 28 日的下一天必须是 3 月 1 日(月长表里 2 月 = 28 的证据)
        assert_eq!(stamp_from_secs(1_772_236_800), "20260228_0000_00");
        assert_eq!(stamp_from_secs(1_772_323_200), "20260301_0000_00", "平年 2 月只有 28 天");
    }

    #[test]
    fn stamp_sec_has_the_js_shape() {
        let s = stamp_sec();
        assert_eq!(s.len(), 16, "YYYYMMDD_HHmm_ss 共 16 个字符: {}", s);
        let b = s.as_bytes();
        assert!(b.iter().enumerate().all(|(i, c)| if i == 8 || i == 13 { *c == b'_' } else { c.is_ascii_digit() }),
            "除两个下划线外全是数字: {}", s);
        // 时间字段本身要合法(月 1-12、日 1-31、时分秒在范围内)
        let month: u8 = s[4..6].parse().unwrap();
        let day: u8 = s[6..8].parse().unwrap();
        let hour: u8 = s[9..11].parse().unwrap();
        let min: u8 = s[11..13].parse().unwrap();
        let sec: u8 = s[14..16].parse().unwrap();
        assert!((1..=12).contains(&month) && (1..=31).contains(&day), "日期字段合理: {}", s);
        assert!(hour < 24 && min < 60 && sec < 60, "时间字段合理: {}", s);
    }

    // ---------- D-6:opts 解析收口进 ScanOpts::from_json ----------
    #[test]
    fn scan_opts_from_json_normalizes_every_key() {
        let d = DEFAULT_MAX_ENTRIES;
        // maxEntries:0 / 负数 / 非数字 / 缺省一律退默认(原 main.rs 的 max_entries_of 断言整体搬来)
        assert_eq!(ScanOpts::from_json(&serde_json::json!({ "maxEntries": 0 })).max_entries, d, "0 必须退默认而不是当上限用");
        assert_eq!(ScanOpts::from_json(&serde_json::json!({ "maxEntries": -1 })).max_entries, d, "负数退默认");
        assert_eq!(ScanOpts::from_json(&serde_json::json!({ "maxEntries": "30" })).max_entries, d, "非数字退默认");
        assert_eq!(ScanOpts::from_json(&serde_json::json!({ "maxEntries": null })).max_entries, d, "null 退默认");
        assert_eq!(ScanOpts::from_json(&serde_json::json!({})).max_entries, d, "缺省退默认");
        assert_eq!(ScanOpts::from_json(&serde_json::json!({ "maxEntries": 25 })).max_entries, 25, "正整数原样生效");
        // 其余三键
        let o = ScanOpts::from_json(&serde_json::json!({
            "includeCache": true, "exts": [".PNG", "gd", 7, null], "skipDirs": ["build", "DIST"]
        }));
        assert!(o.include_cache, "includeCache:true 生效");
        assert_eq!(o.exts, vec![".PNG".to_string(), "gd".to_string()], "非字符串项被丢掉");
        assert_eq!(o.skip_dirs, vec!["build".to_string(), "DIST".to_string()]);
        let f = ScanOpts::from_json(&serde_json::json!({ "includeCache": false }));
        assert!(!f.include_cache, "缺省与显式 false 都是默认跳过缓存");
        assert!(f.exts.is_empty() && f.skip_dirs.is_empty(), "非数组的 exts / skipDirs 退空表");
        // opts 根本不是对象(Tauri 传串了)也不能 panic
        assert_eq!(ScanOpts::from_json(&Value::Null).max_entries, d, "null opts 退全默认");
        assert_eq!(ScanOpts::from_json(&serde_json::json!("abc")).exts.len(), 0, "字符串 opts 退全默认");
        // 归一后的默认值直接喂 collect_tree 也不会掉进 max_entries:0 的洞
        let root = tmp("opts");
        for i in 0..4 { touch(&root, &format!("f{}.txt", i), b"x"); }
        let (files, tr) = collect_tree(&root, &ScanOpts::from_json(&serde_json::json!({ "maxEntries": 2 })));
        assert_eq!(files.len(), 2);
        assert!(tr);
        fs::remove_dir_all(&root).ok();
    }
}
