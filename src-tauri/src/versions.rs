// 引擎版本安装域:入队 → 续传下载 → 安全解压 → 落库目录。
// 目录布局对齐 lib/install.js:versionsRoot/<tag>/<variant>/ 内含解压产物;
// 进度经 "tasks://snapshot" 事件推送,渲染层 watchTasks 拿到同形快照。
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::taskqueue::{Status, TaskBook};

pub struct Versions {
    pub book: Mutex<TaskBook>,
    pub proxy: Mutex<Option<String>>,
    pub root: Mutex<Option<PathBuf>>,
}

fn emit_snapshot(app: &AppHandle) {
    // 统一走 tpl::exec 的合并出口:自编译任务(kind=tplbuild)不在本本上,
    // 各域各发各的快照会让对方的任务在渲染层一闪一闪地消失
    crate::tpl::exec::emit_snapshot(app);
}

/// 从归档资产里挑出对应平台/变体的安装包(对齐 lib/releases.js 的文件名规则)
pub fn pick_asset<'a>(assets: &'a [Value], platform: &str) -> Option<&'a Value> {
    let need = match platform {
        "windows" => "win64.exe.zip",
        "macos" => "macos.universal.zip",
        "linux" => "linux.x86_64.zip",
        _ => return None,
    };
    assets
        .iter()
        .find(|a| a.get("name").and_then(|v| v.as_str()).map(|n| n.contains(need)).unwrap_or(false))
}

/// 执行一次安装(由命令在后台驱动);返回最终状态
pub async fn run_install(app: AppHandle, task_id: u64, url: String, dest_root: PathBuf, dir_name: String, proxy: Option<String>) {
    let v = app.state::<Versions>();
    let set = |st: Status, err: Option<String>, payload_patch: Value| {
        if let Some(t) = v.book.lock().unwrap().get_mut(task_id) {
            t.status = st;
            t.error = err;
            if let (Some(obj), Some(patch)) = (t.payload.as_object_mut(), payload_patch.as_object()) {
                for (k, val) in patch {
                    obj.insert(k.clone(), val.clone());
                }
            }
        }
        emit_snapshot(&app);
    };

    set(Status::Running, None, json!({}));
    let zip_path = dest_root.join(format!("__dl_{task_id}.zip"));
    let mut last_emit = 0u64;
    let dl = crate::http::download(
        crate::http::DownloadOptions { url, dest: zip_path.clone(), proxy, sha256: None },
        |received, total| {
            if received - last_emit > 2 * 1024 * 1024 || total.is_some() {
                last_emit = received;
                if let Some(t) = v.book.lock().unwrap().get_mut(task_id) {
                    t.payload["received"] = json!(received);
                    if let Some(t2) = total { t.payload["totalSize"] = json!(t2); }
                }
            }
        },
    )
    .await;
    if let Err(e) = dl {
        let canceled = v.book.lock().unwrap().get_mut(task_id).map(|t| t.cancel_requested).unwrap_or(false);
        set(if canceled { Status::Canceled } else { Status::Error }, Some(e), json!({}));
        let _ = std::fs::remove_file(&zip_path);
        return;
    }
    let out_dir = dest_root.join(&dir_name);
    match crate::extract::unzip(&zip_path, &out_dir) {
        Ok(n) => {
            let _ = std::fs::remove_file(&zip_path);
            set(Status::Done, None, json!({ "installDir": out_dir.to_string_lossy(), "files": n }))
        }
        Err(e) => {
            let _ = std::fs::remove_file(&zip_path);
            set(Status::Error, Some(e), json!({}))
        }
    }
}

#[tauri::command]
pub fn download_and_install(
    app: AppHandle,
    state: State<Versions>,
    params: Value,
    opts: Value,
) -> Value {
    let root: PathBuf = opts
        .get("versionsRoot")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.root.lock().unwrap().clone().unwrap_or_default());
    let platform = params.get("platform").and_then(|v| v.as_str()).unwrap_or("windows").to_string();
    let tag = params.get("tag").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let variant = params.get("variant").and_then(|v| v.as_str()).unwrap_or("standard");
    let url = params
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let total = params.get("totalSize").and_then(|v| v.as_u64()).unwrap_or(0);
    if tag.is_empty() || url.is_empty() {
        return json!({ "ok": false, "error": "缺少 tag 或 url" });
    }
    let dir_name = format!("{tag}-{variant}");
    let task_id = state.book.lock().unwrap().push(
        "download",
        json!({ "tag": tag, "variant": variant, "platform": platform, "totalSize": total, "received": 0 }),
    );
    let app2 = app.clone();
    let proxy = state.proxy.lock().unwrap().clone();
    tauri::async_runtime::spawn(async move {
        run_install(app2, task_id, url, root, dir_name, proxy).await;
    });
    emit_snapshot(&app);
    json!({ "ok": true, "taskId": task_id.to_string() })
}

/// 后台任务结束后的取消检查辅助(领域在分片边界调用)
pub fn cancel_requested(v: &Versions, id: u64) -> bool {
    v.book.lock().unwrap().get_mut(id).map(|t| t.cancel_requested).unwrap_or(false)
}

pub fn install_dir(root: &Path, tag: &str, variant: &str) -> PathBuf {
    root.join(format!("{tag}-{variant}"))
}
