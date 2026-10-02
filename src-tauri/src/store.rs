// JSON 文档库:对齐 ZTools 宿主 db 的 CouchDB 风格语义。
// 契约(与 lib/store.js 逐条对应,tests 节同款断言):
//   get(id)         → 文档深拷贝;不存在 None
//   put(doc)        → 成功 {"ok":true,"id","rev"};失败 {"error":true,"name","message"}
//                     更新须 _rev 匹配否则 conflict;新建不得带 _rev;无 _id 报 bad_request
//   remove(doc)     → 按传入 _id/_rev 删除;缺失 not_found;_rev 不匹配 conflict
//   all_docs(prefix)→ 按 _id 前缀过滤、按 _id 排序的深拷贝数组
// 持久化:写穿(临时文件 + 原子改名),写入前把旧文件轮转为 .bak(上一代);
// 主文件损坏回滚 .bak,两者全坏则空库起步并把坏件留作 .corrupt。
// 文件格式与已退役的 1.x 桌面版一致(老用户迁移 = 拷一个 db.json)。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const REV_PREFIX: &str = "rev-";

#[derive(Serialize, Deserialize, Default)]
struct Persisted {
    seq: u64,
    /// BTreeMap 天然按 _id 有序,all_docs 直接遍历即是排序结果
    docs: BTreeMap<String, Value>,
}

pub struct Store {
    path: PathBuf,
    state: Persisted,
}

fn err(name: &str, message: &str) -> Value {
    serde_json::json!({ "error": true, "name": name, "message": message })
}

impl Store {
    /// 打开(必要时创建)一个库文件;损坏时按 .bak → 空库 的顺序回退
    pub fn open(path: &Path) -> Store {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let state = Self::load(path);
        Store { path: path.to_path_buf(), state }
    }

    fn parse(raw: &str) -> Option<Persisted> {
        let p: Persisted = serde_json::from_str(raw).ok()?;
        Some(p)
    }

    fn load(path: &Path) -> Persisted {
        let bak = path.with_extension("json.bak");
        let corrupt = path.with_extension("json.corrupt");
        let read = |p: &Path| fs::read_to_string(p).ok();
        if let Some(raw) = read(path) {
            if let Some(parsed) = Self::parse(&raw) {
                return parsed;
            }
            // 主文件损坏:留档 .corrupt(覆盖旧的),再试 .bak
            let _ = fs::copy(path, &corrupt);
            if let Some(bak_raw) = read(&bak) {
                if let Some(parsed) = Self::parse(&bak_raw) {
                    return parsed;
                }
            }
            return Persisted::default();
        }
        // 主文件不存在:仅当 .bak 可解析才沿用(异常中断后的兜底)
        if let Some(bak_raw) = read(&bak) {
            if let Some(parsed) = Self::parse(&bak_raw) {
                return parsed;
            }
        }
        Persisted::default()
    }

    fn persist(&self) -> std::io::Result<()> {
        if self.path.exists() {
            let _ = fs::copy(&self.path, self.path.with_extension("json.bak"));
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string(&self.state).expect("序列化失败"))?;
        fs::rename(&tmp, &self.path)
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.state.docs.get(id).cloned()
    }

    pub fn put(&mut self, doc: &Value) -> Value {
        let Some(id) = doc.get("_id").and_then(|v| v.as_str()) else {
            return err("bad_request", "put 需要 string 类型的 _id");
        };
        if id.is_empty() {
            return err("bad_request", "put 需要 string 类型的 _id");
        }
        let existing = self.state.docs.get(id);
        let incoming_rev = doc.get("_rev").and_then(|v| v.as_str());
        let conflict = match existing {
            Some(cur) => incoming_rev != cur.get("_rev").and_then(|v| v.as_str()),
            None => incoming_rev.is_some(),
        };
        if conflict {
            return err("conflict", "Document update conflict");
        }
        self.state.seq += 1;
        let rev = format!("{REV_PREFIX}{}", self.state.seq);
        let mut stored = doc.clone();
        stored["_id"] = Value::from(id);
        stored["_rev"] = Value::from(rev.as_str());
        self.state.docs.insert(id.to_string(), stored);
        if let Err(e) = self.persist() {
            return err("io_error", &format!("落盘失败:{e}"));
        }
        serde_json::json!({ "ok": true, "id": id, "rev": rev })
    }

    pub fn remove(&mut self, doc: &Value) -> Value {
        let Some(id) = doc.get("_id").and_then(|v| v.as_str()) else {
            return err("bad_request", "remove 需要 string 类型的 _id");
        };
        let Some(existing) = self.state.docs.get(id) else {
            return err("not_found", "missing");
        };
        if incoming_rev_of(doc) != existing.get("_rev").and_then(|v| v.as_str()) {
            return err("conflict", "Document update conflict");
        }
        let old_rev = existing.get("_rev").cloned().unwrap_or(Value::Null);
        self.state.docs.remove(id);
        if let Err(e) = self.persist() {
            return err("io_error", &format!("落盘失败:{e}"));
        }
        serde_json::json!({ "ok": true, "id": id, "rev": old_rev })
    }

    pub fn all_docs(&self, prefix: &str) -> Vec<Value> {
        self.state
            .docs
            .iter()
            .filter(|(id, _)| prefix.is_empty() || id.starts_with(prefix))
            .map(|(_, v)| v.clone())
            .collect()
    }
}

fn incoming_rev_of(doc: &Value) -> Option<&str> {
    doc.get("_rev").and_then(|v| v.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> TmpDir {
            let dir = std::env::temp_dir().join(format!(
                "gpm-store-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            TmpDir(dir)
        }
        fn file(&self) -> PathBuf {
            self.0.join("db.json")
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn put_get_roundtrip_and_clone_semantics() {
        let t = TmpDir::new("rt");
        let mut db = Store::open(&t.file());
        let res = db.put(&json!({ "_id": "a/1", "v": 1, "nested": { "x": 1 } }));
        assert_eq!(res["ok"], json!(true), "新建返回 ok");
        assert!(res["rev"].as_str().unwrap().len() > 0, "rev 是字符串");

        let doc = db.get("a/1").unwrap();
        assert_eq!(doc["v"], json!(1));
        assert_eq!(doc["_rev"], res["rev"], "get 带回 _id/_rev");
        let mut doc2 = db.get("a/1").unwrap();
        doc2["v"] = json!(999);
        doc2["nested"]["x"] = json!(999);
        assert_eq!(db.get("a/1").unwrap()["v"], json!(1), "get 返回深拷贝");

        assert!(db.get("a/missing").is_none(), "不存在返回 None");
        assert_eq!(db.put(&json!({ "v": 1 }))["name"], "bad_request", "无 _id 拒绝");
        assert_eq!(db.put(&json!({ "_id": "" }))["name"], "bad_request", "空 _id 拒绝");
    }

    #[test]
    fn rev_conflict_semantics() {
        let t = TmpDir::new("rev");
        let mut db = Store::open(&t.file());
        let first = db.put(&json!({ "_id": "r/1", "v": 1 }));

        let no_rev = db.put(&json!({ "_id": "r/1", "v": 2 }));
        assert_eq!(no_rev["name"], "conflict", "更新不带 _rev → conflict");
        let stale = db.put(&json!({ "_id": "r/1", "_rev": "rev-99999", "v": 2 }));
        assert_eq!(stale["name"], "conflict", "过期 _rev → conflict");

        let second = db.put(&json!({ "_id": "r/1", "_rev": first["rev"], "v": 2 }));
        assert_eq!(second["ok"], json!(true), "正确 _rev 更新成功");
        assert_ne!(first["rev"], second["rev"], "rev 单调递进");
        assert_eq!(db.get("r/1").unwrap()["v"], json!(2));

        let with_rev_new = db.put(&json!({ "_id": "r/new", "_rev": "rev-1", "v": 1 }));
        assert_eq!(with_rev_new["name"], "conflict", "新建携带 _rev → conflict");

        // 展开回写(带当前 _rev)是 store.js putDoc 的常规形态
        let doc = db.get("r/1").unwrap();
        let spread = db.put(&doc);
        assert_eq!(spread["ok"], json!(true));
    }

    #[test]
    fn remove_semantics() {
        let t = TmpDir::new("rm");
        let mut db = Store::open(&t.file());
        db.put(&json!({ "_id": "d/1", "v": 1 }));

        let stale = db.remove(&json!({ "_id": "d/1", "_rev": "rev-99999" }));
        assert_eq!(stale["name"], "conflict", "过期 _rev 删除 → conflict");
        let missing = db.remove(&json!({ "_id": "d/none", "_rev": "rev-1" }));
        assert_eq!(missing["name"], "not_found", "缺失 → not_found");
        assert_eq!(db.remove(&json!({}))["error"], json!(true), "无 _id 报错");

        let cur = db.get("d/1").unwrap();
        assert_eq!(db.remove(&cur)["ok"], json!(true), "按当前文档删除成功");
        assert!(db.get("d/1").is_none());
    }

    #[test]
    fn all_docs_prefix_and_sort() {
        let t = TmpDir::new("all");
        let mut db = Store::open(&t.file());
        db.put(&json!({ "_id": "godot/b/2" }));
        db.put(&json!({ "_id": "godot/a/1" }));
        db.put(&json!({ "_id": "other/c/3" }));

        let all = db.all_docs("");
        assert_eq!(all.len(), 3);
        let ids: Vec<&str> = all.iter().map(|d| d["_id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["godot/a/1", "godot/b/2", "other/c/3"], "按 _id 排序");

        let part = db.all_docs("godot/");
        assert_eq!(part.len(), 2);
        assert!(db.all_docs("nope/").is_empty(), "无命中为空");
    }

    #[test]
    fn persistence_and_rev_continuity() {
        let t = TmpDir::new("persist");
        let path = t.file();
        {
            let mut db = Store::open(&path);
            let res = db.put(&json!({ "_id": "p/1", "v": 1 }));
            db.put(&json!({ "_id": "p/1", "_rev": res["rev"], "v": 2 }));
        }
        let db2 = Store::open(&path);
        let cur = db2.get("p/1").unwrap();
        assert_eq!(cur["v"], json!(2), "重开库数据仍在");
        let mut db3 = Store::open(&path);
        let next = db3.put(&json!({ "_id": "p/1", "_rev": cur["_rev"], "v": 3 }));
        assert_eq!(next["ok"], json!(true), "重开库后旧 rev 仍可更新(非 conflict)");
        assert!(!path.with_extension("json.tmp").exists(), "写穿不留 .tmp");
    }

    #[test]
    fn corrupt_fallback_chain() {
        let t = TmpDir::new("corrupt");
        let path = t.file();
        {
            let mut db = Store::open(&path);
            db.put(&json!({ "_id": "keep/1" }));
            db.put(&json!({ "_id": "keep/2" }));
        }
        fs::write(&path, "{corrupted!").unwrap();
        let db2 = Store::open(&path);
        // .bak 是写入前的上一代:keep/1 保住,keep/2 只进了主文件,随损坏丢失(设计取舍)
        assert!(db2.get("keep/1").is_some(), "回滚 .bak 保留上一代");
        assert!(db2.get("keep/2").is_none(), "最后一代不进 .bak");
        assert!(path.with_extension("json.corrupt").exists(), "坏件留档 .corrupt");

        // 主备全坏 → 空库起步
        fs::write(&path, "{bad").unwrap();
        fs::write(path.with_extension("json.bak"), "[[bad").unwrap();
        let db3 = Store::open(&path);
        assert!(db3.get("keep/1").is_none(), "全坏 → 空库");
        assert!(path.with_extension("json.corrupt").exists());
    }
}
