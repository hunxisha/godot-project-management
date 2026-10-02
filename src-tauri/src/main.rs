// 桌面版 2.0 主进程(Tauri 2 + Rust 核心)。
//
// T2 起步:JSON 文档库(store.rs,与 Electron 版 dbdoc.js 同语义同文件格式)以命令形式
// 暴露给渲染层(db_get/db_put/db_remove/db_all_docs);领域命令按
// docs/tauri-migration-plan.md 的 T2-T4 逐域落位,与 lib/ 同名域一一对应。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use godot_workshop::{backup, extract, fsutil, http, launcher, projects, releases, store, taskqueue, templates, versions};
use serde_json::Value;
use godot_workshop::versions::Versions;
use tauri::{AppHandle, Emitter};
use std::path::Path;
use std::sync::Mutex;
use tauri::{Manager, State};

struct AppState {
    store: Mutex<store::Store>,
}

/// 无头自检探针:验证 invoke 通道与 store 就位(对齐 smoke:desktop 的口径)
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
    if let Some(v) = app.try_state::<Versions>() {
        let snap = v.book.lock().unwrap().snapshot();
        let _ = app.emit("tasks://snapshot", snap);
    }
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

#[tauri::command]
fn install_export_templates(app: AppHandle, state: State<Versions>, exe_path: String, tag: String, url: String) -> Value {
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
        let tpz = stage.with_extension("tpz");
        let dl = godot_workshop::http::download(
            godot_workshop::http::DownloadOptions { url, dest: tpz.clone(), proxy, sha256: None },
            |received, _t| { if let Some(t) = v.book.lock().unwrap().get_mut(task_id) { t.payload["received"] = serde_json::json!(received); } },
        ).await;
        if let Err(e) = dl { set(taskqueue::Status::Error, Some(e), serde_json::json!({})); let _ = std::fs::remove_dir_all(&stage); return; }
        let ex = godot_workshop::extract::unzip(&tpz, &stage);
        let _ = std::fs::remove_file(&tpz);
        if let Err(e) = ex { set(taskqueue::Status::Error, Some(e), serde_json::json!({})); let _ = std::fs::remove_dir_all(&stage); return; }
        let tag_now = v.book.lock().unwrap().get_mut(task_id).map(|t| t.payload["tag"].as_str().unwrap_or("").to_string()).unwrap_or_default();
        match godot_workshop::templates::install_from_stage(&stage, &base, &tag_now, platform) {
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
        .invoke_handler(tauri::generate_handler![probe, db_get, db_put, db_remove, db_all_docs, run_network_diagnostics, versions::download_and_install, add_project, scan_projects, remove_project, export_template_status, install_export_templates, uninstall_export_templates, launch_project, backup_project, verify_backup, delete_backup, prune_backups, list_export_presets])
        .run(tauri::generate_context!())
        .expect("tauri 应用启动失败");
}
