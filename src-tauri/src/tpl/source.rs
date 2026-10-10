//! 代下载源码（P0e-3）：官方 `godot-<tag>.tar.xz` + `.sha256` 旁证逐字节比对 + `tar.exe` 解包。
//!
//! 真源 = `src-ztools/preload/lib/tplsource.js`（220 行）。完整性是生命线：
//! **旁证缺失、形态不认、sha 不匹配三种都拒解**；不匹配时删掉已下整包 ——
//! 断点续传只续「网络中断」，不续「坏包」，否则每次重试都在同一堆坏字节上续。
//!
//! 与插件版的两处已知不等价（都记在 `docs/tplrust-plan.md` §D）：
//!   · `.part` 续传文件名沿用 Rust 侧既有的 `with_extension("part")`（`godot-4.7.tar` → `.part`），
//!     与 JS 的 `${xz}.part` 不同名 —— 两端各续各的，不会互相踩；
//!   · 下载**中途**取消：`http::download` 没有取消把手（桌面版的引擎下载历来也没有），
//!     所以取消在「下载期」只置标记、在本步结束时收口；解包期能真杀 tar。

use crate::http;
use crate::tpl::build::TAR_EXE;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// 对应 tplsource.js:17 RELEASE_BASE
pub const RELEASE_BASE: &str = "https://github.com/godotengine/godot/releases/download";
/// 对应 tplsource.js:19 MIN_FREE_BYTES（解包后源码树约 1 GB 量级，留余量）
pub const MIN_FREE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// 在途锁：全局至多一条代下载（同目录重入是它的子集）
#[derive(Default)]
pub struct SourceJob {
    pub canceled: AtomicBool,
    pub tar_pid: Mutex<Option<u32>>,
}

pub fn active_job() -> &'static Mutex<Option<Arc<SourceJob>>> {
    static A: OnceLock<Mutex<Option<Arc<SourceJob>>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(None))
}

/// 对应 tplsource.js:28 sourceUrls
pub fn source_urls(tag: &str) -> (String, String) {
    let asset = format!("godot-{tag}.tar.xz");
    (format!("{RELEASE_BASE}/{tag}/{asset}"), format!("{RELEASE_BASE}/{tag}/{asset}.sha256"))
}

/// 对应 tplsource.js:73 的 tag 形态闸（`^[A-Za-z0-9][A-Za-z0-9._-]*$`）——
/// tag 会进 URL 与文件名，不白名单就是注入门
pub fn tag_ok(tag: &str) -> bool {
    let mut it = tag.chars();
    match it.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    it.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// 对应 tplsource.js:116-121：旁证首段空白分隔 token 转小写，必须是 64 位十六进制
pub fn sidecar_expect(text: &str) -> String {
    let t = text.trim();
    let first = t.split_whitespace().next().unwrap_or("");
    let lower = first.to_lowercase();
    if lower.len() == 64 && lower.bytes().all(|b| b.is_ascii_hexdigit()) {
        lower
    } else {
        String::new()
    }
}

/// 对应 tplsource.js:83-85 的三个落点
pub struct SourcePaths {
    pub xz: PathBuf,
    pub top: PathBuf,
}

pub fn source_paths(dest_dir: &Path, tag: &str) -> SourcePaths {
    SourcePaths {
        xz: dest_dir.join(format!("godot-{tag}.tar.xz")),
        top: dest_dir.join(format!("godot-{tag}")),
    }
}

/// 对应 tplsource.js:34 hashFile —— 1 MiB 分块，只用已声明/已装的件（sha2 crate 已在依赖里）
pub fn hash_file(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| format!("读下载物失败:{e}"))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("读下载物失败:{e}"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex_lower(&h.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn emit_progress(app: &AppHandle, stage: &str, received: Option<u64>, total: Option<u64>) {
    let _ = app.emit("tplsource://progress", json!({
        "stage": stage,
        "received": received.unwrap_or(0),
        "total": total
    }));
}

/// 对应 tplsource.js:44 rmTree
fn rm_tree(p: &Path) {
    let _ = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
}

/// 前置六闸，**顺序与文案都照 tplsource.js:71-89**（顺序有意义：在途锁排在目录检查之前，
/// 抽成纯函数是为了让两端能把每一闸的文案与先后一起对照，不靠人抄写）。
/// 三个 `*_exists` 由调用方喂（本机状态不进纯函数，才测得动）。
pub fn precheck(tag: &str, dest_s: &str, dest_exists: bool, tar_exists: bool, active: bool, top_exists: bool, top_display: &str) -> Option<Value> {
    if !tag_ok(tag) {
        return Some(json!({ "ok": false, "error": format!("tag 形态不合法(只认字母数字与 . _ -):{tag}") }));
    }
    if dest_s.is_empty() {
        return Some(json!({ "ok": false, "error": "未指定下载父目录" }));
    }
    if !dest_exists {
        return Some(json!({ "ok": false, "error": format!("下载父目录不存在:{dest_s}") }));
    }
    if !tar_exists {
        return Some(json!({ "ok": false, "error": "未找到 System32\\tar.exe,无法解包源码包。请手动准备源码目录。" }));
    }
    if active {
        return Some(json!({ "ok": false, "error": "已有代下载在途,先取消或等它完成,再发起新的。" }));
    }
    if top_exists {
        return Some(json!({ "ok": false, "error": format!("目标目录已存在:{top_display}。请先移除它或换一个父目录(不覆盖既有目录)。") }));
    }
    None
}

/// 对应 tplsource.js:70 downloadTemplateSourceWith —— 全流程，每步都带「下一步」
pub async fn download_template_source(app: AppHandle, params: Value) -> Value {
    let tag = params.get("tag").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let dest_s = params.get("destDir").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let dest = PathBuf::from(&dest_s);
    let paths = source_paths(&dest, &tag);
    let busy = active_job().lock().map(|a| a.is_some()).unwrap_or(false);
    if let Some(e) = precheck(
        &tag, &dest_s, dest.exists(), Path::new(TAR_EXE).exists(), busy, paths.top.exists(),
        &paths.top.to_string_lossy(),
    ) {
        return e;
    }
    let job = Arc::new(SourceJob::default());
    {
        let mut a = match active_job().lock() { Ok(g) => g, Err(_) => return json!({ "ok": false, "error": "在途锁状态异常,请重开应用后重试" }) };
        if a.is_some() {
            return json!({ "ok": false, "error": "已有代下载在途,先取消或等它完成,再发起新的。" });
        }
        *a = Some(job.clone());
    }
    let out = run(app.clone(), job.clone(), tag, dest).await;
    *active_job().lock().unwrap() = None;
    out
}

async fn run(app: AppHandle, job: Arc<SourceJob>, tag: String, dest: PathBuf) -> Value {
    let paths = source_paths(&dest, &tag);
    let (asset, sidecar_url) = source_urls(&tag);
    let part = paths.xz.with_extension("part");

    if !paths.xz.exists() {
        emit_progress(&app, "downloading", Some(0), None);
        let a2 = app.clone();
        let j2 = job.clone();
        let dl = http::download(
            http::DownloadOptions { url: asset, dest: paths.xz.clone(), proxy: None, sha256: None },
            move |received, total| {
                if j2.canceled.load(Ordering::SeqCst) {
                    return; // 下载中途没有取消把手，只能在标记置上后由本步结束收口
                }
                emit_progress(&a2, "downloading", Some(received), total);
            },
        )
        .await;
        if let Err(e) = dl {
            if job.canceled.load(Ordering::SeqCst) {
                return json!({ "ok": false, "error": "已取消(已下字节留在 .part,重试可续传)。" });
            }
            return json!({ "ok": false, "error": format!("下载失败:{e}(.part 已保留,重试从断点继续)") });
        }
    }
    if job.canceled.load(Ordering::SeqCst) {
        return json!({ "ok": false, "error": "已取消(已下字节留在 .part,重试可续传)。" });
    }

    // ---------- 旁证 + 逐字节比对 ----------
    emit_progress(&app, "hashing", None, None);
    let client = match http::build_client(None) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": format!("官方 sha256 旁证拉取失败(缺失或网络不通),拒绝盲解。请手动准备源码,或稍后重试。({e})") }),
    };
    let sidecar_text = match client.get(&sidecar_url).send().await.and_then(|r| r.error_for_status()) {
        Ok(r) => match r.text().await {
            Ok(t) => t,
            Err(e) => return json!({ "ok": false, "error": format!("官方 sha256 旁证拉取失败(缺失或网络不通),拒绝盲解。请手动准备源码,或稍后重试。({e})") }),
        },
        Err(e) => return json!({ "ok": false, "error": format!("官方 sha256 旁证拉取失败(缺失或网络不通),拒绝盲解。请手动准备源码,或稍后重试。({e})") }),
    };
    let expect = sidecar_expect(&sidecar_text);
    if expect.is_empty() {
        return json!({ "ok": false, "error": "官方 sha256 旁证形态不认(不是 64 位十六进制),拒绝盲解。" });
    }
    let actual = match hash_file(&paths.xz) {
        Ok(h) => h,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    if actual != expect {
        // 坏包不配续传:整包删掉，重试从零下
        rm_tree(&paths.xz);
        rm_tree(&part);
        return json!({ "ok": false, "error": format!("sha256 与官方旁证不一致(下载物 {}… / 旁证 {}…)，已删除下载物。请重试或手动准备源码。", &actual[..12.min(actual.len())], &expect[..12.min(expect.len())]) });
    }

    // ---------- 解包 ----------
    emit_progress(&app, "extracting", None, None);
    let mut child = match Command::new(TAR_EXE).args(["-xf", &paths.xz.to_string_lossy(), "-C", &dest.to_string_lossy()])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn()
    {
        Ok(c) => c,
        Err(e) => {
            rm_tree(&paths.top);
            return json!({ "ok": false, "error": format!("tar.exe 起不来:{e}") });
        }
    };
    *job.tar_pid.lock().unwrap() = Some(child.id());
    let mut stderr_tail = String::new();
    if let Some(mut se) = child.stderr.take() {
        let mut buf = [0u8; 4096];
        loop {
            match se.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    stderr_tail.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if stderr_tail.len() > 400 {
                        let cut = stderr_tail.len() - 400;
                        let mut at = cut;
                        while !stderr_tail.is_char_boundary(at) {
                            at += 1;
                        }
                        stderr_tail.drain(..at);
                    }
                }
            }
        }
    }
    let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    *job.tar_pid.lock().unwrap() = None;
    if job.canceled.load(Ordering::SeqCst) {
        rm_tree(&paths.top);
        return json!({ "ok": false, "error": "已取消(解包半成品已清理,下载物保留可直接重试)。" });
    }
    if code != 0 {
        rm_tree(&paths.top);
        return json!({ "ok": false, "error": format!("tar 解包失败(退出码 {code}):{}。下载物已保留,可直接重试。", if stderr_tail.is_empty() { "无 stderr 输出".to_string() } else { stderr_tail }) });
    }
    if !paths.top.join("SConstruct").exists() || !paths.top.join("version.py").exists() {
        return json!({ "ok": false, "error": format!("解包结果形态不符({} 缺 SConstruct 或 version.py),不当作源码根。请检查该目录或换父目录。", paths.top.display()) });
    }
    json!({ "ok": true, "srcDir": paths.top.to_string_lossy() })
}

/// 对应 tplsource.js:174 cancelTemplateSourceDownload
pub fn cancel_template_source_download() -> Value {
    let Some(job) = active_job().lock().ok().and_then(|a| a.clone()) else {
        return json!({ "ok": true });
    };
    job.canceled.store(true, Ordering::SeqCst);
    if let Some(pid) = job.tar_pid.lock().unwrap().take() {
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill").args(["/pid", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
        }
    }
    json!({ "ok": true })
}
