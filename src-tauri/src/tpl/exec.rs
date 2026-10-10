//! 工具链检测与 scons 编译执行层（P0e-2 后半）。
//!
//! 真源 = `src-ztools/preload/lib/buildtools.js` 的 `checkTemplateBuildToolsWith`(:169) 与
//! `buildTemplatePackWith`(:348)。判据（bat 正文、scons 行、产物改名、vcvars 挑选）都在
//! `build.rs` 里并有逐字节对照；本文件只做**编排**：跑子进程、管任务、发事件。
//!
//! 两条与插件版对齐的硬规矩：
//!   · **真串行**（§0 第 2 拍，2026-10-11 用户拍板）：一次只跑一个 scons。编译是几十分钟的重活，
//!     两个并发只会互相抢核与磁盘，而插件版压根不给并发 —— 语义不一致就是桌面版多一个坑。
//!     队列语义照 `taskqueue.js:188-199` 的 pump：**没有 catch**，作业内部自己把异常转成
//!     error 终态（否则任务永远停在 building、两份临时文件等不到清理）。
//!   · 任务仍进**同一本 `Versions.book`**（kind=`tplbuild`），快照仍走 `tasks://snapshot`
//!     —— 渲染层与垫片都只认这一条事件，多一个事件名就多一处两端要同步的地方。

use crate::taskqueue::{Status, TaskBook};
use crate::tpl::{build, probe, profile};
use crate::versions::Versions;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// 对应 buildtools.js:40 LOG_TAIL（exporter 同款，只留尾部用于失败诊断）
const LOG_TAIL: usize = 40;
/// 对应 buildtools.js:43 MIN_FREE_BYTES：源码树 ~2GB + 中间物 ~10GB 的保守闸
const MIN_FREE_BYTES: u64 = 20 * 1024 * 1024 * 1024;
/// 对应 buildtools.js:52 STABLE_TAG_RE 的判据（Rust 无 regex 依赖时手写太脆，这里用 regex crate）
const STABLE_TAG_HINT: &str = "自编译模板只支持 stable 形态的引擎版本(如 4.7.2-stable / 4.7-stable)";

fn book() -> &'static Mutex<TaskBook> {
    static B: OnceLock<Mutex<TaskBook>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(TaskBook::new()))
}

fn queue() -> &'static Mutex<VecDeque<u64>> {
    static Q: OnceLock<Mutex<VecDeque<u64>>> = OnceLock::new();
    Q.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn running() -> &'static AtomicBool {
    static R: AtomicBool = AtomicBool::new(false);
    &R
}

fn children() -> &'static Mutex<HashMap<u64, u32>> {
    static C: OnceLock<Mutex<HashMap<u64, u32>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 对应 buildtools.js:75 checkCache —— 检测步写、构建步读；没检测过就拒绝构建
#[derive(Default, Clone)]
pub struct CheckCache {
    pub vcvars_path: String,
    pub python_path: String,
    pub python_cmd: String,
    pub scons_via: String,
}

pub fn check_cache() -> &'static Mutex<CheckCache> {
    static C: OnceLock<Mutex<CheckCache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(CheckCache::default()))
}

/// 快照：本域任务。契约里 tplbuild 的在跑态叫 `building`（`src/types/godot.ts:652`，
/// 向导 `TemplateBuildWizard.vue:403` 按它判步），而共用的 `TaskBook` 只会给 `running` ——
/// 不映射的话桌面版向导会永远停在「排队」。
pub fn snapshot() -> Vec<Value> {
    let mut v = book().lock().map(|b| b.snapshot()).unwrap_or_default();
    for t in v.iter_mut() {
        if t["status"] == json!("running") {
            if let Some(o) = t.as_object_mut() {
                o.insert("status".into(), json!("building"));
            }
        }
    }
    v
}

fn set_task(app: &AppHandle, id: u64, st: Status, err: Option<String>, patch: Value) {
    if let Ok(mut b) = book().lock() {
        if let Some(t) = b.get_mut(id) {
            t.status = st;
            t.error = err;
            if let (Some(o), Some(p)) = (t.payload.as_object_mut(), patch.as_object()) {
                for (k, v) in p {
                    o.insert(k.clone(), v.clone());
                }
            }
        }
    }
    emit_snapshot(app);
}

/// 统一快照出口：`Versions.book` + 本域任务，按 id 数值倒序（最新在前）
pub fn emit_snapshot(app: &AppHandle) {
    let mut snap: Vec<Value> = Vec::new();
    if let Some(v) = app.try_state::<Versions>() {
        snap.extend(v.book.lock().map(|b| b.snapshot()).unwrap_or_default());
    }
    snap.extend(snapshot());
    snap.sort_by(|a, b| {
        let id = |v: &Value| v["id"].as_str().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        id(b).cmp(&id(a))
    });
    let _ = app.emit("tasks://snapshot", snap);
}

/// 跑一条命令拿 stdout（失败一律回 None，与 JS 的 try/catch 同形；参数全是本文件写死的，
/// 不吃渲染层传来的任何字符串 —— buildtools.js:22 那条红线）
fn stdout_of(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).stdout(Stdio::piped()).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// 对应 buildtools.js:169 checkTemplateBuildToolsWith
pub fn check_template_build_tools() -> Value {
    let cpu = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0) as u64;
    let mut out = json!({
        "ok": false, "pythonVersion": "", "pythonPath": "", "sconsVersion": "", "sconsPath": "",
        "vcvarsPath": "", "tarPath": "", "d3d12SdkInstalled": false, "accesskitSdkInstalled": false,
        "cpuCount": cpu, "problems": []
    });
    let o = out.as_object_mut().unwrap();
    if std::env::consts::OS != "windows" {
        o.insert("problems".into(), json!(["自编译模板构建目前只在 Windows 宿主提供(需要 MSVC 与 vcvars 环境)。"]));
        return out;
    }
    let exists = |p: &str| Path::new(p).exists();

    // python：先 `python --version`，失败再试 py 启动器
    let mut python_cmd = String::new();
    for cmd in ["python", "py"] {
        let args: &[&str] = if cmd == "py" { &["-3", "--version"] } else { &["--version"] };
        // `python --version` 在 Python 2 与部分发行版里把版本写到 stderr，JS 用 execSync 走 shell
        // 会合并；这里两路都读，避免把可用的解释器判成没有
        let raw = run_capture(cmd, args);
        if raw.iter().any(|s| regex_lite_python(s)) {
            o.insert("pythonVersion".into(), json!(python_version_of(&raw)));
            python_cmd = if cmd == "py" { "py -3".to_string() } else { "python".to_string() };
            break;
        }
    }
    if python_cmd.is_empty() {
        push_problem(o, "没有可用的 Python 3。请安装 Python 3.8+ 并勾选「加入 PATH」后重试。");
    }
    // 是哪支 python.exe 只有解释器自己答得上（PATH 别名 / py 启动器 / 商店别名各指一处）
    let mut python_path = String::new();
    if !python_cmd.is_empty() {
        let (prog, tail): (&str, &[&str]) = if python_cmd.starts_with("py") { ("py", &["-3", "-c", "import sys;print(sys.executable)"]) } else { ("python", &["-c", "import sys;print(sys.executable)"]) };
        if let Some(s) = stdout_of(prog, tail) {
            python_path = s.trim().to_string();
            o.insert("pythonPath".into(), json!(python_path));
        }
    }
    // SCons：先认 PATH 上的 scons（编译 bat 跑的就是它），没有再回落模块通道 —— 两端同一条口径
    let mut scons_via = String::new();
    if let Some(s) = stdout_of("scons", &["--version"]) {
        let v = build::parse_scons_version(&s);
        if !v.is_empty() {
            o.insert("sconsVersion".into(), json!(v));
            scons_via = "path".to_string();
        }
    }
    if scons_via.is_empty() && !python_cmd.is_empty() {
        let args: Vec<&str> = if python_cmd.starts_with("py") { vec!["-3", "-m", "SCons", "--version"] } else { vec!["-m", "SCons", "--version"] };
        if let Some(s) = stdout_of(if python_cmd.starts_with("py") { "py" } else { "python" }, &args) {
            let v = build::parse_scons_version(&s);
            if !v.is_empty() {
                o.insert("sconsVersion".into(), json!(v));
                scons_via = "python".to_string();
            }
        }
    }
    if scons_via == "path" {
        if let Some(s) = stdout_of("where", &["scons"]) {
            let first = s.split('\n').map(|l| l.trim()).find(|l| !l.is_empty()).unwrap_or("");
            o.insert("sconsPath".into(), json!(first));
        }
    }
    if scons_via.is_empty() && !python_cmd.is_empty() {
        let managed = !python_path.is_empty()
            && exists(&win32_join(&Path::new(&python_path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(), "Lib\\EXTERNALLY-MANAGED"));
        push_problem(o, if managed {
            "没有 SCons。上面的 Python 受 PEP 668 外部管理(uv 等),裸 pip install 会被拒:请改用 python -m pip install --break-system-packages scons,或装进任一已在 PATH 的解释器 —— 检测与编译都从 PATH 认 scons。"
        } else {
            "没有 SCons。请用上面的 Python 执行:python -m pip install scons,或直接装进任一已在 PATH 的解释器 —— 检测与编译都从 PATH 认 scons。"
        });
    }
    // vcvars64.bat：vswhere 优先（能找到非默认盘的 VS），fallback 扫常见安装位
    let vs_out = stdout_of(build::VSWHERE, &[
        "-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath",
    ]).unwrap_or_default();
    let fb = build::vcvars_fallback_dirs();
    let fbrefs: Vec<String> = fb;
    let vcvars = build::pick_vcvars(&vs_out, &fbrefs, &exists);
    o.insert("vcvarsPath".into(), json!(vcvars));
    if vcvars.is_empty() {
        push_problem(o, "没有找到 MSVC 工具链。请安装 Visual Studio(Community 即可)并在 Installer 里勾选「使用 C++ 的桌面开发」。");
    }
    // 第四探头：缺只禁代下载按钮，不进 problems、不拖 ok
    o.insert("tarPath".into(), json!(if exists(build::TAR_EXE) { build::TAR_EXE } else { "" }));
    // SDK 落点固定 %LOCALAPPDATA%\Godot\build_deps（detect.py:207-209）；探不到按未装 —— 宁可软拦多喊一次
    let base = std::env::var("LOCALAPPDATA").unwrap_or_default();
    if !base.is_empty() {
        let deps = Path::new(&base).join("Godot").join("build_deps");
        o.insert("d3d12SdkInstalled".into(), json!(deps.join("mesa").exists() || deps.join("mesa-x86_64-msvc").exists()));
        o.insert("accesskitSdkInstalled".into(), json!(deps.join("accesskit").exists()));
    }
    o.insert("ok".into(), json!(o["problems"].as_array().map(|p| p.is_empty()).unwrap_or(false)));
    if let Ok(mut c) = check_cache().lock() {
        c.vcvars_path = vcvars;
        c.python_path = python_path;
        c.python_cmd = python_cmd;
        c.scons_via = scons_via;
    }
    out
}

fn push_problem(o: &mut serde_json::Map<String, Value>, text: &str) {
    if let Some(arr) = o.get_mut("problems").and_then(|p| p.as_array_mut()) {
        arr.push(json!(text));
    }
}

/// `python --version` 的两路输出里找 `Python 3.x`（真源只判 stdout，且要求 `^Python \d`）
fn regex_lite_python(s: &str) -> bool {
    s.lines().any(|l| {
        let l = l.trim_start();
        l.starts_with("Python ") && l.as_bytes().get(7).map(|c| c.is_ascii_digit()).unwrap_or(false)
    })
}

fn python_version_of(lines: &[String]) -> String {
    for s in lines {
        for l in s.lines() {
            let l = l.trim();
            if l.starts_with("Python ") {
                let v = &l["Python ".len()..];
                if v.as_bytes().first().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                    return v.trim().to_string();
                }
            }
        }
    }
    String::new()
}

fn run_capture(prog: &str, args: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    if let Ok(out) = Command::new(prog).args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).output() {
        v.push(String::from_utf8_lossy(&out.stdout).to_string());
        v.push(String::from_utf8_lossy(&out.stderr).to_string());
    }
    v
}

fn win32_join(dir: &str, tail: &str) -> String {
    let d = dir.trim_end_matches('\\');
    if d.is_empty() { format!("\\{tail}") } else { format!("{d}\\{tail}") }
}

/// 对应 buildtools.js:336 buildTemplatePack 的入队闸（全部同步拒绝，返回 ok:false）
pub fn build_template_pack(app: &AppHandle, params: &Value) -> Value {
    let src_dir = params.get("srcDir").and_then(|v| v.as_str()).unwrap_or("");
    let tag = params.get("tag").and_then(|v| v.as_str()).unwrap_or("");
    let Some(features) = params.get("features").filter(|f| f.is_object()) else {
        return json!({ "ok": false, "error": "缺少功能勾选结果" });
    };
    let mode = params.get("mode").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if src_dir.is_empty() {
        return json!({ "ok": false, "error": "请先选择 Godot 源码目录" });
    }
    if tag.is_empty() {
        return json!({ "ok": false, "error": "缺少引擎版本信息" });
    }
    // 构建必须在检测之后（向导第一步就是它），这道闸放最前 —— 不在这里重新探测
    let cache = check_cache().lock().map(|c| c.clone()).unwrap_or_default();
    if cache.vcvars_path.is_empty() {
        return json!({ "ok": false, "error": "请先完成工具链检测(向导第一步)" });
    }
    let target = probe::version_string_from_tag(tag);
    if !is_stable_tag(&target) {
        return json!({ "ok": false, "error": format!("{STABLE_TAG_HINT},目标引擎 = {}。预发布版(beta / rc)与带 v 前缀的 tag 不走这条路 —— 请改用对应的正式版引擎与同版本源码。", if target.is_empty() { "读不出".to_string() } else { target.clone() }) });
    }
    let sync = probe_source_sync(Path::new(src_dir));
    if sync["ok"] != json!(true) {
        return json!({ "ok": false, "error": sync["error"].clone() });
    }
    let source_version = sync["sourceVersion"].as_str().unwrap_or("").to_string();
    if source_version != target {
        return json!({ "ok": false, "error": format!("源码版本不符：version.py = {}，目标引擎 = {target}。请先切到该版本的源码，或改用与源码同版本的引擎。", if source_version.is_empty() { "读不出".to_string() } else { source_version.clone() }) });
    }
    let bin_dir = Path::new(src_dir).join("bin");
    let _ = fs::create_dir_all(&bin_dir);
    let jobs = {
        let given = params.get("jobs").and_then(|v| v.as_u64()).unwrap_or(0);
        let n = if given > 0 { given } else { std::thread::available_parallelism().map(|n| n.get() as u64).unwrap_or(1) };
        n.clamp(1, 64)
    };
    // 盘闸：Rust 侧没有 statfs 的先例（§0 第 5 拍）—— 取不到就跳过这一道，与 JS 的 catch 分支同形，
    // 差别记在 docs/tplrust-plan.md §D#3：桌面版目前**不会**因空间不足提前拒绝。
    if let Some(free) = disk_free_bytes(Path::new(src_dir)) {
        if free < MIN_FREE_BYTES {
            return json!({ "ok": false, "error": "源码所在盘剩余空间不足 20 GB,编译中间产物放不下,请先清理后重试" });
        }
    }
    let id = {
        let mut b = book().lock().unwrap();
        b.push("tplbuild", json!({
            "tag": tag, "srcDir": src_dir, "jobs": jobs, "status": "queued",
            "log": "", "writtenFlags": [], "features": features, "mode": mode
        }))
    };
    if let Ok(mut q) = queue().lock() {
        q.push_back(id);
    }
    pump(app);
    json!({ "ok": true, "taskId": id.to_string() })
}

/// 对应 buildtools.js:296 probeSourceSync —— 只读 version.py，同步返回（入队路径必须同步拒绝）
pub fn probe_source_sync(src_dir: &Path) -> Value {
    if src_dir.as_os_str().is_empty() || !src_dir.join("SConstruct").exists() {
        return json!({ "ok": false, "error": "所选目录不是 Godot 源码根(缺 SConstruct)", "sourceVersion": "" });
    }
    let vpy = fs::read_to_string(src_dir.join("version.py")).unwrap_or_default();
    json!({ "ok": true, "error": "", "sourceVersion": probe::parse_version_py(&vpy) })
}

fn is_stable_tag(s: &str) -> bool {
    // 真源 /^\d+\.\d+(\.\d+)?-stable$/
    let Some(rest) = s.strip_suffix("-stable") else { return false };
    let mut parts = rest.split('.');
    let (Some(major), Some(minor)) = (parts.next(), parts.next()) else { return false };
    let numeric = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    match parts.next() {
        None => numeric(major) && numeric(minor),
        Some(patch) => parts.next().is_none() && numeric(major) && numeric(minor) && numeric(patch),
    }
}

/// 串行泵：同一时刻至多一个作业在跑；作业内部自己收口异常（真源的 pump 没有 catch）
pub fn pump(app: &AppHandle) {
    if running().swap(true, Ordering::SeqCst) {
        return;
    }
    let next = queue().lock().ok().and_then(|mut q| q.pop_front());
    let Some(id) = next else {
        running().store(false, Ordering::SeqCst);
        return;
    };
    let a = app.clone();
    std::thread::spawn(move || {
        run_job(id, &a);
        running().store(false, Ordering::SeqCst);
        pump(&a);
    });
}

fn run_job(id: u64, app: &AppHandle) {
    let got = book().lock().ok().and_then(|mut b| b.get_mut(id).map(|t| (t.payload.clone(), t.status.clone())));
    let (payload, st) = match got {
        Some(x) => x,
        None => return,
    };
    if st == Status::Canceled {
        return; // 排队期间就被取消了
    }
    let (src_dir, tag, jobs, features, mode) = {
        let p = &payload;
        (
            p["srcDir"].as_str().unwrap_or("").to_string(),
            p["tag"].as_str().unwrap_or("").to_string(),
            p["jobs"].as_u64().unwrap_or(1) as u32,
            p["features"].clone(),
            p["mode"].as_str().unwrap_or("").to_string(),
        )
    };
    set_task(app, id, Status::Running, None, json!({ "status": "building" }));
    let cache = check_cache().lock().map(|c| c.clone()).unwrap_or_default();
    let base = build::bat_base_dir();
    let bat_path = base.join(format!("ztools-godot-build-{id}.bat"));
    let profile_path = base.join(format!("ztools-godot-profile-{id}.json"));
    let cleanup = || {
        let _ = fs::remove_file(&bat_path);
        let _ = fs::remove_file(&profile_path);
    };
    // 探测这份源码：探不到就停 —— 未声明的 scons 变量是静默失效的
    let pr = probe::probe_source(Path::new(&src_dir), None);
    if pr["ok"] != json!(true) {
        set_task(app, id, Status::Error, Some(pr["error"].as_str().unwrap_or("").to_string()), json!({}));
        return;
    }
    let options = pr.get("options").cloned().unwrap_or(json!({}));
    let prof = profile::build_profile(&features, &options, &mode);
    if let Err(e) = fs::write(&profile_path, profile::profile_text(&prof.json)) {
        cleanup();
        set_task(app, id, Status::Error, Some(format!("写构建脚本失败: {e}")), json!({}));
        return;
    }
    let bat = build::bat_text(&cache.scons_via, &prof.command_extras, jobs);
    if let Err(e) = fs::write(&bat_path, bat) {
        cleanup();
        set_task(app, id, Status::Error, Some(format!("写构建脚本失败: {e}")), json!({}));
        return;
    }
    set_task(app, id, Status::Running, None, json!({ "writtenFlags": prof.written, "profilePath": profile_path.to_string_lossy() }));

    let interpreter = if cache.python_path.is_empty() { cache.python_cmd.clone() } else { cache.python_path.clone() };
    let mut child = match Command::new("cmd.exe")
        .args(["/d", "/c", &bat_path.to_string_lossy(), &src_dir, &cache.vcvars_path, &profile_path.to_string_lossy(), &interpreter])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            cleanup();
            set_task(app, id, Status::Error, Some(format!("启动编译失败: {e}")), json!({}));
            return;
        }
    };
    if let Ok(mut m) = children().lock() {
        m.insert(id, child.id());
    }
    // 两条流进同一个环形尾（真源 onChunk 同时挂 stdout/stderr）
    let tail: std::sync::Arc<Mutex<Vec<String>>> = Default::default();
    let mut readers: Vec<Box<dyn Read + Send>> = Vec::new();
    if let Some(o) = child.stdout.take() { readers.push(Box::new(o)); }
    if let Some(e) = child.stderr.take() { readers.push(Box::new(e)); }
    let mut handles = Vec::new();
    for mut r in readers {
        let t = tail.clone();
        let a = app.clone();
        handles.push(std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match r.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let keep = {
                            let mut g = t.lock().unwrap();
                            for line in String::from_utf8_lossy(&buf[..n]).lines() {
                                if line.trim().is_empty() {
                                    continue;
                                }
                                g.push(line.to_string());
                                if g.len() > LOG_TAIL {
                                    g.remove(0);
                                }
                            }
                            g.clone()
                        };
                        if let Ok(mut b) = book().lock() {
                            if let Some(tk) = b.get_mut(id) {
                                if let Some(o) = tk.payload.as_object_mut() {
                                    o.insert("log".into(), json!(keep.join("\n")));
                                }
                            }
                        }
                        emit_snapshot(&a);
                    }
                }
            }
        }));
    }
    let status = child.wait();
    for h in handles {
        let _ = h.join();
    }
    if let Ok(mut m) = children().lock() {
        m.remove(&id);
    }
    let canceled = book().lock().ok().and_then(|mut b| b.get_mut(id).map(|t| t.cancel_requested)).unwrap_or(false);
    if canceled {
        cleanup();
        set_task(app, id, Status::Canceled, None, json!({}));
        return;
    }
    let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    if code != 0 {
        let detail = tail.lock().map(|g| g.join("\n")).unwrap_or_default();
        cleanup();
        set_task(app, id, Status::Error, Some(format!("编译失败(退出码 {code})—— 常见原因与下一步见向导的失败说明")), json!({ "errorDetail": detail }));
        return;
    }
    let stage = match make_stage_dir() {
        Ok(d) => d,
        Err(e) => {
            cleanup();
            set_task(app, id, Status::Error, Some(e), json!({}));
            return;
        }
    };
    let n = stage_bin(&Path::new(&src_dir).join("bin"), &stage);
    if n == 0 {
        let _ = fs::remove_dir_all(&stage);
        cleanup();
        set_task(app, id, Status::Error, Some("bin/ 里没有模板产物(编译配置可能不对,应含 godot.windows.template_release.*)".to_string()), json!({}));
        return;
    }
    set_task(app, id, Status::Done, None, json!({
        "stageDir": stage.join("templates").to_string_lossy(),
        "versionDir": crate::templates::version_dir_for_tag(&tag),
        "files": n
    }));
    cleanup();
}

/// 对应 buildtools.js:503 mkdtempSync(os.tmpdir()/ztools-godot-stage-)
fn make_stage_dir() -> Result<PathBuf, String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("ztools-godot-stage-{}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0), n));
    fs::create_dir_all(&dir).map_err(|e| format!("整理产物失败: {e}"))?;
    Ok(dir)
}

/// 对应 buildtools.js:276 stageBin —— bin 下的模板产物改名拷进 stage/templates
pub fn stage_bin(bin_dir: &Path, stage_dir: &Path) -> usize {
    let dest = stage_dir.join("templates");
    let _ = fs::create_dir_all(&dest);
    let mut n = 0;
    let rd = match fs::read_dir(bin_dir) {
        Ok(rd) => rd,
        Err(_) => return 0,
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(mapped) = build::map_template_file_name(&name) else { continue };
        if fs::copy(entry.path(), dest.join(mapped)).is_ok() {
            n += 1;
        }
    }
    n
}

/// 对应 buildtools.js:528 cancelTemplateBuildTask —— 排队中直接取消；构建中 kill + taskkill /T 杀整棵树
pub fn cancel_template_build_task(app: &AppHandle, id: u64) {
    let terminal = book().lock().ok().and_then(|mut b| b.get_mut(id).map(|t| t.status.is_terminal())).unwrap_or(true);
    if terminal {
        return;
    }
    if let Some(pid) = children().lock().ok().and_then(|m| m.get(&id).copied()) {
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill").args(["/pid", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
        }
    }
    if let Ok(mut b) = book().lock() {
        b.cancel(id);
    }
    set_task(app, id, Status::Canceled, None, json!({}));
}

pub fn dismiss_template_build_task(app: &AppHandle, id: u64) {
    if let Ok(mut b) = book().lock() {
        b.remove(id);
    }
    emit_snapshot(app);
}

/// 磁盘剩余空间：Rust 侧无先例（§0 第 5 拍），取不到就回 None 让调用方跳过这一道
fn disk_free_bytes(_path: &Path) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gpm-tpl-exec-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn stable_tag_gate_only_accepts_stable_forms() {
        // 真源 /^\d+\.\d+(\.\d+)?-stable$/：beta 与带 v 前缀的都要拒(拒给的方向是「换正式版」,
        // 而不是「你的源码有问题」—— 那两类 tag 撞出来的旧文案正好指反方向)
        assert!(is_stable_tag("4.7.2-stable") && is_stable_tag("4.3-stable"));
        assert!(!is_stable_tag("4.4-beta1"), "预发布版不能过");
        assert!(!is_stable_tag("v4.7.2-stable"), "带 v 前缀不能过");
        assert!(!is_stable_tag("4.7.2.1-stable"), "四段版本号不能过");
        assert!(!is_stable_tag(""), "空串不能过");
        assert!(!is_stable_tag("4.7.2-dev"), "其它后缀不能过");
    }

    #[test]
    fn probe_source_sync_reads_the_real_fixture_tree() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("src-tauri/tests/fixtures/tplsrc");
        let r = probe_source_sync(&repo);
        assert_eq!(r["ok"], json!(true), "夹具树应当探得过");
        assert_eq!(r["sourceVersion"], json!("4.7.2-stable"), "version.py 读出的串要与真源同形态");
        let bad = probe_source_sync(&repo.join("platform"));
        assert_eq!(bad["ok"], json!(false), "缺 SConstruct 的目录必须拒");
        assert_eq!(bad["error"], json!("所选目录不是 Godot 源码根(缺 SConstruct)"));
        assert_eq!(probe_source_sync(Path::new(""))["ok"], json!(false), "空路径不炸");
    }

    #[test]
    fn stage_bin_maps_only_real_template_products() {
        let d = tmp("stage");
        let bin = d.join("bin");
        fs::create_dir_all(&bin).unwrap();
        for f in [
            "godot.windows.template_release.x86_64.exe",
            "godot.windows.template_release.x86_64.console.exe",
            "godot.windows.template_release.x86_64.exp",
            "godot.windows.editor.x86_64.exe",
            "README.md",
        ] {
            fs::write(bin.join(f), b"x").unwrap();
        }
        let stage = d.join("stage");
        assert_eq!(stage_bin(&bin, &stage), 3, "只搬模板产物,编辑器产物与杂项不动");
        let mut got: Vec<String> = fs::read_dir(stage.join("templates")).unwrap()
            .flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        got.sort();
        assert_eq!(got, vec![
            "windows_release_x86_64.console.exe".to_string(),
            "windows_release_x86_64.exe".to_string(),
            "windows_release_x86_64.exp".to_string()
        ], "改名必须是官方 tpz 形态");
        assert_eq!(stage_bin(&d.join("no-such-bin"), &d.join("stage2")), 0, "bin 不在不炸,回 0 让调用方报错");
        let _ = fs::remove_dir_all(&d);
    }

    /// 真机探测(#[ignore]):检测层跑的是本机子进程,两端不可能逐字节比,
    /// 但**这台机器上到底探到了什么**必须有地方能一键看 —— 跑法:
    ///   cargo test --lib real_toolchain_detection -- --ignored --nocapture
    /// 只断言形状(12 个键齐、类型对),不断言本机装了什么。
    #[test]
    #[ignore]
    fn real_toolchain_detection_shape_and_values() {
        let r = super::check_template_build_tools();
        let keys = [
            "ok", "pythonVersion", "pythonPath", "sconsVersion", "sconsPath", "vcvarsPath",
            "tarPath", "d3d12SdkInstalled", "accesskitSdkInstalled", "cpuCount", "problems"
        ];
        for k in keys { assert!(r.get(k).is_some(), "缺键 {k}"); }
        assert!(r["problems"].is_array(), "problems 必须是数组");
        assert_eq!(r["ok"], json!(r["problems"].as_array().unwrap().is_empty()), "ok 必须等价于 problems 为空");
        println!("  本机检测:{r}");
    }

    #[test]
    fn queued_task_cancelled_before_running() {
        // 排队中取消:TaskBook.cancel 直接置 Canceled,作业开跑前会看到并跳过(pump 那条早退分支)
        let id = { book().lock().unwrap().push("tplbuild", json!({ "tag": "4.7.2-stable" })) };
        assert!(book().lock().unwrap().cancel(id), "queued 可取消");
        assert!(book().lock().unwrap().get_mut(id).unwrap().status.is_terminal());
        assert!(book().lock().unwrap().remove(id));
    }
}
