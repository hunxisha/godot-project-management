// 桌面版 2.0 主进程(Tauri 2 + Rust 核心)。
//
// T0 骨架:窗口 + 探针命令,证明壳可用;领域命令(store/http/backup/docs…)按
// docs/tauri-migration-plan.md 的 T2-T4 逐域落位,与 lib/ 同名域一一对应。
// 渲染层加载与 Electron 版同一份构建产物(src-ztools/dist),bridge 底层在阶段 A 后切 invoke()。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 无头自检探针:smoke 起来后验证 invoke 通道与方法计数(对齐 smoke:desktop 的口径)
#[tauri::command]
fn probe() -> serde_json::Value {
    serde_json::json!({ "ok": true, "host": "tauri", "services": 0 })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![probe])
        .run(tauri::generate_context!())
        .expect("tauri 应用启动失败");
}
