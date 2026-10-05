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

/// 自定义模板目录名的白名单(与 JS 端 `isValidVersionDirName` 逐字镜像):
/// 字母数字开头,只含字母数字 / 点 / 下划线 / 连字符,1–64 字符。
/// versionDir 会被 `path.join(base, versionDir)`——放行 `/`、`\`、`..` 就等于让
/// 「目录名」把模板装到任意位置;版本串(`4.3.stable` / `4.4.dev6`)本来就不需要别的字符。
pub fn is_valid_version_dir_name(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 64 { return false; }
    let first = b[0];
    if !(first.is_ascii_alphanumeric()) { return false; }
    b.iter().all(|&c| c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-')
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
/// `vd_override` 提供时作为目标目录名(须过 `is_valid_version_dir_name` 白名单),
/// 缺省 tag 派生 —— 与 JS 端同一条「统一取法」的显式参数半边(记录里已有的值由调用方先查)。
pub fn install_from_stage(
    stage_dir: &Path,
    base: &Path,
    tag: &str,
    platform: &str,
    vd_override: Option<&str>,
) -> Result<(usize, String), String> {
    let src = stage_dir.join("templates");
    let src = if src.is_dir() { src } else { stage_dir.to_path_buf() };
    let n = verify_templates_dir(&src, platform)?;
    let vd = match vd_override {
        Some(d) => {
            if !is_valid_version_dir_name(d) {
                return Err(format!("模板目录名不合法({d}):只允许字母数字、点、下划线、连字符"));
            }
            d.to_string()
        }
        None => version_dir_for_tag(tag),
    };
    let dest = base.join(&vd);
    if dest.exists() {
        // 覆盖 = 旧目录进回收站(与显式卸载同一通道)。remove_dir_all 是永久删除:
        // 「装错了想退回」会变成不可能,移不走就报错让用户先手动卸载。
        crate::fsutil::delete_to_trash(&dest).map_err(|e| format!("无法移走旧模板({e}),可先卸载后再装"))?;
    }
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
    fn version_dir_name_whitelist() {
        // 与 JS 端 isValidVersionDirName 镜像;穿越形态一律拒
        assert!(is_valid_version_dir_name("4.3.stable"));
        assert!(is_valid_version_dir_name("4.4.dev6"));
        assert!(is_valid_version_dir_name("4.3.stable.mono"));
        assert!(!is_valid_version_dir_name(""), "空串拒");
        assert!(!is_valid_version_dir_name("../evil"), "『..』拒");
        assert!(!is_valid_version_dir_name("a/b"), "分隔符拒");
        assert!(!is_valid_version_dir_name("a\\b"), "分隔符拒");
        assert!(!is_valid_version_dir_name(".hidden"), "点开头拒(隐匿目录)");
        assert!(!is_valid_version_dir_name("带中文"), "非 ASCII 拒(版本串不含)");
        assert!(!is_valid_version_dir_name(&"x".repeat(65)), "超长拒");
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
        let (n, vd) = install_from_stage(&stage, &base, "4.3.2-stable", "windows", None).unwrap();
        assert_eq!(n, 2);
        assert_eq!(vd, "4.3.2.stable");
        assert!(base.join("4.3.2.stable").join("windows_release_x86_64.exe").is_file());
        // vd_override:自定义目录名生效(装到指定目录而不是 tag 派生)。
        // 注意第一次安装已把 stage/templates move 走(moveSync 语义),这里重建夹具
        std::fs::create_dir_all(stage.join("templates")).unwrap();
        std::fs::write(stage.join("templates").join("windows_release_x86_64.exe"), "x").unwrap();
        std::fs::write(stage.join("templates").join("windows_debug_x86_64.exe"), "x").unwrap();
        let (n2, vd2) = install_from_stage(&stage, &base, "4.3.2-stable", "windows", Some("4.3.stable.custom")).unwrap();
        assert_eq!(vd2, "4.3.stable.custom");
        assert_eq!(n2, 2);
        assert!(base.join("4.3.stable.custom").is_dir());
        // 非法目录名在动盘之前被拒(同样重建夹具:上一次安装又把 templates 移走了)
        std::fs::create_dir_all(stage.join("templates")).unwrap();
        std::fs::write(stage.join("templates").join("windows_release_x86_64.exe"), "x").unwrap();
        assert!(install_from_stage(&stage, &base, "4.3.2-stable", "windows", Some("../evil")).is_err());
        assert!(!base.parent().unwrap().join("evil").exists(), "穿越形态没被装到外面");
        // 覆盖重装:旧目录(自定义名)被移走、新内容就位(delete_to_trash 在非 Windows 是直接删,效果一致)
        let (n3, vd3) = install_from_stage(&stage, &base, "4.3.2-stable", "windows", Some("4.3.stable.custom")).unwrap();
        assert_eq!(vd3, "4.3.stable.custom");
        assert_eq!(n3, 1);
        assert!(base.join("4.3.stable.custom").join("windows_release_x86_64.exe").is_file());
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
