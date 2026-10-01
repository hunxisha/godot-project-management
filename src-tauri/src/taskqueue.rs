// 任务队列底座:downloadAndInstall / installExportTemplates / runExport / docsGenerate
// 四个域共用(对齐 lib/taskqueue.js 的语义面:单调 id、排队/运行/终态、取消标记、快照)。
// 串行执行由各领域驱动;本模块只管簿记与取消信号,快照经 Tauri 事件推给渲染层(watchX)。
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Queued,
    Running,
    Done,
    Error,
    Canceled,
}

impl Status {
    pub fn as_str(&self) -> &'static str {
        match self {
            Status::Queued => "queued",
            Status::Running => "running",
            Status::Done => "done",
            Status::Error => "error",
            Status::Canceled => "canceled",
        }
    }
    pub fn is_terminal(&self) -> bool {
        matches!(self, Status::Done | Status::Error | Status::Canceled)
    }
}

#[derive(Debug, Clone)]
pub struct Task {
    pub id: u64,
    pub kind: String,
    pub status: Status,
    pub error: Option<String>,
    /// 领域自有载荷(版本 tag、projectId 等),快照时原样带出
    pub payload: Value,
    /// 运行中收到取消请求:由领域在分片边界检查并落实
    pub cancel_requested: bool,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct TaskBook {
    tasks: Vec<Task>,
}

impl TaskBook {
    pub fn new() -> TaskBook {
        TaskBook { tasks: Vec::new() }
    }

    pub fn push(&mut self, kind: &str, payload: Value) -> u64 {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        self.tasks.push(Task {
            id,
            kind: kind.to_string(),
            status: Status::Queued,
            error: None,
            payload,
            cancel_requested: false,
        });
        id
    }

    pub fn get_mut(&mut self, id: u64) -> Option<&mut Task> {
        self.tasks.iter_mut().find(|t| t.id == id)
    }

    /// 取消:排队中直接置 canceled;运行中只打标记(领域在分片边界落实后置 canceled);
    /// 终态任务返回 false(对齐 cancelBackupTask「进入不可回滚阶段后返回 false」的口径)
    pub fn cancel(&mut self, id: u64) -> bool {
        let Some(t) = self.get_mut(id) else { return false };
        match t.status {
            Status::Queued => {
                t.status = Status::Canceled;
                true
            }
            Status::Running => {
                t.cancel_requested = true;
                true
            }
            Status::Done | Status::Error | Status::Canceled => false,
        }
    }

    pub fn remove(&mut self, id: u64) -> bool {
        let before = self.tasks.len();
        self.tasks.retain(|t| t.id != id);
        self.tasks.len() != before
    }

    /// 快照:终态排后、同状态按 id 倒序(最新在前),与渲染层任务栏的预期一致
    pub fn snapshot(&self) -> Vec<Value> {
        let mut sorted: Vec<&Task> = self.tasks.iter().collect();
        sorted.sort_by(|a, b| b.id.cmp(&a.id));
        sorted
            .iter()
            .map(|t| {
                json!({
                    "id": t.id.to_string(),
                    "kind": t.kind,
                    "status": t.status.as_str(),
                    "error": t.error,
                    "cancelRequested": t.cancel_requested,
                    "payload": t.payload,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_are_monotonic() {
        let mut b = TaskBook::new();
        let a = b.push("download", json!({ "tag": "4.7" }));
        let c = b.push("download", json!({ "tag": "4.8" }));
        assert!(c > a, "id 单调递增");
    }

    #[test]
    fn cancel_semantics() {
        let mut b = TaskBook::new();
        let queued = b.push("download", json!({}));
        assert!(b.cancel(queued), "排队中可取消");
        assert_eq!(b.get_mut(queued).unwrap().status, Status::Canceled);

        let running = b.push("download", json!({}));
        b.get_mut(running).unwrap().status = Status::Running;
        assert!(b.cancel(running), "运行中打取消标记");
        assert!(b.get_mut(running).unwrap().cancel_requested, "标记置位");
        assert!(b.cancel(running), "运行中重复取消仍返回 true(幂等)");

        let done = b.push("download", json!({}));
        b.get_mut(done).unwrap().status = Status::Done;
        assert!(!b.cancel(done), "终态不可取消");
        assert!(!b.cancel(99999), "不存在的 id 返回 false");
    }

    #[test]
    fn snapshot_shape_and_order() {
        let mut b = TaskBook::new();
        let a = b.push("download", json!({ "tag": "a" }));
        let c = b.push("templates", json!({ "tag": "c" }));
        let snap = b.snapshot();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0]["id"], c.to_string(), "最新在前");
        assert_eq!(snap[1]["id"], a.to_string());
        assert_eq!(snap[1]["status"], "queued");
        assert_eq!(snap[1]["payload"]["tag"], "a", "载荷原样带出");
    }

    #[test]
    fn remove_only_removes_target() {
        let mut b = TaskBook::new();
        let a = b.push("download", json!({}));
        let _ = b.push("download", json!({}));
        assert!(b.remove(a));
        assert!(!b.remove(a), "重复移除返回 false");
        assert_eq!(b.snapshot().len(), 1);
    }
}
