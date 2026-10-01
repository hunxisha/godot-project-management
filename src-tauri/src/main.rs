// 桌面版 2.0 主进程(Tauri 2 + Rust 核心)。
//
// T2 起步:JSON 文档库(store.rs,与 Electron 版 dbdoc.js 同语义同文件格式)以命令形式
// 暴露给渲染层(db_get/db_put/db_remove/db_all_docs);领域命令按
// docs/tauri-migration-plan.md 的 T2-T4 逐域落位,与 lib/ 同名域一一对应。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::sync::Mutex;
use tauri::{Manager, State};

mod store;

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

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?.join("godot-workshop");
            let db = store::Store::open(&dir.join("db.json"));
            app.manage(AppState { store: Mutex::new(db) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![probe, db_get, db_put, db_remove, db_all_docs])
        .run(tauri::generate_context!())
        .expect("tauri 应用启动失败");
}
