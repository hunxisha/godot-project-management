// 桌面版 2.0 主进程(Tauri 2 + Rust 核心)。
//
// T2 起步:JSON 文档库(store.rs,与 ZTools 宿主 lib/store.js 同语义同文件格式)以命令形式
// 暴露给渲染层(db_get/db_put/db_remove/db_all_docs);领域命令按
// docs/tauri-migration-plan.md 的 T2-T4 逐域落位,与 lib/ 同名域一一对应。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use godot_workshop::{backup, extract, fsutil, http, launcher, projects, releases, store, taskqueue, templates, versions};
use serde_json::{json, Value};
use godot_workshop::versions::Versions;
use tauri::{AppHandle, Emitter};
use std::path::Path;
use std::sync::Mutex;
use tauri::{Manager, State};

struct AppState {
    store: Mutex<store::Store>,
}

/// 无头自检探针:验证 invoke 通道与 store 就位
#[tauri::command]
fn probe(state: State<AppState>) -> Value {
    let count = state.store.lock().unwrap().all_docs("").len();
    serde_json::json!({ "ok": true, "host": "tauri", "storeDocs": count })
}

#[tauri::command]
fn db_get(state: State<AppState>, id: String) -> Option<Value> {
    state.store.lock().unwrap().get(&id)
}

#[tauri::command]
fn db_put(state: State<AppState>, doc: Value) -> Value {
    state.store.lock().unwrap().put(&doc)
}

#[tauri::command]
fn db_remove(state: State<AppState>, doc: Value) -> Value {
    state.store.lock().unwrap().remove(&doc)
}

#[tauri::command]
fn db_all_docs(state: State<AppState>, prefix: String) -> Vec<Value> {
    state.store.lock().unwrap().all_docs(&prefix)
}

// ---------- projects 域(编排:解析 + store 读写;纯函数在 projects.rs 并有断言) ----------

#[tauri::command]
fn add_project(state: State<AppState>, input_path: String, version_id: Option<String>) -> Value {
    let root = projects::resolve_project_root(Path::new(&input_path));
    if !root.join("project.godot").is_file() {
        return serde_json::json!({ "ok": false, "error": "未找到 project.godot" });
    }
    let id = projects::project_doc_id(&root);
    let mut st = state.store.lock().unwrap();
    let old = st.get(&id);
    let text = std::fs::read_to_string(root.join("project.godot")).unwrap_or_default();
    let (name, cfg, ev, icon, _plugins) = projects::parse_project_godot_text(&text);
    let versions = st.all_docs("godot/version/");
    let version_id = version_id
        .or_else(|| old.as_ref().and_then(|o| o.get("versionId").and_then(|v| v.as_str()).map(String::from)))
        .or_else(|| projects::match_version(&(cfg, ev.clone()), &versions));
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let project = serde_json::json!({
        "id": id, "path": root.to_string_lossy(), "name": if name.is_empty() { root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(name) } else { name },
        "icon": icon, "configVersion": cfg, "engineVersion": ev, "versionId": version_id,
        "favorite": old.as_ref().map(|o| o.get("favorite").and_then(|v| v.as_bool()).unwrap_or(false)).unwrap_or(false),
        "lastOpenedAt": old.as_ref().and_then(|o| o.get("lastOpenedAt").cloned()),
        "openCount": old.as_ref().and_then(|o| o.get("openCount").and_then(|v| v.as_u64())).unwrap_or(0),
        "addedAt": old.as_ref().and_then(|o| o.get("addedAt").and_then(|v| v.as_u64())).unwrap_or(now_ms),
    });
    let res = st.put(&project);
    if res.get("ok") == Some(&serde_json::json!(true)) {
        serde_json::json!({ "ok": true, "project": st.get(&id), "exists": old.is_some() })
    } else {
        serde_json::json!({ "ok": false, "error": res.get("message").and_then(|v| v.as_str()).unwrap_or("写入失败") })
    }
}

#[tauri::command]
fn scan_projects(root_dir: String) -> Vec<String> {
    projects::scan_projects(Path::new(&root_dir))
}

#[tauri::command]
fn remove_project(state: State<AppState>, id: String, delete_files: Option<bool>) -> Value {
    let mut st = state.store.lock().unwrap();
    let Some(doc) = st.get(&id) else {
        return serde_json::json!({ "ok": true, "filesDeleted": false });
    };
    let mut files_deleted = false;
    if delete_files.unwrap_or(false) {
        if let Some(p) = doc.get("path").and_then(|v| v.as_str()) {
            match std::fs::remove_dir_all(p) {
                Ok(_) => files_deleted = true,
                Err(e) => return serde_json::json!({ "ok": false, "error": format!("删除目录失败:{e}") }),
            }
        }
    }
    let res = st.remove(&doc);
    serde_json::json!({ "ok": res.get("ok").is_some(), "filesDeleted": files_deleted })
}

/// 网络诊断三链路(端点与 lib/diagnostics.js 一致;代理取设置,由调用方传入)
#[tauri::command]
async fn run_network_diagnostics(proxy: Option<String>) -> Value {
    const TARGETS: [(&str, &str); 3] = [
        ("Asset Store API", "https://store.godotengine.org/api/v1/asset-types/"),
        ("GitHub Releases", "https://github.com/godotengine/godot/releases"),
        ("官方下载 CDN", "https://downloads.godotengine.org/"),
    ];
    let client = match http::client_with_proxy(proxy.as_deref()) {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "ok": false, "results": [], "error": e }),
    };
    let mut results = Vec::new();
    for (name, url) in TARGETS {
        let (ok, ms, status) = http::probe(&client, url).await;
        results.push(serde_json::json!({
            "name": name, "url": url, "ok": ok, "ms": ms as u64, "error": status,
        }));
    }
    serde_json::json!({ "ok": results.iter().all(|r| r["ok"] == true), "results": results })
}


// ---------- templates / launcher / backup / exporter 域命令 ----------
fn emit_snapshot(app: &AppHandle) {
    // 统一走 tpl::exec 的合并出口(自编译任务 kind=tplbuild 记在自己的簿上,各发各的会互相抹掉)
    godot_workshop::tpl::exec::emit_snapshot(app);
}


fn home_dir() -> std::path::PathBuf {
    std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"))
        .map(std::path::PathBuf::from).unwrap_or_default()
}

#[tauri::command]
fn export_template_status(exe_path: String, tag: String) -> Value {
    let appdata = std::env::var("APPDATA").ok().map(std::path::PathBuf::from);
    let base = godot_workshop::templates::templates_base(Some(Path::new(&exe_path)), &home_dir(), appdata.as_deref(), "windows");
    godot_workshop::templates::status(&base, &tag)
}

/// 安装导出模板:缺省从官方 release 下载;src_path 提供时改从本地导入(.tpz 文件或已解压目录),
/// 不发起网络请求。version_dir 提供时作为目标目录名(须过 templates::is_valid_version_dir_name 白名单)。
#[tauri::command]
fn install_export_templates(app: AppHandle, state: State<Versions>, exe_path: String, tag: String, url: Option<String>, src_path: Option<String>, version_dir: Option<String>) -> Value {
    let platform = if cfg!(target_os = "windows") { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" };
    let appdata = std::env::var("APPDATA").ok().map(std::path::PathBuf::from);
    let base = godot_workshop::templates::templates_base(Some(Path::new(&exe_path)), &home_dir(), appdata.as_deref(), platform);
    let task_id = state.book.lock().unwrap().push("templates", serde_json::json!({ "tag": tag, "received": 0 }));
    let app2 = app.clone();
    let proxy = state.proxy.lock().unwrap().clone();
    tauri::async_runtime::spawn(async move {
        let v = app2.state::<Versions>();
        let set = |st: taskqueue::Status, err: Option<String>, patch: Value| {
            if let Some(t) = v.book.lock().unwrap().get_mut(task_id) {
                t.status = st; t.error = err;
                if let (Some(o), Some(p)) = (t.payload.as_object_mut(), patch.as_object()) { for (k, val) in p { o.insert(k.clone(), val.clone()); } }
            }
            emit_snapshot(&app2);
        };
        set(taskqueue::Status::Running, None, serde_json::json!({}));
        let stage = std::env::temp_dir().join(format!("gpm-tpl-stage-{task_id}"));
        let _ = std::fs::remove_dir_all(&stage);
        let local = src_path.as_deref().map(std::path::PathBuf::from);
        if let Some(src) = &local {
            // 本地来源:文件 → 解压进 stage;目录 → 直接当 stage(免拷贝)。坏包/错平台交给 install_from_stage 校验。
            let stage_ref: &Path = if src.is_dir() {
                src.as_path()
            } else {
                let tpz_stage = &stage;
                if let Err(e) = godot_workshop::extract::unzip(src, tpz_stage) {
                    set(taskqueue::Status::Error, Some(e), serde_json::json!({}));
                    return;
                }
                tpz_stage
            };
            match godot_workshop::templates::install_from_stage(stage_ref, &base, &tag, platform, version_dir.as_deref()) {
                Ok((files, vd)) => { let _ = std::fs::remove_dir_all(&stage); set(taskqueue::Status::Done, None, serde_json::json!({ "versionDir": vd, "files": files })); }
                Err(e) => { let _ = std::fs::remove_dir_all(&stage); set(taskqueue::Status::Error, Some(e), serde_json::json!({})); }
            }
            return;
        }
        let tpz = stage.with_extension("tpz");
        let dl = godot_workshop::http::download(
            godot_workshop::http::DownloadOptions { url: url.unwrap_or_default(), dest: tpz.clone(), proxy, sha256: None },
            |received, _t| { if let Some(t) = v.book.lock().unwrap().get_mut(task_id) { t.payload["received"] = serde_json::json!(received); } },
        ).await;
        if let Err(e) = dl { set(taskqueue::Status::Error, Some(e), serde_json::json!({})); let _ = std::fs::remove_dir_all(&stage); return; }
        let ex = godot_workshop::extract::unzip(&tpz, &stage);
        let _ = std::fs::remove_file(&tpz);
        if let Err(e) = ex { set(taskqueue::Status::Error, Some(e), serde_json::json!({})); let _ = std::fs::remove_dir_all(&stage); return; }
        let tag_now = v.book.lock().unwrap().get_mut(task_id).map(|t| t.payload["tag"].as_str().unwrap_or("").to_string()).unwrap_or_default();
        match godot_workshop::templates::install_from_stage(&stage, &base, &tag_now, platform, version_dir.as_deref()) {
            Ok((files, vd)) => { let _ = std::fs::remove_dir_all(&stage); set(taskqueue::Status::Done, None, serde_json::json!({ "versionDir": vd, "files": files })); }
            Err(e) => { let _ = std::fs::remove_dir_all(&stage); set(taskqueue::Status::Error, Some(e), serde_json::json!({})); }
        }
    });
    emit_snapshot(&app);
    serde_json::json!({ "ok": true, "taskId": task_id.to_string() })
}

#[tauri::command]
fn uninstall_export_templates(exe_path: String, tag: String) -> Value {
    let appdata = std::env::var("APPDATA").ok().map(std::path::PathBuf::from);
    let base = godot_workshop::templates::templates_base(Some(Path::new(&exe_path)), &home_dir(), appdata.as_deref(), "windows");
    let dir = base.join(godot_workshop::templates::version_dir_for_tag(&tag));
    if dir.is_dir() {
        if let Err(e) = godot_workshop::fsutil::delete_to_trash(&dir) {
            return serde_json::json!({ "ok": false, "error": e });
        }
    }
    serde_json::json!({ "ok": true })
}

/// ---------- 导出模板自编译(P0e-1 四条) ----------
/// 判据全在 godot_workshop::tpl::{probe,profile},命令层只做参数搬运 ——
/// 与 JS 宿主的 services.js:61-131 同构,两端逐字节对照由 src-tauri/tests/tpl_parity.rs 钉住。
#[tauri::command]
fn probe_template_source(src_dir: String) -> Value {
    godot_workshop::tpl::api::probe_template_source(&src_dir)
}

#[tauri::command]
fn list_template_features(src_dir: String) -> Value {
    godot_workshop::tpl::api::list_template_features(&src_dir)
}

#[tauri::command]
fn validate_template_config(params: Value) -> Value {
    godot_workshop::tpl::api::validate_template_config(&params)
}

#[tauri::command]
fn apply_template_preset(name: String, src_dir: String) -> Value {
    godot_workshop::tpl::api::apply_template_preset(&name, &src_dir)
}

/// ---------- 自编译工具链检测与编译(P0e-2) ----------
/// 检测的三个子进程与编译的 cmd.exe 全在 tpl::exec 里,参数一律写死:
/// 渲染层只给 srcDir / tag / jobs / features / mode 五个值(buildtools.js:22 那条红线)。
#[tauri::command]
fn check_template_build_tools() -> Value {
    godot_workshop::tpl::exec::check_template_build_tools()
}

#[tauri::command]
fn build_template_pack(app: AppHandle, params: Value) -> Value {
    godot_workshop::tpl::exec::build_template_pack(&app, &params)
}

#[tauri::command]
fn cancel_template_build_task(app: AppHandle, id: String) {
    godot_workshop::tpl::exec::cancel_template_build_task(&app, id.parse().unwrap_or(0));
}

#[tauri::command]
fn dismiss_template_build_task(app: AppHandle, id: String) {
    godot_workshop::tpl::exec::dismiss_template_build_task(&app, id.parse().unwrap_or(0));
}

/// ---------- 代下载源码(P0e-3) ----------
/// 进度走 `tplsource://progress` 事件(契约的 onProgress 是回调,不是任务通道),
/// 垫片侧 listen → 转回调;完整性三种坏法(旁证缺失/形态不认/sha 不匹配)全拒解。
#[tauri::command]
async fn download_template_source(app: AppHandle, params: Value) -> Value {
    godot_workshop::tpl::source::download_template_source(app, params).await
}

#[tauri::command]
fn cancel_template_source_download() -> Value {
    godot_workshop::tpl::source::cancel_template_source_download()
}

#[tauri::command]
fn scan_project_tree(state: State<AppState>, project_id: String, opts: Option<Value>) -> Value {
    let root = match project_root_of(&state.store, &project_id) { Ok(r) => r, Err(e) => return serde_json::json!({ "ok": false, "error": e }) };
    // opts 的逐键解析与归一收在库里(D-6),命令层只负责取根与转发。
    let scan = godot_workshop::inspectfs::ScanOpts::from_json(
        &opts.unwrap_or_else(|| serde_json::json!({})));
    godot_workshop::inspectfs::scan_json(&root, &scan)
}

/// 读项目内文本文件(rel 相对项目根、正斜杠;超限只报 truncated)。
#[tauri::command]
fn read_project_text(state: State<AppState>, project_id: String, rel: String, max_bytes: Option<u64>) -> Value {
    match project_doc_root_of(&state.store, &project_id) {
        Ok(r) => godot_workshop::inspectfs::read_text_json(&r, &rel,
            max_bytes.unwrap_or(godot_workshop::inspectfs::DEFAULT_MAX_BYTES)),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

/// 写项目内文本文件(同目录临时文件 + rename 原子落盘,默认先备份)。
#[tauri::command]
fn write_project_text(state: State<AppState>, project_id: String, rel: String, text: String, backup: Option<bool>) -> Value {
    match project_doc_root_of(&state.store, &project_id) {
        Ok(r) => godot_workshop::inspectfs::write_text_json(&r, &rel, &text, backup.unwrap_or(true)),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

/// 批量移入回收站:单项失败不中断其余,失败项原样带回(moved 以磁盘实况为准)。
#[tauri::command]
fn move_paths_to_trash(state: State<AppState>, project_id: String, rels: Vec<String>) -> Value {
    match project_doc_root_of(&state.store, &project_id) {
        Ok(r) => godot_workshop::inspectfs::trash_json(&r, &rels),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

/// 批量计算项目内文件的 SHA-256:流式分块读,单项失败不中断其余,失败项如实带回。
#[tauri::command]
fn hash_paths(state: State<AppState>, project_id: String, rels: Vec<String>) -> Value {
    match project_doc_root_of(&state.store, &project_id) {
        Ok(r) => godot_workshop::inspectfs::hash_json(&r, &rels),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

/// 读 / 写 / 删三命令共用:projectId → 项目根**文档里记的那个路径**(不查盘)。
///
/// 与 JS 侧的分工逐字对齐:`projectRoot()` 只做 store 查询,目录还在不在**不归它管** ——
/// 拿不到文档 → '项目不存在';目录已被删 → 库里的包含闸 canonicalize 失败 → '路径无法解析'。
/// 所以这里不能像 `project_root_of`(遍历命令用,JS 的 scanProjectTree 自己有 existsSync 分支,
/// 回 '项目目录已不存在')那样先做 is_dir 再报错,否则同一件事两端给两句不同的话。
fn project_doc_root_of(store: &Mutex<store::Store>, project_id: &str) -> Result<std::path::PathBuf, String> {
    let st = store.lock().unwrap();
    st.get(project_id)
        .and_then(|d| d.get("path").and_then(|v| v.as_str()).map(String::from))
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "项目不存在".to_string())
}

/// 遍历命令用:projectId → 项目根,并确认目录还在(与 list_export_presets 同一取法)。
///
/// 取根一步**委托给 `project_doc_root_of`**(它已经把「文档没有 path / path 是空串」都收敛成
/// '项目不存在'),这里只加 `is_dir()` 那一次探盘 —— 不再重复一遍 store 查询。
/// 空串形态必须跟着委托走:JS 的 `projectRoot()` 里 `doc.path` 为空串就是 falsy →
/// `scanProjectTree` 回 '项目不存在'(inspectfs.js:243-244),而旧实现先拿到 `Some("")`
/// 再 is_dir 失败 → 报 '项目目录已不存在',两端各说一句话。
fn project_root_of(store: &Mutex<store::Store>, project_id: &str) -> Result<std::path::PathBuf, String> {
    let pb = project_doc_root_of(store, project_id)?;
    if pb.is_dir() { Ok(pb) } else { Err("项目目录已不存在".into()) }
}

#[tauri::command]
fn launch_project(state: State<AppState>, project_id: String, action: String) -> Value {
    let mut st = state.store.lock().unwrap();
    let Some(proj) = st.get(&project_id) else {
        return serde_json::json!({ "ok": false, "error": "项目不存在" });
    };
    let Some(path) = proj.get("path").and_then(|v| v.as_str()) else {
        return serde_json::json!({ "ok": false, "error": "项目缺少路径" });
    };
    let exe = proj.get("versionId").and_then(|v| v.as_str())
        .and_then(|vid| st.get(vid))
        .and_then(|ver| ver.get("exePath").and_then(|e| e.as_str()).map(String::from));
    let Some(exe) = exe else {
        return serde_json::json!({ "ok": false, "error": "项目未绑定已安装引擎" });
    };
    match godot_workshop::launcher::launch(Path::new(&exe), Path::new(path), &action) {
        Ok(()) => serde_json::json!({ "ok": true, "project": st.get(&project_id) }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
fn backup_project(app: AppHandle, state: State<AppState>, versions: State<Versions>, project_id: String, opts: Value) -> Value {
    let st = state.store.lock().unwrap();
    let Some(proj) = st.get(&project_id) else { return serde_json::json!({ "ok": false, "error": "项目不存在" }); };
    let (Some(path), Some(name)) = (
        proj.get("path").and_then(|v| v.as_str()).map(String::from),
        proj.get("name").and_then(|v| v.as_str()).map(String::from),
    ) else { return serde_json::json!({ "ok": false, "error": "项目信息不完整" }); };
    let mode = opts.get("mode").and_then(|v| v.as_str()).unwrap_or("zip").to_string();
    let Some(dest_dir) = opts.get("destDir").and_then(|v| v.as_str()).map(std::path::PathBuf::from) else {
        return serde_json::json!({ "ok": false, "error": "缺少备份目录" });
    };
    let include_cache = opts.get("includeCache").and_then(|v| v.as_bool()).unwrap_or(false);
    let level = opts.get("level").and_then(|v| v.as_u64()).unwrap_or(6) as u8;
    let label = opts.get("label").and_then(|v| v.as_str()).map(String::from);
    let exclude: Vec<String> = opts.get("exclude").and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    drop(st);
    let _ = std::fs::create_dir_all(&dest_dir);
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let dest = dest_dir.join(format!("{name}-{now_ms}.zip"));
    let task_id = versions.book.lock().unwrap().push("backup", serde_json::json!({ "projectName": name, "projectId": project_id, "done": 0 }));
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let v = app2.state::<Versions>();
        let set = |st: taskqueue::Status, err: Option<String>, patch: Value| {
            if let Some(t) = v.book.lock().unwrap().get_mut(task_id) {
                t.status = st; t.error = err;
                if let (Some(o), Some(p)) = (t.payload.as_object_mut(), patch.as_object()) { for (k, val) in p { o.insert(k.clone(), val.clone()); } }
            }
            emit_snapshot(&app2);
        };
        set(taskqueue::Status::Running, None, serde_json::json!({}));
        let result = match mode.as_str() {
            "copy" => godot_workshop::fsutil::copy_recursive(Path::new(&path), &dest)
                .map(|_| (1usize, godot_workshop::fsutil::dir_size(&dest)))
                .map_err(|e| format!("复制失败:{e}")),
            _ => godot_workshop::backup::zip_dir(Path::new(&path), &dest, include_cache, level, &exclude, |done, bytes| {
                if let Some(t) = v.book.lock().unwrap().get_mut(task_id) { t.payload["done"] = serde_json::json!(done); t.payload["bytes"] = serde_json::json!(bytes); }
            }),
        };
        match result {
            Ok((files, size)) => {
                let st2 = app2.state::<AppState>();
                let mut store = st2.store.lock().unwrap();
                let id = format!("godot/backup/{name}-{now_ms}");
                let mut rec = serde_json::json!({
                    "_id": id, "projectId": project_id, "projectName": name,
                    "mode": mode, "destPath": dest.to_string_lossy(), "size": size,
                    "fileCount": files, "createdAt": now_ms, "schema": 2,
                });
                if let Some(l) = label { rec["label"] = serde_json::json!(l); }
                let _ = store.put(&rec);
                drop(store);
                set(taskqueue::Status::Done, None, serde_json::json!({ "backupId": id }));
            }
            Err(e) => { let _ = std::fs::remove_file(&dest); set(taskqueue::Status::Error, Some(e), serde_json::json!({})); }
        }
    });
    serde_json::json!({ "ok": true, "taskId": task_id.to_string() })
}

#[tauri::command]
fn verify_backup(state: State<AppState>, backup_id: String) -> Value {
    let mut st = state.store.lock().unwrap();
    let Some(rec) = st.get(&backup_id) else { return serde_json::json!({ "ok": false, "valid": false, "error": "记录不存在" }); };
    let Some(p) = rec.get("destPath").and_then(|v| v.as_str()) else { return serde_json::json!({ "ok": false, "valid": false, "error": "记录缺少路径" }); };
    if rec.get("mode").and_then(|v| v.as_str()) != Some("zip") {
        let valid = Path::new(p).join("project.godot").is_file();
        return serde_json::json!({ "ok": true, "valid": valid, "error": if valid { None } else { Some("快照里没有 project.godot".to_string()) } });
    }
    match godot_workshop::backup::verify_zip(Path::new(p)) {
        Ok(n) => serde_json::json!({ "ok": true, "valid": true, "entryCount": n }),
        Err(e) => serde_json::json!({ "ok": true, "valid": false, "error": e }),
    }
}

#[tauri::command]
fn delete_backup(state: State<AppState>, backup_id: String, keep_record_only: Option<bool>) -> Value {
    let mut st = state.store.lock().unwrap();
    let Some(rec) = st.get(&backup_id) else { return serde_json::json!({ "ok": true }); };
    if !keep_record_only.unwrap_or(false) {
        if let Some(p) = rec.get("destPath").and_then(|v| v.as_str()) {
            if let Err(e) = godot_workshop::fsutil::delete_to_trash(Path::new(p)) {
                return serde_json::json!({ "ok": false, "error": e });
            }
        }
    }
    st.remove(&rec);
    serde_json::json!({ "ok": true })
}

#[tauri::command]
fn prune_backups(state: State<AppState>, keep_per_project: Option<u64>, older_than_days: Option<u64>, dry_run: Option<bool>) -> Value {
    let mut st = state.store.lock().unwrap();
    let records = st.all_docs("godot/backup/");
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let targets = godot_workshop::backup::prune_targets(&records, keep_per_project, older_than_days, now_ms);
    let total_size: u64 = records.iter().filter(|r| targets.contains(&r.get("_id").and_then(|v| v.as_str()).unwrap_or("").to_string()))
        .filter_map(|r| r.get("size").and_then(|v| v.as_u64())).sum();
    let tv: Vec<Value> = records.iter().filter(|r| targets.contains(&r.get("_id").and_then(|v| v.as_str()).unwrap_or("").to_string())).cloned().collect();
    if dry_run.unwrap_or(true) {
        return serde_json::json!({ "ok": true, "dryRun": true, "targets": tv, "totalSize": total_size });
    }
    let mut removed = 0u64;
    let mut failed: Vec<Value> = Vec::new();
    for id in &targets {
        let Some(rec) = st.get(id) else { continue };
        if let Some(p) = rec.get("destPath").and_then(|v| v.as_str()) {
            if let Err(e) = godot_workshop::fsutil::delete_to_trash(Path::new(p)) {
                failed.push(serde_json::json!({ "id": id, "error": e }));
                continue;
            }
        }
        st.remove(&rec);
        removed += 1;
    }
    serde_json::json!({ "ok": true, "dryRun": false, "removed": removed, "failed": failed, "targets": tv, "totalSize": total_size })
}

#[tauri::command]
fn create_project(state: State<AppState>, name: String, parent_dir: String, renderer: String,
                  version_tag: Option<String>, version_id: Option<String>, git_init: Option<bool>) -> Value {
    let mut st = state.store.lock().unwrap();
    match godot_workshop::projects::create_project_files(Path::new(&parent_dir), &name, &renderer, version_tag.as_deref(), git_init.unwrap_or(false)) {
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
        Ok((dir, git)) => {
            let id = godot_workshop::projects::project_doc_id(&dir);
            let text = std::fs::read_to_string(dir.join("project.godot")).unwrap_or_default();
            let (pname, cfg, ev, _icon, _pl) = godot_workshop::projects::parse_project_godot_text(&text);
            let versions = st.all_docs("godot/version/");
            let vid = version_id.or_else(|| godot_workshop::projects::match_version(&(cfg, ev.clone()), &versions));
            let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
            let project = serde_json::json!({
                "id": id, "path": dir.to_string_lossy(), "name": if pname.is_empty() { name } else { pname },
                "configVersion": cfg, "engineVersion": ev, "versionId": vid,
                "favorite": false, "openCount": 0, "addedAt": now_ms,
            });
            let res = st.put(&project);
            let git_json = git.map(|(i, e, c)| serde_json::json!({ "initialized": i, "error": e, "committed": c }));
            if res.get("ok") == Some(&serde_json::json!(true)) {
                let mut out = serde_json::json!({ "ok": true, "project": st.get(&id) });
                if let Some(g) = git_json { out["git"] = g; }
                out
            } else {
                serde_json::json!({ "ok": false, "error": "项目文件已生成,登记失败" })
            }
        }
    }
}

#[tauri::command]
fn uninstall_addon(state: State<AppState>, project_id: String, dir_name: String, asset_id: Option<String>) -> Value {
    let mut st = state.store.lock().unwrap();
    let Some(proj) = st.get(&project_id) else { return serde_json::json!({ "ok": false, "error": "项目不存在" }); };
    let Some(path) = proj.get("path").and_then(|v| v.as_str()) else { return serde_json::json!({ "ok": false, "error": "项目缺少路径" }); };
    let mut removed_any = false;
    // 素材:按安装清单逐文件删除
    if let Some(aid) = &asset_id {
        let doc_id = format!("godot/asset/{project_id}/{aid}");
        if let Some(doc) = st.get(&doc_id) {
            if doc.get("kind").and_then(|v| v.as_str()) == Some("asset") {
                if let Some(paths) = doc.get("installedPaths").and_then(|v| v.as_array()) {
                    if let Some(root) = doc.get("destRoot").and_then(|v| v.as_str()) {
                        for rel in paths.iter().filter_map(|x| x.as_str()) {
                            let f = Path::new(root).join(rel);
                            if f.is_file() { let _ = std::fs::remove_file(&f); removed_any = true; }
                        }
                    }
                }
                st.remove(&doc);
            }
        }
    }
    // 插件:回收站 addons/<dir>
    let addon_dir = Path::new(path).join("addons").join(&dir_name);
    if addon_dir.is_dir() {
        if let Err(e) = godot_workshop::fsutil::delete_to_trash(&addon_dir) {
            return serde_json::json!({ "ok": false, "error": e });
        }
        removed_any = true;
    }
    if !removed_any { return serde_json::json!({ "ok": false, "error": "未找到可卸载内容" }); }
    serde_json::json!({ "ok": true })
}

#[tauri::command]
fn list_export_presets(state: State<AppState>, project_id: String) -> Value {
    let st = state.store.lock().unwrap();
    let Some(proj) = st.get(&project_id) else { return serde_json::json!({ "ok": false, "error": "项目不存在" }); };
    let Some(path) = proj.get("path").and_then(|v| v.as_str()) else { return serde_json::json!({ "ok": false, "error": "项目缺少路径" }); };
    let cfg = Path::new(path).join("export_presets.cfg");
    let Ok(text) = std::fs::read_to_string(cfg) else { return serde_json::json!({ "ok": true, "presets": [] }) };
    let mut presets: Vec<Value> = Vec::new();
    for block in text.split("[preset").skip(1) {
        let name = block.lines().find_map(|l| l.trim().strip_prefix("name=").map(|s| s.trim_matches('"').to_string()));
        let export_path = block.lines().find_map(|l| l.trim().strip_prefix("export_path=").map(|s| s.trim_matches('"').to_string()));
        if let Some(n) = name { presets.push(serde_json::json!({ "name": n, "exportPath": export_path })); }
    }
    serde_json::json!({ "ok": true, "presets": presets })
}


// ---------- T4 尾巴:市场安装编排 + headless 导出 ----------

use godot_workshop::assets;

fn split_asset_id(asset_id: &str) -> (String, String) {
    match asset_id.split_once('/') {
        Some((a, b)) => (a.to_string(), b.to_string()),
        None => (asset_id.to_string(), String::new()),
    }
}

/// 解析资产下载地址(store API:releases 里按 version 或最新)
async fn asset_download_url(proxy: Option<String>, asset_id: &str, version: Option<&str>) -> Result<(String, String, String), String> {
    let client = godot_workshop::http::client_with_proxy(proxy.as_deref())?;
    let (pubslug, slug) = split_asset_id(asset_id);
    let detail: Value = client
        .get(format!("https://store.godotengine.org/api/v1/assets/{pubslug}/{slug}/"))
        .send().await.map_err(|e| format!("资产信息请求失败:{e}"))?
        .json().await.map_err(|e| format!("资产信息解析失败:{e}"))?;
    let releases: Value = client
        .get(format!("https://store.godotengine.org/api/v1/releases/{pubslug}/{slug}/"))
        .send().await.map_err(|e| format!("版本请求失败:{e}"))?
        .json().await.map_err(|e| format!("版本解析失败:{e}"))?;
    let empty = Vec::new();
    let list = releases.as_array().unwrap_or(&empty);
    let rel = version
        .and_then(|v| list.iter().find(|r| r.get("version").and_then(|x| x.as_str()).map(|s| s == v).unwrap_or(false)))
        .or_else(|| list.first());
    let title = detail.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    match rel.and_then(|r| r.get("download_url").and_then(|v| v.as_str()).map(String::from)) {
        Some(url) => Ok((url, title, rel.and_then(|r| r.get("version").and_then(|v| v.as_str()).map(String::from)).unwrap_or_default())),
        None => Err("资产没有下载地址".into()),
    }
}

#[tauri::command]
async fn install_asset(
    app: AppHandle,
    state: State<'_, AppState>,
    versions: State<'_, Versions>,
    project_id: String,
    asset_id: String,
    version: Option<String>,
    strip_top_dir: Option<bool>,
    auto_enable: Option<bool>,
    asset_meta: Option<Value>,
) -> Result<Value, ()> {
    let proxy = versions.proxy.lock().unwrap().clone();
    let (project_path, _meta) = {
        let st = state.store.lock().unwrap();
        match st.get(&project_id).and_then(|p| p.get("path").and_then(|v| v.as_str()).map(String::from)) {
            Some(p) => (p, ()),
            None => return Err(()),
        }
    };
    let (url, title, version_string) = match asset_download_url(proxy.clone(), &asset_id, version.as_deref()).await {
        Ok(v) => v,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e })),
    };
    let task_id = versions.book.lock().unwrap().push("install", serde_json::json!({ "assetId": asset_id, "projectId": project_id, "title": title }));
    emit_snapshot(&app);
    let app2 = app.clone();
    let result = async move {
        let v = app2.state::<Versions>();
        let set = |st: taskqueue::Status, err: Option<String>, patch: Value| {
            if let Some(t) = v.book.lock().unwrap().get_mut(task_id) {
                t.status = st; t.error = err;
                if let (Some(o), Some(p)) = (t.payload.as_object_mut(), patch.as_object()) { for (k, val) in p { o.insert(k.clone(), val.clone()); } }
            }
            emit_snapshot(&app2);
        };
        set(taskqueue::Status::Running, None, serde_json::json!({}));
        let stage = std::env::temp_dir().join(format!("gpm-asset-stage-{task_id}"));
        let _ = std::fs::remove_dir_all(&stage);
        std::fs::create_dir_all(&stage).ok();
        let zip_path = stage.with_extension("zip");
        let dl = godot_workshop::http::download(
            godot_workshop::http::DownloadOptions { url, dest: zip_path.clone(), proxy, sha256: None },
            |received, total| {
                if let Some(t) = v.book.lock().unwrap().get_mut(task_id) {
                    t.payload["received"] = serde_json::json!(received);
                    if let Some(t2) = total { t.payload["totalSize"] = serde_json::json!(t2); }
                }
            },
        ).await;
        if let Err(e) = dl { set(taskqueue::Status::Error, Some(e.clone()), serde_json::json!({})); let _ = std::fs::remove_dir_all(&stage); return Err(e); }
        let ex = godot_workshop::extract::unzip(&zip_path, &stage);
        let _ = std::fs::remove_file(&zip_path);
        if let Err(e) = ex { set(taskqueue::Status::Error, Some(e.clone()), serde_json::json!({})); return Err(e); }
        // 嗅探分界
        let cfgs = assets::find_plugin_cfgs(&stage);
        let project_root = std::path::PathBuf::from(&project_path);
        let out = if !cfgs.is_empty() {
            // 插件链路:源目录直接子项挪进 addons/
            let addons_dir = project_root.join("addons");
            let _ = std::fs::create_dir_all(&addons_dir);
            let mut dir_names: Vec<String> = Vec::new();
            for src in assets::locate_sources(&stage) {
                let Ok(rd) = std::fs::read_dir(&src) else { continue };
                for e in rd.flatten() {
                    let dest = addons_dir.join(e.file_name());
                    let sp = e.path();
                    if sp.is_dir() {
                        let _ = std::fs::remove_dir_all(&dest);
                        if godot_workshop::fsutil::move_sync(&sp, &dest).is_ok() {
                            dir_names.push(e.file_name().to_string_lossy().into_owned());
                        }
                    } else if e.file_name() == ".import" || e.file_name().to_string_lossy().ends_with(".gdignore") {
                        // 单文件资产不移动
                    } else {
                        let _ = std::fs::remove_file(&dest);
                        if std::fs::copy(&sp, &dest).is_ok() { removed_single(&mut dir_names, e.file_name()); }
                    }
                }
            }
            if dir_names.is_empty() {
                set(taskqueue::Status::Error, Some("压缩包中未找到插件目录".into()), serde_json::json!({}));
                let _ = std::fs::remove_dir_all(&stage);
                return Err("压缩包中未找到插件目录".into());
            }
            // 自动启用(设置 autoEnablePlugin != false)
            let auto = {
                let appstate = app2.state::<AppState>();
                let st = appstate.store.lock().unwrap();
                st.get("godot/settings").and_then(|s| s.get("autoEnablePlugin").and_then(|v| v.as_bool())).unwrap_or(true)
            } && auto_enable.unwrap_or(true);
            let mut enabled = false;
            if auto {
                let ini_path = project_root.join("project.godot");
                if let Ok(text) = std::fs::read_to_string(&ini_path) {
                    let next = assets::set_plugin_enabled(&text, &dir_names, true);
                    let _ = std::fs::write(&ini_path, next);
                    enabled = true;
                }
            }
            let record = serde_json::json!({
                "_id": format!("godot/asset/{project_id}/{asset_id}"),
                "assetId": asset_id, "projectId": project_id,
                "title": title, "versionString": version_string,
                "kind": "addon", "dirNames": dir_names, "enabled": enabled,
                "installedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,
            });
            let _ = app2.state::<AppState>().store.lock().unwrap().put(&record);
            Ok(serde_json::json!({ "title": title, "versionString": version_string, "dirNames": record["dirNames"], "enabled": enabled, "kind": "addon" }))
        } else {
            // 素材链路:顶层条目并入项目根(strip_top_dir 时先剥掉唯一顶层目录)
            let mut root = stage.clone();
            let top: Vec<std::path::PathBuf> = std::fs::read_dir(&stage).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default();
            if strip_top_dir.unwrap_or(false) && top.len() == 1 && top[0].is_dir() {
                root = top[0].clone();
            }
            let moved = godot_workshop::fsutil::copy_recursive(&root, &project_root).is_ok();
            if !moved {
                set(taskqueue::Status::Error, Some("素材写入项目失败".into()), serde_json::json!({}));
                let _ = std::fs::remove_dir_all(&stage);
                return Err("素材写入项目失败".into());
            }
            let installed_paths = assets::collect_files(&root);
            let top_entries: Vec<String> = std::fs::read_dir(&root).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
            let record = godot_workshop::assets::asset_record(&asset_id, &project_id, &title, &version_string, &top_entries, &installed_paths, &project_path);
            let _ = app2.state::<AppState>().store.lock().unwrap().put(&record);
            let _ = std::fs::remove_dir_all(&stage);
            Ok(serde_json::json!({ "title": title, "versionString": version_string, "dirNames": top_entries, "enabled": false, "kind": "asset" }))
        };
        let _ = std::fs::remove_dir_all(&stage);
        match out {
            Ok(addon) => { set(taskqueue::Status::Done, None, serde_json::json!({})); Ok(addon) }
            Err(e) => Err(e),
        }
    }
    .await;
    Ok(match result {
        Ok(addon) => serde_json::json!({ "ok": true, "addon": addon }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    })
}

fn removed_single(_names: &mut Vec<String>, _f: std::ffi::OsString) {}

#[tauri::command]
fn run_export(
    app: AppHandle,
    state: State<AppState>,
    versions: State<Versions>,
    project_id: String,
    preset_name: String,
    output_path: Option<String>,
) -> Value {
    let st = state.store.lock().unwrap();
    let Some(proj) = st.get(&project_id) else { return serde_json::json!({ "ok": false, "error": "项目不存在" }); };
    let (Some(path), Some(name)) = (
        proj.get("path").and_then(|v| v.as_str()).map(String::from),
        proj.get("name").and_then(|v| v.as_str()).map(String::from),
    ) else { return serde_json::json!({ "ok": false, "error": "项目信息不完整" }); };
    let exe = proj.get("versionId").and_then(|v| v.as_str())
        .and_then(|vid| st.get(vid))
        .and_then(|ver| ver.get("exePath").and_then(|e| e.as_str()).map(String::from));
    drop(st);
    let Some(exe) = exe else { return serde_json::json!({ "ok": false, "error": "项目未绑定已安装引擎" }); };
    let output = output_path.unwrap_or_else(|| format!("{name}_export.bin"));
    let task_id = versions.book.lock().unwrap().push("export", serde_json::json!({ "projectId": project_id, "projectName": name, "preset": preset_name, "log": String::new() }));
    let app2 = app.clone();
    std::thread::spawn(move || {
        let v = app2.state::<Versions>();
        let set = |st: taskqueue::Status, err: Option<String>, patch: Value| {
            if let Some(t) = v.book.lock().unwrap().get_mut(task_id) {
                t.status = st; t.error = err;
                if let (Some(o), Some(p)) = (t.payload.as_object_mut(), patch.as_object()) { for (k, val) in p { o.insert(k.clone(), val.clone()); } }
            }
            emit_snapshot(&app2);
        };
        set(taskqueue::Status::Running, None, serde_json::json!({}));
        let child = std::process::Command::new(&exe)
            .args(["--headless", "--path", &path, "--export-release", &preset_name, &output])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => { set(taskqueue::Status::Error, Some(format!("启动导出失败:{e}")), serde_json::json!({})); return; }
        };
        export_children().lock().unwrap().insert(task_id, child.id());
        if let Some(mut out) = child.stdout.take() {
            use std::io::Read;
            let mut buf = [0u8; 4096];
            let mut tail: Vec<String> = Vec::new();
            loop {
                match out.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        for line in String::from_utf8_lossy(&buf[..n]).lines() {
                            tail.push(line.to_string());
                        }
                        if tail.len() > 20 { tail = tail.split_off(tail.len() - 20); }
                        if let Some(t) = v.book.lock().unwrap().get_mut(task_id) { t.payload["log"] = serde_json::json!(tail.join("\n")); }
                    }
                }
            }
        }
        let status = child.wait();
        export_children().lock().unwrap().remove(&task_id);
        match status {
            Ok(s) if s.success() => set(taskqueue::Status::Done, None, serde_json::json!({ "output": output })),
            Ok(_) | Err(_) => {
                let canceled = v.book.lock().unwrap().get_mut(task_id).map(|t| t.cancel_requested).unwrap_or(false);
                if canceled { set(taskqueue::Status::Canceled, None, serde_json::json!({})); }
                else { set(taskqueue::Status::Error, Some("导出进程非零退出".into()), serde_json::json!({})); }
            }
        }
    });
    serde_json::json!({ "ok": true, "taskId": task_id.to_string() })
}

fn export_children() -> &'static std::sync::Mutex<std::collections::HashMap<u64, u32>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u64, u32>>> = std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[tauri::command]
fn cancel_export_task(versions: State<Versions>, id: String) -> Value {
    let tid: u64 = id.parse().unwrap_or(0);
    if let Ok(map) = export_children().lock() {
        if let Some(pid) = map.get(&tid) {
            #[cfg(windows)]
            { let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/F", "/T"]).output(); }
            #[cfg(not(windows))]
            { unsafe { libc_kill(*pid as i32, 9); } }
        }
    }
    let ok = versions.book.lock().unwrap().cancel(tid);
    serde_json::json!({ "ok": ok })
}

#[cfg(not(windows))]
unsafe fn libc_kill(pid: i32, sig: i32) {
    std::mem::forget(pid);
    let _ = sig;
    // 非 Windows 取消在 T5 用 nix/libc crate 落地
}


// ---------- docs 域命令(纯函数在 docs.rs 并有断言;此处只做 IO 编排) ----------

fn docs_base_dir(state: &State<AppState>, version_id: &str) -> std::path::PathBuf {
    let doc_dir = std::path::PathBuf::from(
        state.store.lock().unwrap()
            .get(version_id)
            .and_then(|v| v.get("installDir").and_then(|d| d.as_str()).map(String::from))
            .unwrap_or_default(),
    );
    // 库与引擎同盘管理:userData/godot-docs/{versionId}/(独立于引擎目录,删引擎不删库)
    std::env::temp_dir().join("gpm-docs-base").join(version_id.replace('/', "_"))
}

fn po_cache_path(base: &std::path::Path) -> std::path::PathBuf {
    base.join("zh_Hans.po.cache")
}

async fn fetch_po(proxy: Option<String>, base: &std::path::Path, tag: &str) -> Option<std::collections::HashMap<String, String>> {
    let cache = po_cache_path(base);
    if let Ok(text) = std::fs::read_to_string(&cache) {
        return Some(godot_workshop::docs::parse_po(&text));
    }
    // zh_Hans.po:godot 仓库 doc/translations,tag → 小版本分支 → master 回退链
    let short = tag.split('.').take(2).collect::<Vec<_>>().join(".");
    let client = godot_workshop::http::client_with_proxy(proxy.as_deref()).ok()?;
    for branch in [tag.to_string(), short, "master".to_string()] {
        let url = format!("https://raw.githubusercontent.com/godotengine/godot/{branch}/doc/translations/zh_Hans.po");
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    if text.contains("msgid") {
                        let _ = std::fs::write(&cache, &text);
                        return Some(godot_workshop::docs::parse_po(&text));
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
async fn docs_generate(
    app: AppHandle,
    state: State<'_, AppState>,
    versions: State<'_, Versions>,
    version_id: String,
    exe_path: String,
    force_translation: Option<bool>,
) -> Result<Value, ()> {
    let task_id = versions.book.lock().unwrap().push("docs", serde_json::json!({ "versionId": version_id, "tag": version_id.split('/').next_back().unwrap_or(""), "phase": "queued" }));
    emit_snapshot(&app);
    let app2 = app.clone();
    let result = async move {
        let v = app2.state::<Versions>();
        let set = |st: taskqueue::Status, err: Option<String>, patch: Value| {
            if let Some(t) = v.book.lock().unwrap().get_mut(task_id) {
                t.status = st; t.error = err;
                if let (Some(o), Some(p)) = (t.payload.as_object_mut(), patch.as_object()) { for (k, val) in p { o.insert(k.clone(), val.clone()); } }
            }
            emit_snapshot(&app2);
        };
        set(taskqueue::Status::Running, None, serde_json::json!({ "phase": "dumping" }));
        let base = docs_base_dir(&app2.state::<AppState>(), &version_id);
        let lib_dir = base.join("lib");
        // ① 引擎 dump:临时目录内执行,产物 extension_api.json
        let dump_dir = std::env::temp_dir().join(format!("gpm-doc-dump-{task_id}"));
        let _ = std::fs::create_dir_all(&dump_dir);
        let out = std::process::Command::new(&exe_path)
            .args(["--headless", "--dump-extension-api-with-docs", "--path"])
            .arg(&dump_dir)
            .output();
        let api_path = dump_dir.join("extension_api.json");
        match out {
            Ok(o) if o.status.success() && api_path.is_file() => {}
            Ok(o) => {
                let tail = String::from_utf8_lossy(&o.stderr);
                set(taskqueue::Status::Error, Some(format!("引擎 dump 失败:{}", tail.lines().last().unwrap_or(""))), serde_json::json!({}));
                let _ = std::fs::remove_dir_all(&dump_dir);
                return Err(());
            }
            Err(e) => {
                set(taskqueue::Status::Error, Some(format!("引擎启动失败:{e}")), serde_json::json!({}));
                return Err(());
            }
        }
        // ② 翻译(缓存优先;force 时删缓存重新拉)
        set(taskqueue::Status::Running, None, serde_json::json!({ "phase": "translating" }));
        if force_translation.unwrap_or(false) {
            let _ = std::fs::remove_file(po_cache_path(&base));
        }
        let tag = version_id.split('/').next_back().unwrap_or("").to_string();
        let proxy = versions.proxy.lock().unwrap().clone();
        let po = fetch_po(proxy, &base, &tag).await.unwrap_or_default();
        // ③ 解析 + 切片(解析 12MB 是纯 CPU,放 spawn_blocking)
        set(taskqueue::Status::Running, None, serde_json::json!({ "phase": "parsing" }));
        let api_text = match std::fs::read_to_string(&api_path) {
            Ok(t) => t,
            Err(e) => { set(taskqueue::Status::Error, Some(format!("读取 dump 失败:{e}")), serde_json::json!({})); return Err(()); }
        };
        let api: Value = match serde_json::from_str(&api_text) {
            Ok(v) => v,
            Err(e) => { set(taskqueue::Status::Error, Some(format!("extension_api.json 解析失败:{e}")), serde_json::json!({})); return Err(()); }
        };
        let build = match tauri::async_runtime::spawn_blocking(move || godot_workshop::docs::build_library(&api, &po, &lib_dir)).await {
            Ok(r) => r,
            Err(e) => { set(taskqueue::Status::Error, Some(format!("构建任务失败:{e}")), serde_json::json!({})); return Err(()); }
        };
        let _ = std::fs::remove_dir_all(&dump_dir);
        match build {
            Ok((count, _index)) => {
                let st2 = app2.state::<AppState>();
                let mut store = st2.store.lock().unwrap();
                let _ = store.put(&serde_json::json!({
                    "_id": format!("godot/docs/{version_id}"),
                    "versionId": version_id, "status": "ready", "classCount": count,
                    "builtAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,
                }));
                set(taskqueue::Status::Done, None, serde_json::json!({ "classes": count }));
                Ok(())
            }
            Err(e) => { set(taskqueue::Status::Error, Some(e), serde_json::json!({})); Err(()) }
        }
    }
    .await;
    Ok(serde_json::json!({ "ok": result.is_ok(), "taskId": task_id.to_string() }))
}

#[tauri::command]
async fn docs_import(state: State<'_, AppState>, json_path: String, tag: Option<String>) -> Result<Value, ()> {
    let text = std::fs::read_to_string(&json_path).map_err(|_| ())?;
    let api: Value = serde_json::from_str(&text).map_err(|_| ())?;
    let version_id = format!("godot/docs-import/{}", tag.unwrap_or_else(|| {
        api.get("header").and_then(|h| h.get("version_full_name")).and_then(|v| v.as_str()).unwrap_or("imported").to_string()
    }));
    let base = docs_base_dir(&state, &version_id);
    let po = fetch_po(None, &base, &version_id).await.unwrap_or_default();
    match godot_workshop::docs::build_library(&api, &po, &base.join("lib")) {
        Ok((count, _)) => {
            let mut store = state.store.lock().unwrap();
            let _ = store.put(&serde_json::json!({
                "_id": format!("godot/docs/{version_id}"), "versionId": version_id,
                "status": "ready", "classCount": count,
                "builtAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,
            }));
            Ok(serde_json::json!({ "ok": true, "versionId": version_id, "classes": count }))
        }
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[tauri::command]
fn docs_library_status(state: State<AppState>, version_id: String) -> Option<Value> {
    state.store.lock().unwrap().get(&format!("godot/docs/{version_id}"))
}

#[tauri::command]
fn docs_list_classes(state: State<AppState>, version_id: String) -> Value {
    let base = docs_base_dir(&state, &version_id);
    match std::fs::read_to_string(base.join("lib").join("index.json")) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(index) => serde_json::json!({ "ok": true, "classes": index }),
            Err(e) => serde_json::json!({ "ok": false, "error": format!("索引损坏:{e}") }),
        },
        Err(_) => serde_json::json!({ "ok": false, "error": "文档库未生成" }),
    }
}

#[tauri::command]
fn docs_get_class(state: State<AppState>, version_id: String, class_name: String) -> Option<Value> {
    let base = docs_base_dir(&state, &version_id);
    std::fs::read_to_string(base.join("lib").join(format!("{class_name}.json")))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
}

#[tauri::command]
fn docs_search(state: State<AppState>, version_id: String, query: String, limit: Option<usize>) -> Vec<Value> {
    let base = docs_base_dir(&state, &version_id);
    let Ok(text) = std::fs::read_to_string(base.join("lib").join("index.json")) else { return vec![] };
    let index: Vec<Value> = serde_json::from_str(&text).unwrap_or_default();
    godot_workshop::docs::search_index(&index, &query, limit.unwrap_or(30))
}

#[tauri::command]
fn docs_search_full_text(state: State<AppState>, version_id: String, query: String, limit: Option<usize>) -> Vec<Value> {
    let base = docs_base_dir(&state, &version_id);
    godot_workshop::docs::search_full_text(&base.join("lib"), &query, limit.unwrap_or(30))
}

#[tauri::command]
fn docs_delete_library(state: State<AppState>, version_id: String) -> Value {
    let base = docs_base_dir(&state, &version_id);
    let _ = std::fs::remove_dir_all(&base);
    let mut store = state.store.lock().unwrap();
    if let Some(doc) = store.get(&format!("godot/docs/{version_id}")) {
        store.remove(&doc);
    }
    serde_json::json!({ "ok": true })
}

#[tauri::command]
fn docs_diff_libraries(state: State<AppState>, version_a: String, version_b: String) -> Value {
    let read_index = |vid: &str| -> std::collections::HashMap<String, Value> {
        let base = docs_base_dir(&state, vid);
        std::fs::read_to_string(base.join("lib").join("index.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok())
            .map(|list| {
                list.into_iter()
                    .filter_map(|e| {
                        let name = e.get("name")?.as_str()?.to_string();
                        Some((name, e))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let (a, b) = (read_index(&version_a), read_index(&version_b));
    let read_slice = |vid: &str, name: &str| -> Value {
        let base = docs_base_dir(&state, vid);
        std::fs::read_to_string(base.join("lib").join(format!("{name}.json")))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .unwrap_or(Value::Null)
    };
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    for (name, ea) in &a {
        match b.get(name) {
            None => added.push(json!(name)),
            Some(eb) => {
                let da = read_slice(&version_a, name);
                let db = read_slice(&version_b, name);
                if da != db {
                    changed.push(json!({ "name": name, "inheritsA": ea["inherits"], "inheritsB": eb["inherits"] }));
                }
            }
        }
    }
    for name in b.keys() {
        if !a.contains_key(name) {
            removed.push(json!(name));
        }
    }
    serde_json::json!({ "addedClasses": added, "removedClasses": removed, "changedClasses": changed })
}


#[tauri::command]
async fn fetch_releases_cmd(state: State<'_, AppState>, versions: State<'_, Versions>, force: bool) -> Result<Value, ()> {
    let base = std::env::temp_dir().join("gpm-releases-cache");
    let proxy = versions.proxy.lock().unwrap().clone();
    match godot_workshop::releases::fetch_releases(proxy, force, &base, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()).await {
        Ok((list, _stale)) => Ok(serde_json::json!({ "releases": list })),
        Err(e) => Ok(serde_json::json!({ "releases": [], "error": e })),
    }
}

#[tauri::command]
fn cancel_task(versions: State<Versions>, id: String) -> Value {
    let tid: u64 = id.parse().unwrap_or(0);
    serde_json::json!({ "ok": versions.book.lock().unwrap().cancel(tid) })
}

#[tauri::command]
fn dismiss_task(versions: State<Versions>, id: String) -> Value {
    let tid: u64 = id.parse().unwrap_or(0);
    serde_json::json!({ "ok": versions.book.lock().unwrap().remove(tid) })
}

// 资产列表命令(市场浏览;端点与 lib/assetapi.js 一致)
async fn store_get(client: &reqwest::Client, url: &str) -> Value {
    client.get(url).send().await.ok()
        .and_then(|r| async move { r.json::<Value>().await.ok() }.into()).is_some().then(|| Value::Null).unwrap_or(Value::Null)
}


// ---------- 市场浏览命令(端点与 lib/assetapi.js 一致) ----------

async fn store_json(proxy: Option<String>, url: &str) -> Result<Value, String> {
    let client = godot_workshop::http::client_with_proxy(proxy.as_deref())?;
    let resp = client.get(url).send().await.map_err(|e| format!("市场请求失败:{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("市场 HTTP {}", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| format!("市场解析失败:{e}"))
}

fn map_asset(a: &Value) -> Value {
    let asset_id = format!(
        "{}/{}",
        a.get("publisher").and_then(|p| p.get("slug")).and_then(|v| v.as_str()).unwrap_or(""),
        a.get("slug").and_then(|v| v.as_str()).unwrap_or("")
    );
    let tags: Vec<String> = a.get("tags").and_then(|v| v.as_array()).map(|t| {
        t.iter().filter_map(|x| x.get("slug").and_then(|s| s.as_str()).map(String::from)).collect()
    }).unwrap_or_default();
    serde_json::json!({
        "assetId": asset_id,
        "title": a.get("name").cloned().unwrap_or(Value::Null),
        "author": a.get("publisher").and_then(|p| p.get("name")).cloned().unwrap_or(Value::Null),
        "category": a.get("tags").and_then(|t| t.as_array()).and_then(|t| t.first()).and_then(|t| t.get("display_name")).cloned().unwrap_or(Value::Null),
        "tagSlugs": tags,
        "versionString": "",
        "godotVersion": "",
        "iconUrl": a.get("thumbnail").cloned().unwrap_or(Value::Null),
        "description": a.get("description").cloned().unwrap_or(Value::Null),
        "storeUrl": a.get("store_url").cloned().unwrap_or(Value::Null),
    })
}

async fn market_page(proxy: Option<String>, query: &str, page: u64) -> Result<Value, String> {
    let v = store_json(proxy, query).await?;
    let result: Vec<Value> = v.as_array().map(|a| a.iter().map(map_asset).collect()).unwrap_or_default();
    Ok(serde_json::json!({ "result": result, "page": page, "pages": 1 }))
}

#[tauri::command]
async fn search_assets(state: State<'_, AppState>, versions: State<'_, Versions>, filter: String, godot_version: Option<String>, page: Option<u64>, asset_type: Option<u64>) -> Result<Value, ()> {
    let proxy = versions.proxy.lock().unwrap().clone();
    let t = asset_type.unwrap_or(0);
    let mut q = format!(
        "https://store.godotengine.org/api/v1/search/query/?query={}&type={}&require_release=true&page={}&batch_size=20",
        filter, t, page.unwrap_or(1)
    );
    if let Some(gv) = godot_version.filter(|s| !s.is_empty()) {
        q.push_str(&format!("&godot_version={gv}"));
    }
    let v = store_json(proxy, &q).await.unwrap_or(serde_json::json!([]));
    let empty = Vec::new();
    let rows = v.get("result").and_then(|r| r.as_array()).unwrap_or(&empty);
    let count = v.get("count").and_then(|c| c.as_u64()).unwrap_or(0);
    let page_n = page.unwrap_or(1);
    Ok(serde_json::json!({
        "result": rows.iter().map(map_asset).collect::<Vec<_>>(),
        "page": page_n,
        "pages": std::cmp::max(1, count.div_ceil(20)),
    }))
}

#[tauri::command]
async fn list_featured_cmd(versions: State<'_, Versions>) -> Result<Value, ()> {
    let proxy = versions.proxy.lock().unwrap().clone();
    let v = store_json(proxy, "https://store.godotengine.org/api/v1/assets/?type=0&featured_only=true&require_release=true&page_size=20").await.unwrap_or(serde_json::json!([]));
    Ok(Value::Array(v.as_array().map(|a| a.iter().map(map_asset).collect()).unwrap_or_default()))
}

#[tauri::command]
async fn list_all_assets_cmd(versions: State<'_, Versions>, page: Option<u64>) -> Result<Value, ()> {
    let proxy = versions.proxy.lock().unwrap().clone();
    let pg = page.unwrap_or(1);
    market_page(proxy, &format!("https://store.godotengine.org/api/v1/assets/?type=0&require_release=true&page_size=20&page={pg}"), pg).await.map_err(|_| ())
}

#[tauri::command]
async fn list_new_assets_cmd(versions: State<'_, Versions>) -> Result<Value, ()> {
    let proxy = versions.proxy.lock().unwrap().clone();
    let v = store_json(proxy, "https://store.godotengine.org/api/v1/assets/?type=0&require_release=true&order=-create_date&page_size=40").await.unwrap_or(serde_json::json!([]));
    Ok(Value::Array(v.as_array().map(|a| a.iter().map(map_asset).collect()).unwrap_or_default()))
}

#[tauri::command]
async fn list_recently_updated_cmd(versions: State<'_, Versions>) -> Result<Value, ()> {
    let proxy = versions.proxy.lock().unwrap().clone();
    let v = store_json(proxy, "https://store.godotengine.org/api/v1/assets/?type=0&require_release=true&order=-modified_date&page_size=40").await.unwrap_or(serde_json::json!([]));
    Ok(Value::Array(v.as_array().map(|a| a.iter().map(map_asset).collect()).unwrap_or_default()))
}

#[tauri::command]
async fn list_project_assets_cmd(versions: State<'_, Versions>, page: Option<u64>) -> Result<Value, ()> {
    let proxy = versions.proxy.lock().unwrap().clone();
    let pg = page.unwrap_or(1);
    market_page(proxy, &format!("https://store.godotengine.org/api/v1/assets/?type=1&require_release=true&order=-modified_date&page_size=20&page={pg}"), pg).await.map_err(|_| ())
}

#[tauri::command]
fn restore_backup(state: State<AppState>, backup_id: String, mode: String, dest_dir: Option<String>, new_name: Option<String>) -> Value {
    let mut st = state.store.lock().unwrap();
    let Some(rec) = st.get(&backup_id) else { return serde_json::json!({ "ok": false, "error": "备份记录不存在" }); };
    let Some(src) = rec.get("destPath").and_then(|v| v.as_str()).map(std::path::PathBuf::from) else {
        return serde_json::json!({ "ok": false, "error": "记录缺少路径" });
    };
    if mode == "overwrite" {
        // 项目当前路径覆盖恢复
        let Some(pid) = rec.get("projectId").and_then(|v| v.as_str()).map(String::from) else {
            return serde_json::json!({ "ok": false, "error": "记录缺少项目 id" });
        };
        let Some(proj) = st.get(&pid) else { return serde_json::json!({ "ok": false, "error": "原项目已删除" }); };
        let Some(path) = proj.get("path").and_then(|v| v.as_str()).map(std::path::PathBuf::from) else {
            return serde_json::json!({ "ok": false, "error": "项目缺少路径" });
        };
        match godot_workshop::backup::restore(&src, &path, true) {
            Ok(n) => serde_json::json!({ "ok": true, "entries": n }),
            Err(e) => serde_json::json!({ "ok": false, "error": e }),
        }
    } else {
        let Some(dest_dir) = dest_dir else { return serde_json::json!({ "ok": false, "error": "缺少恢复位置" }); };
        let name = new_name.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| format!("restored-{backup_id}"));
        let dir = std::path::PathBuf::from(&dest_dir).join(&name);
        if dir.exists() { return serde_json::json!({ "ok": false, "error": format!("目录已存在:{name}") }); }
        match godot_workshop::backup::restore(&src, &dir, false) {
            Ok(n) => {
                // 登记为新项目(复用 projects 的解析与 id 规则)
                let id = godot_workshop::projects::project_doc_id(&dir);
                let text = std::fs::read_to_string(dir.join("project.godot")).unwrap_or_default();
                let (pname, cfg, ev, _icon, _pl) = godot_workshop::projects::parse_project_godot_text(&text);
                let versions = st.all_docs("godot/version/");
                let vid = godot_workshop::projects::match_version(&(cfg, ev.clone()), &versions);
                let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
                let project = serde_json::json!({
                    "id": id, "path": dir.to_string_lossy(),
                    "name": if pname.is_empty() { name.clone() } else { pname },
                    "configVersion": cfg, "engineVersion": ev, "versionId": vid,
                    "favorite": false, "openCount": 0, "addedAt": now_ms,
                });
                let res = st.put(&project);
                if res.get("ok") == Some(&serde_json::json!(true)) {
                    serde_json::json!({ "ok": true, "entries": n, "newProjectName": name, "newProjectId": id })
                } else {
                    serde_json::json!({ "ok": false, "error": "恢复完成但登记失败" })
                }
            }
            Err(e) => serde_json::json!({ "ok": false, "error": e }),
        }
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?.join("godot-workshop");
            let db = store::Store::open(&dir.join("db.json"));
            app.manage(AppState { store: Mutex::new(db) });
            app.manage(versions::Versions {
                book: Mutex::new(crate::taskqueue::TaskBook::new()),
                proxy: Mutex::new(None),
                root: Mutex::new(None),
            });
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![probe, db_get, db_put, db_remove, db_all_docs, run_network_diagnostics, versions::download_and_install, add_project, scan_projects, remove_project, export_template_status, install_export_templates, uninstall_export_templates, probe_template_source, list_template_features, validate_template_config, apply_template_preset, check_template_build_tools, build_template_pack, cancel_template_build_task, dismiss_template_build_task, download_template_source, cancel_template_source_download, scan_project_tree, read_project_text, write_project_text, move_paths_to_trash, hash_paths, launch_project, backup_project, verify_backup, delete_backup, prune_backups, list_export_presets, create_project, uninstall_addon, install_asset, run_export, cancel_export_task, docs_generate, docs_import, docs_library_status, docs_list_classes, docs_get_class, docs_search, docs_search_full_text, docs_delete_library, docs_diff_libraries, fetch_releases_cmd, cancel_task, dismiss_task, search_assets, list_featured_cmd, list_all_assets_cmd, list_new_assets_cmd, list_recently_updated_cmd, list_project_assets_cmd, restore_backup])
        .run(tauri::generate_context!())
        .expect("tauri 应用启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个只装了一条项目文档的 store。夹具目录名带 pid **+ 纳秒**:同一进程里的并行用例
    /// 会用同一个 project_id 各造一份(两个用例都要 'godot/project/ok'),只带 pid 就会互删。
    fn store_with_project(id: &str, path: Option<&str>) -> (Mutex<store::Store>, std::path::PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("gpm-main-{}-{}-{}", id, std::process::id(), nanos));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut db = store::Store::open(&dir.join("db.json"));
        let doc = match path {
            Some(p) => json!({ "_id": id, "path": p }),
            None => json!({ "_id": id }),
        };
        db.put(&doc);
        (Mutex::new(db), dir)
    }

    /// D-1 的命令层那一半:读 / 写 / 删三命令共用 project_doc_root_of,它**不查盘** ——
    /// JS 的 projectRoot() 只做 store 查询,目录被删时是库里的包含闸 canonicalize 失败,
    /// 给 '路径无法解析'。命令层若先 is_dir 拦一道,同一件事两端就各说一句话了。
    #[test]
    fn project_doc_root_of_returns_the_recorded_path_without_probing_disk() {
        let live = std::env::temp_dir().join(format!("gpm-main-live-{}-{}", std::process::id(), std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let _ = std::fs::remove_dir_all(&live);
        std::fs::create_dir_all(&live).unwrap();
        let (store, tmp) = store_with_project("godot/project/ok", Some(&live.to_string_lossy()));
        assert_eq!(project_doc_root_of(&store, "godot/project/ok").unwrap(), live, "在世的根原样返回");
        let gone = std::path::PathBuf::from(format!("{}-gone", live.to_string_lossy()));
        let dead = store_with_project("godot/project/dead", Some(&gone.to_string_lossy()));
        assert_eq!(project_doc_root_of(&dead.0, "godot/project/dead"), Ok(gone),
            "目录被删也要把根交下去,由库里的闸报 '路径无法解析'");
        assert_eq!(project_doc_root_of(&store, "godot/project/none").unwrap_err(), "项目不存在");
        let nopath = store_with_project("godot/project/nopath", None);
        assert_eq!(project_doc_root_of(&nopath.0, "godot/project/nopath").unwrap_err(), "项目不存在",
            "文档在但没记 path → 与 JS 的 `!root` 同句");
        let empty = store_with_project("godot/project/empty", Some(""));
        assert_eq!(project_doc_root_of(&empty.0, "godot/project/empty").unwrap_err(), "项目不存在",
            "path 为空串视同没记(JS 侧 '' 是 falsy)");
        std::fs::remove_dir_all(&live).ok();
        std::fs::remove_dir_all(&tmp).ok();
        std::fs::remove_dir_all(&dead.1).ok();
        std::fs::remove_dir_all(&nopath.1).ok();
        std::fs::remove_dir_all(&empty.1).ok();
    }

    /// 遍历命令仍走带 existsSync 的那一条(与 JS 的 scanProjectTree 同形,回 '项目目录已不存在')。
    /// 取根委托给 `project_doc_root_of`,所以**空串 path 的形态与 JS 对齐**:JS 的
    /// `projectRoot()` 里 `doc.path` 空串是 falsy → `scanProjectTree` 回 '项目不存在'
    /// (inspectfs.js:243-244),不是 '项目目录已不存在'。
    #[test]
    fn project_root_of_still_reports_missing_directory_for_scan() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let live = std::env::temp_dir().join(format!("gpm-main-scan-{}-{}", std::process::id(), nanos));
        let _ = std::fs::remove_dir_all(&live);
        std::fs::create_dir_all(&live).unwrap();
        let (store, tmp) = store_with_project("godot/project/ok", Some(&live.to_string_lossy()));
        assert_eq!(project_root_of(&store, "godot/project/ok").unwrap(), live);
        let dead = store_with_project("godot/project/dead", Some("/definitely/not/here"));
        assert_eq!(project_root_of(&dead.0, "godot/project/dead").unwrap_err(), "项目目录已不存在");
        assert_eq!(project_root_of(&store, "godot/project/none").unwrap_err(), "项目不存在");
        let empty = store_with_project("godot/project/empty", Some(""));
        assert_eq!(project_root_of(&empty.0, "godot/project/empty").unwrap_err(), "项目不存在",
            "path 为空串 → 与 JS 的 `!root` 同句(旧实现在这里是 '项目目录已不存在',双端各说一句话)");
        let nopath = store_with_project("godot/project/nopath", None);
        assert_eq!(project_root_of(&nopath.0, "godot/project/nopath").unwrap_err(), "项目不存在",
            "文档在但没记 path → 同样走委托后的统一出口");
        std::fs::remove_dir_all(&live).ok();
        std::fs::remove_dir_all(&tmp).ok();
        std::fs::remove_dir_all(&dead.1).ok();
        std::fs::remove_dir_all(&empty.1).ok();
        std::fs::remove_dir_all(&nopath.1).ok();
    }
}
