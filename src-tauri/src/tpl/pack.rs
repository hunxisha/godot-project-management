//! 模板库（P0e-4）：多套裁剪变体存档 + 换入换出生效。
//!
//! 真源 = `src-ztools/preload/lib/tpllib.js`（342 行）。三条语义照搬：
//!   · `dir=''` = 这套**正在生效位**（收编登记，没搬过文件）；`dir=<packId>` = 独立副本躺在存档槽；
//!   · 切换 = 两次 move：换出（生效位 → 活跃存档槽）→ 换入（存档槽 → 生效位），**第二步失败回滚第一步**；
//!     不走回收站（回收站只服务删除）；
//!   · 删除：有槽目录的进回收站 + 除名；`dir=''` 的只除名（不动生效位）。
//!
//! 存档根 = `export_templates` 基目录的**同级** `tplpack/` —— 与生效位同盘，切换才是 rename 而不是跨盘复制。
//! 记录只存 packId 与元数据，目录位置运行时由根解析（换根零迁移）。
//!
//! 写库一律走 `put_doc`（带 `_rev` 的读-改-写）：`store.rs` 的失败是**正常 resolve 一个
//! `{error:true}`**，不带 `_rev` 对已存在的文档必 conflict —— 这条在垫片与 JS 侧都栽过。

use crate::fsutil;
use crate::store::Store;
use crate::templates;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// 对应 tpllib.js:19 PACK_PREFIX
pub const PACK_PREFIX: &str = "godot/tplpack/";
/// 对应 tpllib.js:104 newPackId 的前缀
const PACK_ID_PREFIX: &str = "tpl";

/// 对应 tpllib.js:56 packRoot —— 生效基目录的同级 tplpack/
pub fn pack_root(base: &Path) -> PathBuf {
    base.parent().unwrap_or(base).join("tplpack")
}

/// 对应 tpllib.js:258 forVersion 的上下文
pub struct Ctx {
    pub base: PathBuf,
    pub version_dir: String,
    pub installed: bool,
    pub tag: String,
    pub version_id: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn base_dir_of(exe_path: &str) -> PathBuf {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    let appdata = std::env::var("APPDATA").ok().map(PathBuf::from);
    let platform = if cfg!(target_os = "windows") { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" };
    templates::templates_base(Some(Path::new(exe_path)), Path::new(&home), appdata.as_deref(), platform)
}

/// 带 `_rev` 的写入（读-改-写里的「读」只为拿 `_rev`，字段合并由调用方交整份文档）
fn put_doc(store: &mut Store, id: &str, body: Value) -> Result<(), String> {
    let mut doc = body.as_object().cloned().unwrap_or_default();
    doc.insert("_id".into(), json!(id));
    if let Some(cur) = store.get(id) {
        if let Some(rev) = cur.get("_rev") {
            doc.insert("_rev".into(), rev.clone());
        }
    }
    let r = store.put(&Value::Object(doc));
    if r.get("error") == Some(&json!(true)) {
        return Err(r.get("message").and_then(|m| m.as_str()).unwrap_or("写入失败").to_string());
    }
    Ok(())
}

fn remove_doc(store: &mut Store, id: &str) -> Result<(), String> {
    let mut doc = Map::new();
    doc.insert("_id".into(), json!(id));
    if let Some(cur) = store.get(id) {
        if let Some(rev) = cur.get("_rev") {
            doc.insert("_rev".into(), rev.clone());
        }
    }
    let r = store.remove(&Value::Object(doc));
    if r.get("error") == Some(&json!(true)) && r.get("name").and_then(|n| n.as_str()) != Some("not_found") {
        return Err(r.get("message").and_then(|m| m.as_str()).unwrap_or("删除失败").to_string());
    }
    Ok(())
}

/// 对应 tpllib.js:258 forVersion —— versionDir 走「统一取法」：`godot/templates/<id>` 记录里已有的值优先，
/// 其次 tag 派生。**不用 `templates::status`**：那条只按 tag 派生，自定义目录名的引擎会被读成另一个目录
/// （已记进台账，属桌面版 `export_template_status` 的既有缺口）。
pub fn for_version(store: &Store, version_id: &str) -> Result<Ctx, Value> {
    let v = store.get(version_id).ok_or_else(|| json!({ "ok": false, "error": "引擎记录不存在" }))?;
    let tag = v.get("tag").and_then(|t| t.as_str()).unwrap_or("");
    if tag.is_empty() {
        return Err(json!({ "ok": false, "error": "引擎记录不存在" }));
    }
    let doc = store.get(&format!("godot/templates/{version_id}"));
    let version_dir = doc.as_ref().and_then(|d| d.get("versionDir")).and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| templates::version_dir_for_tag(tag));
    let base = base_dir_of(v.get("exePath").and_then(|e| e.as_str()).unwrap_or(""));
    let installed = base.join(&version_dir).is_dir();
    Ok(Ctx { base, version_dir, installed, tag: tag.to_string(), version_id: version_id.to_string() })
}

/// 对应 tpllib.js:71 listTemplatePacks（按 versionDir 匹配 —— 同 tag 多台引擎共享存档）
pub fn list_packs(store: &Store, ctx: &Ctx) -> Value {
    let root = pack_root(&ctx.base);
    let mut packs: Vec<Value> = store.all_docs(PACK_PREFIX).iter()
        .filter(|d| d.get("versionDir").and_then(|v| v.as_str()) == Some(ctx.version_dir.as_str()))
        .map(|d| {
            let dir = d.get("dir").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let path = if dir.is_empty() {
                ctx.base.join(&ctx.version_dir).to_string_lossy().into_owned()
            } else {
                root.join(&dir).to_string_lossy().into_owned()
            };
            let mut o = Map::new();
            o.insert("packId".into(), d.get("packId").cloned().unwrap_or(json!("")));
            o.insert("versionId".into(), d.get("versionId").cloned().unwrap_or(json!("")));
            o.insert("tag".into(), d.get("tag").cloned().unwrap_or(json!("")));
            o.insert("versionDir".into(), d.get("versionDir").cloned().unwrap_or(json!("")));
            o.insert("source".into(), d.get("source").cloned().unwrap_or(json!("adopted")));
            o.insert("dir".into(), json!(dir));
            o.insert("active".into(), json!(dir.is_empty()));
            o.insert("bytes".into(), d.get("bytes").cloned().unwrap_or(json!(0)));
            o.insert("createdAt".into(), d.get("createdAt").cloned().unwrap_or(json!(0)));
            o.insert("writtenFlags".into(), d.get("writtenFlags").cloned().unwrap_or(json!([])));
            o.insert("mode".into(), d.get("mode").cloned().unwrap_or(json!("")));
            o.insert("path".into(), json!(path));
            Value::Object(o)
        })
        .collect();
    packs.sort_by(|a, b| b["createdAt"].as_u64().unwrap_or(0).cmp(&a["createdAt"].as_u64().unwrap_or(0)));
    json!({ "ok": true, "packs": packs })
}

fn read_pack(store: &Store, pack_id: &str) -> Option<Value> {
    store.get(&format!("{PACK_PREFIX}{pack_id}")).filter(|d| d.get("packId").is_some())
}

fn new_pack_id() -> String {
    let t = now_ms();
    // 与 JS 同形态:tpl-<base36 时间>-<6 位随机>
    let mut r = String::new();
    let alphabet = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut seed = (t ^ (std::process::id() as u64) << 17).wrapping_mul(6364136223846793005);
    for _ in 0..6 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        r.push(alphabet[((seed >> 33) as usize) % 36] as char);
    }
    format!("{PACK_ID_PREFIX}-{}-{r}", to_base36(t))
}

fn to_base36(mut n: u64) -> String {
    if n == 0 {
        return "0".to_string();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut s = String::new();
    while n > 0 {
        s.insert(0, digits[(n % 36) as usize] as char);
        n /= 36;
    }
    s
}

/// 对应 tpllib.js:102 archiveFromInstall —— 自编译导入后的自动存档（生效位复制一份独立副本进槽）
pub fn archive_from_install(
    store: &mut Store, base: &Path, dest: &Path, version_id: &str, tag: &str, version_dir: &str, archive: &Value,
) -> Result<String, String> {
    let pack_id = new_pack_id();
    let slot = pack_root(base).join(&pack_id);
    fsutil::copy_recursive(dest, &slot).map_err(|e| format!("存档失败:{e}"))?;
    let mut rec = Map::new();
    rec.insert("packId".into(), json!(pack_id));
    rec.insert("versionId".into(), json!(version_id));
    rec.insert("tag".into(), json!(tag));
    rec.insert("versionDir".into(), json!(version_dir));
    rec.insert("source".into(), archive.get("source").cloned().filter(|s| s != &json!("")).unwrap_or(json!("selfbuild")));
    rec.insert("dir".into(), json!(pack_id));
    rec.insert("bytes".into(), json!(fsutil::dir_size(&slot)));
    rec.insert("createdAt".into(), json!(now_ms()));
    rec.insert("writtenFlags".into(), archive.get("writtenFlags").cloned().unwrap_or(json!([])));
    rec.insert("mode".into(), archive.get("mode").cloned().unwrap_or(json!("")));
    put_doc(store, &format!("{PACK_PREFIX}{pack_id}"), Value::Object(rec))?;
    Ok(pack_id)
}

/// 对应 tpllib.js:128 adoptTemplatePack —— 收编只记不搬
pub fn adopt(store: &mut Store, ctx: &Ctx) -> Value {
    let dest = ctx.base.join(&ctx.version_dir);
    if !dest.exists() {
        return json!({ "ok": false, "error": "当前没有生效中的模板目录,无从收编" });
    }
    if list_packs(store, ctx)["packs"].as_array().map(|p| p.iter().any(|x| x["active"] == json!(true))).unwrap_or(false) {
        return json!({ "ok": false, "error": "已有「在生效位」的存档记录,不必重复收编" });
    }
    let pack_id = new_pack_id();
    let mut rec = Map::new();
    rec.insert("packId".into(), json!(pack_id));
    rec.insert("versionId".into(), json!(ctx.version_id));
    rec.insert("tag".into(), json!(ctx.tag));
    rec.insert("versionDir".into(), json!(ctx.version_dir));
    rec.insert("source".into(), json!("adopted"));
    rec.insert("dir".into(), json!(""));
    rec.insert("bytes".into(), json!(fsutil::dir_size(&dest)));
    rec.insert("createdAt".into(), json!(now_ms()));
    rec.insert("writtenFlags".into(), json!([]));
    rec.insert("mode".into(), json!(""));
    if let Err(e) = put_doc(store, &format!("{PACK_PREFIX}{pack_id}"), Value::Object(rec)) {
        return json!({ "ok": false, "error": format!("写入失败:{e}") });
    }
    json!({ "ok": true, "packId": pack_id })
}

/// 真源的 moveSync（同盘 rename、跨盘 EXDEV/EPERM 回退复制）；测试注入假把手来验回滚
pub type Mover<'a> = dyn Fn(&Path, &Path) -> Result<(), String> + 'a;

fn real_move(src: &Path, dest: &Path) -> Result<(), String> {
    fsutil::move_sync(src, dest).map_err(|e| format!("{e}"))
}

/// 对应 tpllib.js:155 activateTemplatePack —— 两次 move + 回滚
pub fn activate(store: &mut Store, ctx: &Ctx, pack_id: &str) -> Value {
    activate_with(store, ctx, pack_id, &real_move)
}

pub fn activate_with(store: &mut Store, ctx: &Ctx, pack_id: &str, mv: &Mover<'_>) -> Value {
    let Some(pack) = read_pack(store, pack_id) else {
        return json!({ "ok": false, "error": format!("存档不存在:{pack_id}") });
    };
    if pack.get("versionDir").and_then(|v| v.as_str()) != Some(ctx.version_dir.as_str()) {
        return json!({ "ok": false, "error": format!(
            "存档的版本串是 {}，与这台引擎要的 {} 不符(编辑器按版本串找模板,跨串换入是静默失效)",
            pack.get("versionDir").and_then(|v| v.as_str()).unwrap_or(""), ctx.version_dir) });
    }
    if pack.get("dir").and_then(|v| v.as_str()).unwrap_or("") == "" {
        return json!({ "ok": true, "moved": false }); // 已在生效位,不搬无谓的两步
    }
    let root = pack_root(&ctx.base);
    let slot_src = root.join(pack["dir"].as_str().unwrap_or(""));
    if !slot_src.exists() {
        return json!({ "ok": false, "error": format!("存档目录已不在:{}(记录陈旧,请删除该存档)", slot_src.display()) });
    }
    // 全程同步:两次 move 之间没有让步点,所以在途锁会是钉不红的死分支(与 JS 同一条论证)
    let dest = ctx.base.join(&ctx.version_dir);
    let mut out_slot = String::new();
    let mut out_rec: Option<Value> = None;
    // 回滚要还原的是**换出前**那份记账，不是换出后写的这条：
    // 文件搬回生效位了、记录却写着「在槽里」= 下一次切换报「存档目录已不在」，
    // 而面板上那行显示成未生效 —— JS 侧 tpllib.js:196-200 正是把 outRec(换出后的)又写了一遍，
    // 本端不 bug 兼容，同一批把 JS 也改过来（见 docs/待确认.md）。
    let mut out_prev: Option<Value> = None;
    if dest.exists() {
        let active_rec = list_packs(store, ctx)["packs"].as_array().cloned().unwrap_or_default()
            .into_iter().find(|x| x["active"] == json!(true));
        out_slot = active_rec.as_ref().and_then(|a| a["packId"].as_str().map(|s| s.to_string())).unwrap_or_else(new_pack_id);
        let swap_out_dest = root.join(&out_slot);
        if let Err(e) = mv(&dest, &swap_out_dest) {
            return json!({ "ok": false, "error": format!("换出失败:{e}") });
        }
        out_prev = active_rec.as_ref().and_then(|a| read_pack(store, a["packId"].as_str().unwrap_or("")));
        out_rec = Some(match out_prev.clone() {
            Some(mut cur) => {
                if let Some(o) = cur.as_object_mut() { o.insert("dir".into(), json!(out_slot.clone())); }
                cur
            }
            None => {
                let mut m = Map::new();
                m.insert("packId".into(), json!(out_slot.clone()));
                m.insert("versionId".into(), json!(ctx.version_id));
                m.insert("tag".into(), json!(pack["tag"].clone()));
                m.insert("versionDir".into(), json!(ctx.version_dir));
                m.insert("source".into(), json!("adopted"));
                m.insert("dir".into(), json!(out_slot.clone()));
                m.insert("bytes".into(), json!(fsutil::dir_size(&swap_out_dest)));
                m.insert("createdAt".into(), json!(now_ms()));
                m.insert("writtenFlags".into(), json!([]));
                m.insert("mode".into(), json!(""));
                Value::Object(m)
            }
        });
        if let Some(r) = &out_rec {
            if let Err(e) = put_doc(store, &format!("{PACK_PREFIX}{out_slot}"), r.clone()) {
                return json!({ "ok": false, "error": format!("换出记账失败:{e}") });
            }
        }
    }
    if let Err(e) = mv(&slot_src, &dest) {
        // 回滚换出;回滚也失败时保留现场并在错误里点名两个目录,让用户能手动搬回
        if !out_slot.is_empty() {
            let back = root.join(&out_slot);
            let rolled = mv(&back, &dest);
            match &out_prev {
                Some(prev) => { let _ = put_doc(store, &format!("{PACK_PREFIX}{out_slot}"), prev.clone()); }
                // 这条记账是换出时才新建的:文件搬回生效位后，它就该回到「没有这条槽存档」
                None => { let _ = remove_doc(store, &format!("{PACK_PREFIX}{out_slot}")); }
            }
            return json!({ "ok": false, "error": match rolled {
                Ok(_) => format!("换入失败已回滚:{e}"),
                Err(e2) => format!("换入失败:{e};回滚也没成({e2}),请手动把 {} 搬回 {}", back.display(), dest.display()),
            } });
        }
        return json!({ "ok": false, "error": format!("换入失败:{e}") });
    }
    let mut activated = pack.as_object().cloned().unwrap_or_default();
    activated.insert("dir".into(), json!(""));
    if let Err(e) = put_doc(store, &format!("{PACK_PREFIX}{pack_id}"), Value::Object(activated)) {
        return json!({ "ok": false, "error": format!("换入记账失败:{e}") });
    }
    // 生效记录跟着改:版本卡读的是 `godot/templates/<id>`
    let tid = format!("godot/templates/{}", ctx.version_id);
    if let Some(mut prior) = store.get(&tid).and_then(|p| p.as_object().cloned()) {
        prior.insert("versionDir".into(), json!(ctx.version_dir));
        prior.insert("path".into(), json!(dest.to_string_lossy()));
        prior.insert("fileCount".into(), json!(std::fs::read_dir(&dest).map(|rd| rd.count()).unwrap_or(0)));
        let _ = put_doc(store, &tid, Value::Object(prior));
    }
    json!({ "ok": true, "moved": true })
}

/// 对应 tpllib.js:220 deleteTemplatePack
pub fn delete(store: &mut Store, ctx: &Ctx, pack_id: &str) -> Value {
    let Some(pack) = read_pack(store, pack_id) else {
        return json!({ "ok": false, "error": format!("存档不存在:{pack_id}") });
    };
    let dir = pack.get("dir").and_then(|v| v.as_str()).unwrap_or("");
    if !dir.is_empty() {
        let slot = pack_root(&ctx.base).join(dir);
        if slot.exists() {
            if let Err(e) = fsutil::delete_to_trash(&slot) {
                return json!({ "ok": false, "error": format!("进回收站失败(回收站不可用?):{e}") });
            }
        }
    }
    if let Err(e) = remove_doc(store, &format!("{PACK_PREFIX}{pack_id}")) {
        return json!({ "ok": false, "error": format!("除名失败:{e}") });
    }
    json!({ "ok": true })
}

/// 四个 `*ForVersion` 门面（对应 tpllib.js:267-294）
pub fn list_for_version(store: &Store, version_id: &str) -> Value {
    match for_version(store, version_id) {
        Ok(ctx) => list_packs(store, &ctx),
        Err(e) => e,
    }
}

pub fn activate_for_version(store: &mut Store, version_id: &str, pack_id: &str) -> Value {
    let ctx = match for_version(store, version_id) { Ok(c) => c, Err(e) => return e };
    activate(store, &ctx, pack_id)
}

pub fn delete_for_version(store: &mut Store, version_id: &str, pack_id: &str) -> Value {
    let ctx = match for_version(store, version_id) { Ok(c) => c, Err(e) => return e };
    delete(store, &ctx, pack_id)
}

pub fn adopt_for_version(store: &mut Store, version_id: &str) -> Value {
    let ctx = match for_version(store, version_id) { Ok(c) => c, Err(e) => return e };
    if !ctx.installed {
        return json!({ "ok": false, "error": "当前没有生效中的模板,无从收编" });
    }
    adopt(store, &ctx)
}

// 测试体单独成文件(七组用例比实现还长,混在下面反而看不清本模块的公开面);
// 它是本模块的**子模块**,所以能直接用 pack 里的私有件(put_doc / read_pack / pack_root)。
#[cfg(test)]
#[path = "pack_tests.rs"]
mod tests;
