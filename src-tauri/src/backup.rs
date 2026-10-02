// 备份域:zip/快照两模式、恢复(覆盖/新项目)、校验、清理策略。
// 对齐 lib/backup.js 的核心语义:先写 .gpm-tmp-* 再原子改名;zip 中央目录含 project.godot 才算有效;
// 覆盖恢复进入替换阶段后不可回滚(由调用方在清空前拒绝取消);保留策略 keep_per_project / older_than_days。
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::Path;

/// zip 备份:遍历项目目录写入 dest(先临时再改名),返回 (文件数, 压缩包字节)。
/// exclude 为名称级排除(目录或文件名);include_cache=false 时跳过 .godot。
pub fn zip_dir(
    project_dir: &Path,
    dest: &Path,
    include_cache: bool,
    level: u8,
    exclude: &[String],
    mut on_progress: impl FnMut(usize, u64),
) -> Result<(usize, u64), String> {
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    collect(project_dir, project_dir, include_cache, exclude, &mut paths);
    paths.sort();
    let tmp = dest.with_file_name(format!(
        ".gpm-tmp-{}-{}",
        dest.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        std::process::id()
    ));
    let file = std::fs::File::create(&tmp).map_err(|e| format!("创建临时包失败:{e}"))?;
    let mut zw = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(level_to_i64(level)));
    let mut count = 0usize;
    let mut bytes = 0u64;
    for (i, p) in paths.iter().enumerate() {
        let rel = p.strip_prefix(project_dir).unwrap_or(p).to_string_lossy().replace('\\', "/");
        let meta = std::fs::symlink_metadata(p).map_err(|e| format!("读元数据失败 {rel}:{e}"))?;
        if meta.is_dir() {
            zw.add_directory(rel.clone(), options).map_err(|e| format!("写目录条目失败:{e}"))?;
        } else {
            zw.start_file(rel.clone(), options).map_err(|e| format!("写条目失败:{e}"))?;
            let mut f = std::fs::File::open(p).map_err(|e| format!("读文件失败 {rel}:{e}"))?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| format!("读文件失败 {rel}:{e}"))?;
            bytes += buf.len() as u64;
            zw.write_all(&buf).map_err(|e| format!("压缩写入失败:{e}"))?;
            count += 1;
        }
        if i % 32 == 0 {
            on_progress(i + 1, bytes);
        }
    }
    zw.finish().map_err(|e| format!("收尾失败:{e}"))?;
    let size = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    std::fs::rename(&tmp, dest).map_err(|e| format!("落盘改名失败:{e}"))?;
    on_progress(count + 1, bytes);
    Ok((count, size))
}

fn level_to_i64(level: u8) -> i64 {
    match level {
        1 => 1,
        9 => 9,
        _ => 6,
    }
}

fn collect(
    root: &Path,
    dir: &Path,
    include_cache: bool,
    exclude: &[String],
    out: &mut Vec<std::path::PathBuf>,
) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if exclude.iter().any(|x| x == &name) {
            continue;
        }
        if !include_cache && name == ".godot" {
            continue;
        }
        if name.starts_with(".gpm-tmp-") {
            continue;
        }
        if p.is_dir() {
            out.push(p.clone());
            collect(root, &p, include_cache, exclude, out);
        } else {
            out.push(p);
        }
    }
}

/// 校验备份 zip:能开中央目录且含 project.godot → 返回条目数,否则 Err(可读原因)
pub fn verify_zip(path: &Path) -> Result<usize, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("打不开备份文件:{e}"))?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| format!("zip 中央目录读取失败(文件损坏?):{e}"))?;
    for i in 0..z.len() {
        let name = z.by_index(i).map_err(|e| format!("读取条目 {i} 失败:{e}"))?.name().to_string();
        if name.ends_with("project.godot") {
            return Ok(z.len());
        }
    }
    Err("备份里没有 project.godot(内容不可用)".into())
}

/// 恢复:overwrite 先清空目标(此后不可回滚),new 直接解压到新目录。
pub fn restore(archive: &Path, dest: &Path, overwrite: bool) -> Result<usize, String> {
    if overwrite {
        crate::fsutil::clear_dir(dest).map_err(|e| format!("清空原项目失败:{e}"))?;
    }
    crate::extract::unzip(archive, dest)
}

/// 保留策略(纯函数):keep_per_project 每项目留最近 N 份;older_than_days 按创建时间。
/// 输入记录需含 _id/projectId/createdAt;返回要清理的目标(输入顺序不变)。
pub fn prune_targets(
    records: &[Value],
    keep_per_project: Option<u64>,
    older_than_days: Option<u64>,
    now_ms: u64,
) -> Vec<String> {
    use std::collections::HashMap;
    let day = 24 * 60 * 60 * 1000;
    let cutoff = older_than_days.map(|d| now_ms.saturating_sub(d * day));
    // 按 (projectId, createdAt 倒序) 分组编号,超出保留数的进名单
    let mut latest: HashMap<String, Vec<(u64, String)>> = HashMap::new();
    for r in records {
        let pid = r.get("projectId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let at = r.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(0);
        let id = r.get("_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        latest.entry(pid).or_default().push((at, id));
    }
    let mut stale_ids: Vec<String> = Vec::new();
    for (_, mut list) in latest {
        list.sort_by(|a, b| b.0.cmp(&a.0));
        for (i, (_, id)) in list.iter().enumerate() {
            let beyond_keep = keep_per_project.map(|k| i as u64 >= k).unwrap_or(false);
            let too_old = cutoff.map(|c| {
                list.iter()
                    .find(|(_, x)| x == id)
                    .map(|(at, _)| *at < c)
                    .unwrap_or(false)
            }).unwrap_or(false);
            // 两条策略独立触发任一即入选;keep_per_project 只在启用时计数
            if beyond_keep || too_old {
                stale_ids.push(id.clone());
            }
            let _ = i;
        }
    }
    // 与输入顺序对齐输出
    records
        .iter()
        .filter_map(|r| {
            let id = r.get("_id").and_then(|v| v.as_str())?;
            stale_ids.contains(&id.to_string()).then(|| id.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "gpm-bk-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn sample_project(base: &Path) -> PathBuf {
        let p = base.join("proj");
        std::fs::create_dir_all(p.join(".godot")).unwrap();
        std::fs::create_dir_all(p.join("scenes")).unwrap();
        std::fs::write(p.join("project.godot"), "config_version=5\nconfig/name=\"Demo\"\n").unwrap();
        std::fs::write(p.join("main.tscn"), "[node]\n").unwrap();
        std::fs::write(p.join(".godot").join("cache.bin"), vec![0u8; 2048]).unwrap();
        std::fs::create_dir_all(p.join("build")).unwrap();
        std::fs::write(p.join("build").join("x.exe"), "x").unwrap();
        p
    }

    #[test]
    fn zip_roundtrip_exclude_and_restore() {
        let base = tmp("zip");
        let proj = sample_project(&base);
        let dest = base.join("demo.zip");
        let mut prog_calls = 0;
        let (files, size) = zip_dir(&proj, &dest, false, 6, &["build".into()], |_, _| prog_calls += 1).unwrap();
        assert_eq!(files, 2, "project.godot + main.tscn(.godot/build 均被排除)");
        assert!(size > 0);
        assert!(prog_calls > 0, "有进度回调");

        // 校验:有效且含 project.godot
        assert!(verify_zip(&dest).is_ok());
        // 破损 → 校验失败
        let bad = base.join("bad.zip");
        std::fs::write(&bad, b"not a zip").unwrap();
        assert!(verify_zip(&bad).is_err());

        // 恢复(覆盖):目标先清空再解压
        let target = base.join("restored");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("stale.txt"), "old").unwrap();
        let n = restore(&dest, &target, true).unwrap();
        assert!(n >= 2);
        assert!(!target.join("stale.txt").exists(), "覆盖恢复先清空");
        assert_eq!(std::fs::read_to_string(target.join("project.godot")).unwrap(), "config_version=5\nconfig/name=\"Demo\"\n");
        assert!(!target.join(".godot").exists(), "排除过的 .godot 不会被恢复出来");
        // 无残留临时文件
        assert!(std::fs::read_dir(&base).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with(".gpm-tmp-")));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn snapshot_copy_mode() {
        let base = tmp("copy");
        let proj = sample_project(&base);
        let dest = base.join("snap");
        crate::fsutil::copy_recursive(&proj, &dest).unwrap();
        assert_eq!(std::fs::read_to_string(dest.join("project.godot")).unwrap(), "config_version=5\nconfig/name=\"Demo\"\n");
        assert_eq!(crate::fsutil::dir_size(&dest) > 2048, true, "快照含 .godot 缓存(与 zip 排除语义互补)");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn prune_selection_rules() {
        let now = 1_700_000_000_000u64;
        let day = 24 * 60 * 60 * 1000u64;
        let mk = |id: &str, pid: &str, at: u64| json!({ "_id": id, "projectId": pid, "createdAt": at });
        let records = vec![
            mk("b1", "p1", now),
            mk("b2", "p1", now - day),
            mk("b3", "p1", now - 40 * day),
            mk("b4", "p2", now - 40 * day),
        ];
        // keep 2:p1 留 b1/b2,b3 出局;p2 只有一份,keep 不影响
        assert_eq!(prune_targets(&records, Some(2), None, now), vec!["b3"]);
        // 40 天:p3 无;按天数 b3、b4 出局
        assert_eq!(prune_targets(&records, None, Some(30), now), vec!["b3", "b4"]);
        // 双策略并集
        assert_eq!(prune_targets(&records, Some(1), Some(30), now), vec!["b2", "b3", "b4"]);
        // 空策略 → 空
        assert!(prune_targets(&records, None, None, now).is_empty());
        // keep 0 等于全清
        assert_eq!(prune_targets(&records, Some(0), None, now).len(), 4);
    }
}
