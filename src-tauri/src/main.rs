// 桌面版 2.0 主进程(Tauri 2 + Rust 核心)。
//
// T2 起步:JSON 文档库(store.rs,与 Electron 版 dbdoc.js 同语义同文件格式)以命令形式
// 暴露给渲染层(db_get/db_put/db_remove/db_all_docs);领域命令按
// docs/tauri-migration-plan.md 的 T2-T4 逐域落位,与 lib/ 同名域一一对应。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::sync::Mutex;
use tauri::{Manager, State};

// extract/taskqueue 的公开函数由 T3/T4 领域命令消费,先落测试与实现
#[allow(dead_code)]
mod extract;
mod http;
#[allow(dead_code)]
mod releases;
mod store;
#[allow(dead_code)]
mod taskqueue;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![probe, db_get, db_put, db_remove, db_all_docs, run_network_diagnostics])
        .run(tauri::generate_context!())
        .expect("tauri 应用启动失败");
}
