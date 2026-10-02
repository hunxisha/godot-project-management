// 桌面版 2.0 主进程(Tauri 2 + Rust 核心)。
//
// T2 起步:JSON 文档库(store.rs,与 Electron 版 dbdoc.js 同语义同文件格式)以命令形式
// 暴露给渲染层(db_get/db_put/db_remove/db_all_docs);领域命令按
// docs/tauri-migration-plan.md 的 T2-T4 逐域落位,与 lib/ 同名域一一对应。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use godot_workshop::{extract, http, projects, releases, store, taskqueue, versions};
use serde_json::Value;
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
        .invoke_handler(tauri::generate_handler![probe, db_get, db_put, db_remove, db_all_docs, run_network_diagnostics, versions::download_and_install, add_project, scan_projects, remove_project])
        .run(tauri::generate_context!())
        .expect("tauri 应用启动失败");
}
