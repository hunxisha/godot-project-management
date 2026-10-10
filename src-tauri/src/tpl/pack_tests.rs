//! `pack.rs` 的测试体（作为 pack 的子模块引入，可直接用私有件）。
//!
//! 为什么这些用例值得写：模板库动的是**用户盘上的模板目录**，两条最坏情况是
//! 「换入失败后生效位空着」与「删 dir='' 的存档把生效模板一起删了」。
//! 换入失败在真机上难自然复现，所以 move 走注入把手，把它逼出来验回滚。

use super::*;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("gpm-pack-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// 返回 (根, base=根/export_templates, 版本串目录名, store)
fn setup(tag: &str) -> (PathBuf, PathBuf, String, Store) {
    let root = tmp(tag);
    let base = root.join("export_templates");
    std::fs::create_dir_all(&base).unwrap();
    let st = Store::open(&root.join("db.json"));
    (root, base, "4.7.2.stable".to_string(), st)
}

fn ctx_of(base: &Path, vd: &str) -> Ctx {
    Ctx {
        base: base.to_path_buf(),
        version_dir: vd.to_string(),
        installed: false,
        tag: "4.7.2-stable".into(),
        version_id: "godot/version/1".into(),
    }
}

fn seed_dir(d: &Path, marker: &str) {
    std::fs::create_dir_all(d).unwrap();
    std::fs::write(d.join(marker), b"x").unwrap();
}

fn put_pack(st: &mut Store, base: &Path, id: &str, dir: &str, vd: &str, created: u64) {
    put_doc(st, &format!("{PACK_PREFIX}{id}"), json!({
        "packId": id, "versionId": "godot/version/1", "tag": "4.7.2-stable",
        "versionDir": vd, "source": "selfbuild", "dir": dir, "bytes": 1, "createdAt": created,
        "writtenFlags": [], "mode": ""
    }))
    .unwrap();
    if !dir.is_empty() {
        seed_dir(&pack_root(base).join(dir), "f");
    }
}

#[test]
fn list_marks_active_and_sorts_newest_first() {
    let (r, base, vd, mut st) = setup("list");
    put_pack(&mut st, &base, "p-old", "p-old", &vd, 100);
    put_pack(&mut st, &base, "p-new", "p-new", &vd, 200);
    put_pack(&mut st, &base, "p-live", "", &vd, 150);
    put_pack(&mut st, &base, "p-other", "p-other", "4.6.0", 300);
    let out = list_packs(&st, &ctx_of(&base, &vd));
    let packs = out["packs"].as_array().unwrap();
    assert_eq!(packs.len(), 3, "别的版本串的存档不许混进来");
    assert_eq!(packs[0]["packId"], json!("p-new"), "createdAt 倒序");
    assert_eq!(packs[2]["packId"], json!("p-old"));
    let live = packs.iter().find(|p| p["packId"] == json!("p-live")).unwrap();
    assert_eq!(live["active"], json!(true), "dir 为空才算生效中");
    assert_eq!(live["path"], json!(base.join(&vd).to_string_lossy()), "生效中的 path 指向生效位");
    assert_eq!(packs[0]["active"], json!(false));
    let _ = std::fs::remove_dir_all(&r);
}

#[test]
fn adopt_records_without_moving_and_refuses_duplicates() {
    let (r, base, vd, mut st) = setup("adopt");
    let c = ctx_of(&base, &vd);
    assert_eq!(adopt(&mut st, &c)["ok"], json!(false), "没有生效目录时无从收编");
    seed_dir(&base.join(&vd), "live-marker");
    let res = adopt(&mut st, &c);
    assert_eq!(res["ok"], json!(true));
    let id = res["packId"].as_str().unwrap().to_string();
    assert!(base.join(&vd).join("live-marker").exists(), "收编不许搬文件");
    assert!(!pack_root(&base).join(&id).exists(), "收编不许建槽");
    assert_eq!(list_packs(&st, &c)["packs"][0]["active"], json!(true));
    assert_eq!(adopt(&mut st, &c)["error"], json!("已有「在生效位」的存档记录,不必重复收编"));
    let _ = std::fs::remove_dir_all(&r);
}

#[test]
fn activate_swaps_both_ways_and_updates_records() {
    let (r, base, vd, mut st) = setup("act");
    seed_dir(&base.join(&vd), "A");
    put_pack(&mut st, &base, "p-live", "", &vd, 100);
    put_pack(&mut st, &base, "p-b", "p-b", &vd, 200);
    let c = ctx_of(&base, &vd);
    assert_eq!(activate(&mut st, &c, "p-b"), json!({ "ok": true, "moved": true }));
    assert!(base.join(&vd).join("f").exists(), "换入的槽内容到了生效位");
    assert!(!base.join(&vd).join("A").exists(), "原来的生效位内容已被换出");
    assert!(pack_root(&base).join("p-live").join("A").exists(), "换出去了自己原来的槽");
    let packs = list_packs(&st, &c)["packs"].as_array().unwrap().clone();
    let by = |id: &str| packs.iter().find(|p| p["packId"] == json!(id)).unwrap().clone();
    assert_eq!(by("p-b")["active"], json!(true), "换入的记成 dir 为空");
    assert_eq!(by("p-live")["dir"], json!("p-live"), "被换出的记回自己槽名");
    let _ = std::fs::remove_dir_all(&r);
}

#[test]
fn activate_refuses_cross_version_and_missing_slot() {
    let (r, base, vd, mut st) = setup("guards");
    put_pack(&mut st, &base, "p-x", "p-x", "4.6.0", 100);
    let c = ctx_of(&base, &vd);
    let e = activate(&mut st, &c, "p-x")["error"].as_str().unwrap().to_string();
    assert!(e.contains("4.6.0") && e.contains(&vd), "跨版本串要拒且点名两边,实际:{e}");
    put_pack(&mut st, &base, "p-gone-dir", "", &vd, 120);
    assert_eq!(activate(&mut st, &c, "p-gone-dir"), json!({ "ok": true, "moved": false }), "已在生效位的不搬,早退");
    let mut st2 = Store::open(&r.join("db2.json"));
    put_doc(&mut st2, &format!("{PACK_PREFIX}p-missing"), json!({ "packId": "p-missing", "versionDir": vd, "dir": "p-missing" })).unwrap();
    // 记录在、槽目录不在(用户手动删过):拒,并提示记录陈旧
    let e2 = activate(&mut st2, &c, "p-missing")["error"].as_str().unwrap().to_string();
    assert!(e2.contains("存档目录已不在") && e2.contains("记录陈旧"), "实际:{e2}");
    let _ = std::fs::remove_dir_all(&r);
}

#[test]
fn activate_rolls_back_when_swap_in_fails() {
    let (r, base, vd, mut st) = setup("rollback");
    seed_dir(&base.join(&vd), "A");
    put_pack(&mut st, &base, "p-live", "", &vd, 100);
    put_pack(&mut st, &base, "p-b", "p-b", &vd, 200);
    let c = ctx_of(&base, &vd);
    // 第二次 move(换入)失败:第一次(换出)必须被搬回来
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let mv = |s: &Path, d: &Path| -> Result<(), String> {
        if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
            return Err("模拟:换入被占用".to_string());
        }
        fsutil::move_sync(s, d).map_err(|e| e.to_string())
    };
    let res = activate_with(&mut st, &c, "p-b", &mv);
    assert_eq!(res["ok"], json!(false));
    let err = res["error"].as_str().unwrap().to_string();
    assert!(err.starts_with("换入失败已回滚:模拟:换入被占用"), "错误要带原原因并说明已回滚,实际:{err}");
    assert!(base.join(&vd).join("A").exists(), "回滚后生效位必须还原,不许留空目录");
    assert!(!pack_root(&base).join("p-live").exists(), "回滚后原来的槽不该留壳");
    let packs = list_packs(&st, &c)["packs"].as_array().unwrap().clone();
    let live = packs.iter().find(|p| p["packId"] == json!("p-live")).unwrap();
    assert_eq!(live["active"], json!(true), "回滚后记账要回到换出前:p-live 仍是生效中");
    assert_eq!(packs.iter().find(|p| p["packId"] == json!("p-b")).unwrap()["active"], json!(false));
    let _ = std::fs::remove_dir_all(&r);
}

#[test]
fn delete_trashes_slot_but_empty_dir_only_unlists() {
    let (r, base, vd, mut st) = setup("del");
    seed_dir(&base.join(&vd), "A");
    put_pack(&mut st, &base, "p-live", "", &vd, 100);
    put_pack(&mut st, &base, "p-b", "p-b", &vd, 200);
    let c = ctx_of(&base, &vd);
    assert_eq!(delete(&mut st, &c, "p-live")["ok"], json!(true));
    assert!(base.join(&vd).join("A").exists(), "删 dir 为空的存档只除名,不许动生效位");
    assert_eq!(list_packs(&st, &c)["packs"].as_array().unwrap().len(), 1);
    assert_eq!(delete(&mut st, &c, "p-b")["ok"], json!(true));
    assert!(!pack_root(&base).join("p-b").exists(), "槽存档要离开原位(走回收站通道,不是原地永久删)");
    assert_eq!(delete(&mut st, &c, "nope")["ok"], json!(false), "不存在的存档要报错不是静默");
    let _ = std::fs::remove_dir_all(&r);
}

#[test]
fn archive_copies_independent_duplicate() {
    let (r, base, vd, mut st) = setup("arch");
    seed_dir(&base.join(&vd), "A");
    let id = archive_from_install(
        &mut st, &base, &base.join(&vd), "godot/version/1", "4.7.2-stable", &vd,
        &json!({ "source": "selfbuild", "writtenFlags": ["disable_3d"], "mode": "default-on" }),
    )
    .unwrap();
    assert!(base.join(&vd).join("A").exists(), "存档是复制一份,生效位原样留着");
    assert!(pack_root(&base).join(&id).join("A").exists(), "槽里要有独立副本");
    let rec = read_pack(&st, &id).unwrap();
    assert_eq!(rec["dir"], json!(id), "自编译存档躺在自己槽里(不是 dir 为空)");
    assert_eq!(rec["source"], json!("selfbuild"));
    assert_eq!(rec["writtenFlags"], json!(["disable_3d"]));
    assert!(rec["bytes"].as_u64().unwrap() > 0, "bytes 要真数出来");
    let _ = std::fs::remove_dir_all(&r);
}

#[test]
fn version_dir_prefers_the_record_over_tag_derivation() {
    // 「统一取法」:装过自定义目录名的引擎,模板库必须认记录里那个目录,而不是 tag 派生。
    // base 由 exe 位置推导(自包含 `._sc_` → exe 旁 editor_data/export_templates),
    // 所以这棵树按那个规则摆,才能连 installed 一起验。
    let r = tmp("vd");
    let base = r.join("editor_data").join("export_templates");
    seed_dir(&base.join("4.7.2.my2d"), "A");
    std::fs::write(r.join("._sc_"), b"").unwrap();
    let mut st = Store::open(&r.join("db.json"));
    let vid = "godot/version/2";
    put_doc(&mut st, vid, json!({ "tag": "4.7.2-stable", "exePath": r.join("Godot.exe").to_string_lossy() })).unwrap();
    put_doc(&mut st, &format!("godot/templates/{vid}"), json!({ "versionDir": "4.7.2.my2d" })).unwrap();
    let c = for_version(&st, vid).unwrap();
    assert_eq!(c.base, base, "自包含引擎的模板根要在 exe 旁");
    assert_eq!(c.version_dir, "4.7.2.my2d", "记录里的 versionDir 优先");
    assert!(c.installed, "按那个目录判已装");
    // 没有 templates 记录时回到 tag 派生
    let vid2 = "godot/version/3";
    put_doc(&mut st, vid2, json!({ "tag": "4.7.2-stable", "exePath": r.join("Godot.exe").to_string_lossy() })).unwrap();
    assert_eq!(for_version(&st, vid2).unwrap().version_dir, "4.7.2.stable", "无记录时按 tag 派生");
    assert!(for_version(&st, "godot/version/missing").is_err(), "引擎记录不存在要拒");
    let _ = std::fs::remove_dir_all(&r);
}
