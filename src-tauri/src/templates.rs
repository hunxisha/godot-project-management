// 导出模板域:模板目录规则(对齐 Godot 自身)与安装/卸载/状态。
// 目录:{数据目录}/export_templates/{versionDir}/,versionDir = tag 的「- → .」;
// 数据目录:exe 旁 ._sc_ → 自包含;否则 win=%APPDATA%/Godot、mac=~/Library/.../Godot、linux=~/.local/share/godot。
// tpz 即 zip(内含 templates/ 顶层目录):下载 → 解压 → 校验当前平台文件 → moveSync 就位。
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// versionDir:tag 的「- → .」(4.3.2-stable → 4.3.2.stable)
pub fn version_dir_for_tag(tag: &str) -> String {
    tag.replace('-', ".")
}

/// 模板数据目录(对齐 lib/templates.js 的 resolveTemplatesBase)
pub fn templates_base(exe_path: Option<&Path>, home: &Path, appdata: Option<&Path>, platform: &str) -> PathBuf {
    if let Some(exe) = exe_path {
        let exe_dir = exe.parent().unwrap_or(Path::new("."));
        if exe_dir.join("._sc_").is_file() {
            return exe_dir.join("editor_data").join("export_templates");
        }
    }
    match platform {
        "windows" => {
            let appdata = appdata
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| home.join("AppData").join("Roaming"));
            appdata.join("Godot").join("export_templates")
        }
        "macos" => home.join("Library").join("Application Support").join("Godot").join("export_templates"),
        _ => home.join(".local").join("share").join("godot").join("export_templates"),
    }
}

/// 校验解压出的模板目录:非空且含当前平台前缀文件(windows_/macos/linux)
pub fn verify_templates_dir(dir: &Path, platform: &str) -> Result<usize, String> {
    let mut entries: Vec<String> = Vec::new();
    for e in std::fs::read_dir(dir).map_err(|e| format!("读目录失败:{e}"))?.flatten() {
        entries.push(e.file_name().to_string_lossy().into_owned());
    }
    if entries.is_empty() {
        return Err("模板包不完整:目录为空".into());
    }
    let prefix = match platform {
        "windows" => "windows_",
        "macos" => "macos",
        _ => "linux",
    };
    if !entries.iter().any(|n| n.to_lowercase().starts_with(prefix)) {
        return Err(format!("模板包不完整:未找到当前平台的模板文件({platform})"));
    }
    Ok(entries.len())
}

/// 模板包内当前平台的预编辑器文件名前缀(校验用)
pub fn status(base: &Path, tag: &str) -> Value {
    let dir = base.join(version_dir_for_tag(tag));
    let installed = dir.is_dir();
    json!({
        "versionDir": version_dir_for_tag(tag),
        "installed": installed,
        "tracked": installed,
        "path": dir.to_string_lossy(),
    })
}

/// 从已下载并解压出的暂存目录(tpz 解压产物,含 templates/ 顶层)安装到 base。
/// 返回 (files, versionDir)。调用方负责下载与暂存清理。
pub fn install_from_stage(stage_dir: &Path, base: &Path, tag: &str, platform: &str) -> Result<(usize, String), String> {
    let src = stage_dir.join("templates");
    let src = if src.is_dir() { src } else { stage_dir.to_path_buf() };
    let n = verify_templates_dir(&src, platform)?;
    let vd = version_dir_for_tag(tag);
    let dest = base.join(&vd);
    let _ = std::fs::remove_dir_all(&dest);
    if let Some(p) = base.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("创建数据目录失败:{e}"))?;
    }
    std::fs::create_dir_all(base).map_err(|e| format!("创建模板根失败:{e}"))?;
    crate::fsutil::move_sync(&src, &dest).map_err(|e| format!("模板就位失败:{e}"))?;
    Ok((n, vd))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_dir_mapping() {
        assert_eq!(version_dir_for_tag("4.3.2-stable"), "4.3.2.stable");
        assert_eq!(version_dir_for_tag("4.3-stable"), "4.3.stable");
        assert_eq!(version_dir_for_tag("4.4-dev6"), "4.4.dev6");
    }

    #[test]
    fn base_resolution_rules() {
        let home = Path::new("/home/u");
        let appdata = Path::new("C:\\Users\\u\\AppData\\Roaming");
        // 自包含:exe 旁 ._sc_ 优先
        let tmp = std::env::temp_dir().join(format!("gpm-tpl-{}-sc", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("._sc_"), "").unwrap();
        let exe = tmp.join("Godot.exe");
        let r = templates_base(Some(&exe), home, Some(appdata), "windows");
        assert_eq!(r, tmp.join("editor_data").join("export_templates"), "自包含模式跟 exe 走");
        // 常规平台目录
        assert_eq!(templates_base(Some(Path::new("C:\\e\\g.exe")), home, Some(appdata), "windows"), appdata.join("Godot").join("export_templates"));
        assert_eq!(templates_base(None, home, None, "macos"), home.join("Library").join("Application Support").join("Godot").join("export_templates"));
        assert_eq!(templates_base(None, home, None, "linux"), home.join(".local").join("share").join("godot").join("export_templates"));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn verify_and_install_flow() {
        let base = std::env::temp_dir().join(format!("gpm-tpl-{}-ins", std::process::id()));
        let stage = base.join("stage");
        std::fs::create_dir_all(stage.join("templates")).unwrap();
        std::fs::write(stage.join("templates").join("windows_release_x86_64.exe"), "x").unwrap();
        std::fs::write(stage.join("templates").join("windows_debug_x86_64.exe"), "x").unwrap();
        // 平台校验:有 windows_ 前缀 → 通过
        let (n, vd) = install_from_stage(&stage, &base, "4.3.2-stable", "windows").unwrap();
        assert_eq!(n, 2);
        assert_eq!(vd, "4.3.2.stable");
        assert!(base.join("4.3.2.stable").join("windows_release_x86_64.exe").is_file());
        // 错平台 → 拒绝
        std::fs::create_dir_all(stage.join("templates2")).unwrap();
        std::fs::write(stage.join("templates2").join("linux_release"), "x").unwrap();
        assert!(verify_templates_dir(&stage.join("templates2"), "windows").is_err());
        // 空目录 → 拒绝
        std::fs::create_dir_all(stage.join("empty")).unwrap();
        assert!(verify_templates_dir(&stage.join("empty"), "windows").is_err());
        std::fs::remove_dir_all(&base).ok();
    }
}
