// 文件工具:目录体积统计、跨盘移动、回收站删除(backup/projects/设置清理共用)。
use std::path::Path;

/// 递归统计目录字节数;符号链接不跟随
pub fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
        if meta.is_dir() {
            total += dir_size(&p);
        } else {
            total += meta.len();
        }
    }
    total
}

/// 同盘 rename、跨盘回退复制(对齐 templates.js/assets.js 的 moveSync)
pub fn move_sync(src: &Path, dest: &Path) -> std::io::Result<()> {
    match std::fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(17) || e.raw_os_error() == Some(1) => {
            // EXDEV(跨盘) / EPERM:复制后删源
            copy_recursive(src, dest)?;
            std::fs::remove_dir_all(src).or_else(|_| std::fs::remove_file(src))?;
            Ok(())
        }
        Err(e) => Err(e),
    }
}

pub fn copy_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.is_dir() {
        std::fs::create_dir_all(dest)?;
        for e in std::fs::read_dir(src)? {
            let e = e?;
            copy_recursive(&e.path(), &dest.join(e.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(p) = dest.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::copy(src, dest).map(|_| ())
    }
}

/// 删除:交 `trash::delete`(全平台同一调用,没有按 OS 分叉的分支),失败直接回 Err。
/// 本函数**没有**「回退直接删除」那条路 —— 旧注释这么写过,与代码不符,已订正。
/// 注意:`trash` crate 在 macOS/Linux 也进各平台的废纸篓,所以「非 Windows 是永久删除」
/// 只是渲染层按 OS 写的**保守措辞**,不是这个宿主的行为(记录见 inspectfs.rs:397-402)。
pub fn delete_to_trash(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    trash::delete(path).map_err(|e| format!("移入回收站失败:{e}"))
}

/// 清空目录内容但保留目录本身(恢复「覆盖原项目」前奏)
pub fn clear_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    for e in std::fs::read_dir(dir)?.flatten() {
        let p = e.path();
        if p.is_dir() {
            std::fs::remove_dir_all(&p)?;
        } else {
            std::fs::remove_file(&p)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "gpm-fs-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    use std::path::PathBuf;

    #[test]
    fn dir_size_sums_files() {
        let base = tmp("size");
        std::fs::write(base.join("a.txt"), vec![0u8; 100]).unwrap();
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("sub/b.bin"), vec![0u8; 50]).unwrap();
        assert_eq!(dir_size(&base), 150);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn clear_dir_keeps_root() {
        let base = tmp("clear");
        std::fs::create_dir_all(base.join("sub/deep")).unwrap();
        std::fs::write(base.join("f.txt"), "x").unwrap();
        clear_dir(&base).unwrap();
        assert!(base.is_dir() && std::fs::read_dir(&base).unwrap().count() == 0);
        std::fs::remove_dir_all(&base).ok();
    }
}
