// 安全 zip 解压:zip-slip 防护是硬约束(压缩包内条目路径不得逃逸目标目录),
// 对齐 lib/extract.js 的安全语义;资产嗅探安装(T4)与引擎安装(T3)共用。
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// 条目相对路径白名单:只接受普通组件;任何 `..`、绝对路径、盘符、`.` 一律拒绝。
fn safe_join(dest: &Path, name: &str) -> Option<PathBuf> {
    let rel = PathBuf::from(name.replace('\\', "/"));
    for c in rel.components() {
        match c {
            Component::Normal(_) => {}
            _ => return None,
        }
    }
    Some(dest.join(rel))
}

/// 解压 zip 到 dest,返回写入的文件数(目录条目不计)。
pub fn unzip(zip_path: &Path, dest: &Path) -> Result<usize, String> {
    let f = std::fs::File::open(zip_path).map_err(|e| format!("打开 zip 失败:{e}"))?;
    let mut archive = zip::ZipArchive::new(f).map_err(|e| format!("读取 zip 失败:{e}"))?;
    std::fs::create_dir_all(dest).map_err(|e| format!("创建目标目录失败:{e}"))?;
    let mut files = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取条目 {i} 失败:{e}"))?;
        let name = entry.name().to_string();
        let out = safe_join(dest, &name)
            .ok_or_else(|| format!("zip-slip:条目路径逃逸目标目录,已拒绝:{name}"))?;
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("创建目录失败:{e}"))?;
            continue;
        }
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(|e| format!("创建目录失败:{e}"))?;
        }
        let mut w = std::fs::File::create(&out).map_err(|e| format!("创建文件失败:{e}"))?;
        std::io::copy(&mut entry, &mut w).map_err(|e| format!("解压条目 {name} 失败:{e}"))?;
        files += 1;
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> TmpDir {
            let dir = std::env::temp_dir().join(format!(
                "gpm-extract-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TmpDir(dir)
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 构造一个 zip:entries 为 (条目名, 内容)
    fn make_zip(path: &Path, entries: &[(&str, &str)]) {
        let f = std::fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        w.start_file("placeholder.marker", zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(b"x").unwrap();
        for (name, body) in entries {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn normal_extraction() {
        let t = TmpDir::new("ok");
        let zip_path = t.0.join("good.zip");
        make_zip(&zip_path, &[("addons/myplug/plugin.cfg", "[plugin]"), ("addons/myplug/main.gd", "extends Node")]);
        let dest = t.0.join("out");
        let n = unzip(&zip_path, &dest).unwrap();
        assert!(n >= 2, "写入文件数 = {n}");
        assert_eq!(std::fs::read_to_string(dest.join("addons/myplug/plugin.cfg")).unwrap(), "[plugin]");
    }

    #[test]
    fn zip_slip_is_rejected() {
        let t = TmpDir::new("slip");
        let zip_path = t.0.join("evil.zip");
        make_zip(&zip_path, &[("../evil.txt", "escaped")]);
        let dest = t.0.join("out");
        let err = unzip(&zip_path, &dest).unwrap_err();
        assert!(err.contains("zip-slip"), "报错要说明逃逸被拒:{err}");
        assert!(!t.0.join("evil.txt").exists(), "文件绝不能写出目标目录");
    }

    #[test]
    fn absolute_and_drive_paths_are_rejected() {
        let t = TmpDir::new("abs");
        let zip_path = t.0.join("abs.zip");
        make_zip(&zip_path, &[("C:\\evil.txt", "x"), ("/tmp/evil2.txt", "y")]);
        assert!(unzip(&zip_path, &t.0.join("out")).is_err(), "盘符/绝对路径一律拒绝");
    }
}
