// 项目管理域:project.godot 解析、添加/扫描/移除、自动绑定引擎版本。
// 语义逐条对齐 lib/projects.js(文件 id = 路径 md5、版本匹配 major.minor → config_version 兜底、
// 扫描忽略清单、重复添加保留本地字段)。
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

pub const IGNORE_DIRS: [&str; 8] = [".git", ".godot", "node_modules", ".import", "build", "dist", "addons", ".zcode"];

/// 解析 project.godot 文本(Godot INI 风格):返回 (name, config_version, engine_version, icon, has_plugins)
pub fn parse_project_godot_text(text: &str) -> (String, u32, Option<String>, Option<String>, bool) {
    let mut section = String::new();
    let mut name = String::new();
    let mut icon: Option<String> = None;
    let mut config_version: u32 = 0;
    let mut engine_version: Option<String> = None;
    let mut has_plugins = false;

    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            section = t[1..t.len() - 1].to_string();
            continue;
        }
        let Some((key, raw)) = t.split_once('=') else { continue };
        let key = key.trim();
        let value = raw.trim().trim_end_matches(',').trim();
        match key {
            "config_version" => config_version = value.parse().unwrap_or(0),
            "config/name" => name = unquote(value),
            "config/icon" => icon = Some(unquote(value)),
            "config/features" => {
                if let Some(v) = extract_quoted(value) {
                    engine_version = Some(v);
                }
            }
            "enabled" if section == "editor_plugins" => {
                if value.contains('"') {
                    has_plugins = true;
                }
            }
            _ => {}
        }
    }
    (name, config_version, engine_version, icon, has_plugins)
}

fn unquote(v: &str) -> String {
    let t = v.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

/// config/features 里取第一个带引号的片段(如 "4.3")
fn extract_quoted(v: &str) -> Option<String> {
    let start = v.find('"')? + 1;
    let end = v[start..].find('"')? + start;
    Some(v[start..end].to_string())
}

/// 项目根目录:输入可能是目录,也可能是 project.godot 文件本身
pub fn resolve_project_root(input: &Path) -> PathBuf {
    if input.is_file() {
        return input.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| input.to_path_buf());
    }
    input.to_path_buf()
}

/// 项目文档 id = "godot/project/" + 绝对路径 md5(与 Node 版逐字节一致,迁移兼容的关键)
pub fn project_doc_id(root_dir: &Path) -> String {
    let abs = std::fs::canonicalize(root_dir).unwrap_or_else(|_| root_dir.to_path_buf());
    format!("godot/project/{}", md5_hex(abs.to_string_lossy().as_bytes()))
}

pub fn md5_hex(bytes: &[u8]) -> String {
    let d = md5::compute(bytes);
    format!("{d:x}")
}

/// 为项目自动选版本(纯函数便于断言):engineVersion major.minor 前缀匹配 →
/// config_version 兜底(>=5 走 4.x,否则 3.x)→ 同版本标准版优先、其次新装的在前。
pub fn match_version(info: &(u32, Option<String>), versions: &[Value]) -> Option<String> {
    if versions.is_empty() {
        return None;
    }
    let wanted: Option<String> = info.1.as_ref().map(|e| {
        e.split('.').take(2).collect::<Vec<_>>().join(".")
    });
    fn tag(v: &Value) -> &str { v.get("tag").and_then(|t| t.as_str()).unwrap_or("") }
    let mut pool: Vec<Value> = Vec::new();
    if let Some(w) = &wanted {
        let hit: Vec<Value> = versions
            .iter()
            .filter(|v| {
                let t = tag(v);
                t.starts_with(&format!("{w}.")) || t == w || t.starts_with(&format!("{w}-"))
            })
            .cloned()
            .collect();
        pool.extend(hit);
    }
    if pool.is_empty() {
        let major = if info.0 >= 5 { "4" } else { "3" };
        let hit: Vec<Value> = versions
            .iter()
            .filter(|v| tag(v).starts_with(&format!("{major}.")))
            .cloned()
            .collect();
        pool.extend(hit);
    }
    if pool.is_empty() {
        return None;
    }
    pool.sort_by_key(|v| {
        let std = if v.get("variant").and_then(|x| x.as_str()) == Some("standard") { 0 } else { 1 };
        (std, std::cmp::Reverse(v.get("installedAt").and_then(|x| x.as_u64()).unwrap_or(0)))
    });
    pool.first().and_then(|v| v.get("id").and_then(|i| i.as_str())).map(String::from)
}

/// 递归扫描含 project.godot 的目录(跳过 IGNORE_DIRS)
pub fn scan_projects(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    walk(root, &mut out, 0);
    out
}

fn walk(dir: &Path, out: &mut Vec<String>, depth: usize) {
    if depth > 8 {
        return;
    }
    if dir.join("project.godot").is_file() {
        out.push(dir.to_string_lossy().into_owned());
        // 项目目录内不再下钻(其子目录不会是独立项目)
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if IGNORE_DIRS.contains(&name.as_str()) {
            continue;
        }
        walk(&p, out, depth + 1);
    }
}

/// 路径安全检查(zip-slip 同款思路:拒绝逃逸组件的显示用途)
pub fn has_escape_component(p: &Path) -> bool {
    p.components().any(|c| !matches!(c, Component::Normal(_) | Component::RootDir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SAMPLE: &str = r#"; Engine configuration file.
config_version=5

[application]
config/name="My Game"
config/description="desc,"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.3", "Forward Plus")
config/icon="res://icon.svg"

[editor_plugins]
enabled=PackedStringArray("res://addons/foo/plugin.cfg", "res://addons/bar/plugin.cfg")
"#;

    #[test]
    fn parse_project_godot_sample() {
        let (name, cfg, ev, icon, plugins) = parse_project_godot_text(SAMPLE);
        assert_eq!(name, "My Game");
        assert_eq!(cfg, 5);
        assert_eq!(ev.as_deref(), Some("4.3"), "features 第一个带引号片段是引擎版本");
        assert_eq!(icon.as_deref(), Some("res://icon.svg"));
        assert!(plugins, "editor_plugins.enabled 有引号即视为有插件");
    }

    #[test]
    fn doc_id_matches_node_md5() {
        // 与 Node 版同源:md5("E:\\Godot\\Demo") 的十六进制小写
        assert_eq!(md5_hex(b"E:\\Godot\\Demo"), md5_hex(b"E:\\Godot\\Demo"));
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72", "md5 标准测试向量");
    }

    #[test]
    fn version_matching_rules() {
        let versions = vec![
            json!({ "id": "v1", "tag": "4.2.1-stable", "variant": "standard", "installedAt": 100 }),
            json!({ "id": "v2", "tag": "4.3.2-stable", "variant": "standard", "installedAt": 300 }),
            json!({ "id": "v3", "tag": "4.3.2-mono", "variant": "mono", "installedAt": 500 }),
            json!({ "id": "v4", "tag": "3.6.1-stable", "variant": "standard", "installedAt": 200 }),
        ];
        // engineVersion 4.3 → 4.3 池,标准版优先(即使 mono 更新)
        assert_eq!(match_version(&(5, Some("4.3".into())), &versions), Some("v2".to_string()));
        // 无 engineVersion:config_version>=5 → 4.x 池,新装在前
        assert_eq!(match_version(&(5, None), &versions), Some("v2".to_string()));
        // config_version=4 → 3.x 池
        assert_eq!(match_version(&(4, None), &versions), Some("v4".to_string()));
        // config_version 缺失(0)同走 3.x
        assert_eq!(match_version(&(0, None), &versions), Some("v4".to_string()));
        // engineVersion 无命中 → 同样走 config_version 兜底(与 Node 版一致,非返回 None)
        assert_eq!(match_version(&(0, Some("9.9".into())), &versions), Some("v4".to_string()));
    }

    #[test]
    fn scan_skips_ignored_dirs() {
        let base = std::env::temp_dir().join(format!(
            "gpm-scan-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let mk = |rel: &str| {
            let p = base.join(rel);
            std::fs::create_dir_all(&p).unwrap();
            std::fs::write(p.join("project.godot"), "config_version=5\n").unwrap();
            p
        };
        let a = mk("projA");
        mk("projB/nested");
        std::fs::create_dir_all(base.join("projA/.godot")).unwrap();
        mk("projA/.godot/hidden");
        std::fs::create_dir_all(base.join("empty")).unwrap();
        let mut found = scan_projects(&base);
        found.sort();
        assert_eq!(found.len(), 2, "忽略清单生效(.godot 内的项目不算): {found:?}");
        assert!(found.contains(&a.to_string_lossy().into_owned()));
        std::fs::remove_dir_all(&base).ok();
    }
}

// ---------- 新建项目 ----------

/// 渲染器选项 → (feature, method, mobileMethod)
pub fn renderer_opts(renderer: &str) -> (&'static str, &'static str, &'static str) {
    match renderer {
        "mobile" => ("Mobile", "mobile", "mobile"),
        "gl_compatibility" => ("GL Compatibility", "gl_compatibility", "gl_compatibility"),
        _ => ("Forward Plus", "forward_plus", "mobile"),
    }
}

/// Windows 非法文件名字符过滤(与 Node 版同一字符集)
pub fn sanitize_name(name: &str) -> String {
    name.chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

/// 生成 project.godot 文本(与 Node 版逐行一致)
pub fn godot_ini(name: &str, version_str: &str, renderer: &str) -> String {
    let (feature, method, mobile) = renderer_opts(renderer);
    let name_clean = name.replace('"', "");
    format!(
        "; Engine configuration file.\n; It's best edited using the editor UI and not directly,\n; since the parameters that go here are not all obvious.\n;\n; Format:\n;   [section] ; section goes between []\n;   param=value ; assign values to parameters\n\nconfig_version=5\n\n[application]\n\nconfig/name=\"{name_clean}\"\nconfig/features=PackedStringArray(\"{version_str}\", \"{feature}\")\nconfig/icon=\"res://icon.svg\"\n\n[rendering]\n\nrenderer/rendering_method=\"{method}\"\nrenderer/rendering_method.mobile=\"{mobile}\"\n"
    )
}

/// 从已装版本 tag 提取 major.minor(兜底 4.3)
pub fn version_str_from_tag(tag: &str) -> String {
    let t = tag.trim_start_matches('v');
    // Node 正则 ^v?(\d+\.\d+) 语义:两段都必须是纯数字
    let b: Vec<&str> = t.split('.').collect();
    if b.len() >= 2 {
        let major: String = b[0].chars().take_while(|c| c.is_ascii_digit()).collect();
        let minor: String = b[1].chars().take_while(|c| c.is_ascii_digit()).collect();
        if !major.is_empty() && !minor.is_empty() {
            return format!("{major}.{minor}");
        }
    }
    "4.3".to_string()
}

pub const GITIGNORE: &str = include_str!("../assets/gitignore");
pub const GITATTRIBUTES: &str = include_str!("../assets/gitattributes");
pub const EDITORCONFIG: &str = include_str!("../assets/editorconfig");
pub const ICON_SVG: &str = include_str!("../assets/icon.svg");

/// git init + 首次提交;git 不可用/提交失败不影响项目创建
pub fn init_git_repo(project_dir: &Path) -> (bool, Option<String>, bool) {
    let run = |args: &[&str]| -> Result<String, String> {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(project_dir)
            .output()
            .map_err(|e| format!("git 不可用:{e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    };
    let _ = std::fs::write(project_dir.join(".gitignore"), GITIGNORE);
    let _ = std::fs::write(project_dir.join(".gitattributes"), GITATTRIBUTES);
    if let Err(e) = run(&["init"]) {
        return (false, Some(e), false);
    }
    let _ = run(&["add", "."]);
    match run(&["commit", "-m", "Initial commit"]) {
        Ok(_) => (true, None, true),
        Err(e) => (true, Some(e), false),
    }
}

/// 新建项目(文件层;登记走 add_project 编排)。返回 (dir, git 结果)
pub fn create_project_files(
    parent_dir: &Path,
    name: &str,
    renderer: &str,
    version_tag: Option<&str>,
    git_init: bool,
) -> Result<(PathBuf, Option<(bool, Option<String>, bool)>), String> {
    let safe = sanitize_name(name);
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err("项目名称无效".into());
    }
    let project_dir = parent_dir.join(&safe);
    if project_dir.exists() {
        return Err(format!("目录已存在:{safe}"));
    }
    std::fs::create_dir_all(&project_dir).map_err(|e| format!("创建目录失败:{e}"))?;
    let vs = version_str_from_tag(version_tag.unwrap_or(""));
    std::fs::write(project_dir.join("project.godot"), godot_ini(name, &vs, renderer))
        .map_err(|e| format!("写 project.godot 失败:{e}"))?;
    std::fs::write(project_dir.join("icon.svg"), ICON_SVG).map_err(|e| format!("写图标失败:{e}"))?;
    std::fs::write(project_dir.join(".editorconfig"), EDITORCONFIG).map_err(|e| format!("写 editorconfig 失败:{e}"))?;
    let git = if git_init { Some(init_git_repo(&project_dir)) } else { None };
    Ok((project_dir, git))
}

#[cfg(test)]
mod create_tests {
    use super::*;

    #[test]
    fn name_sanitize_and_version_extract() {
        assert_eq!(sanitize_name("  My:Game? "), "MyGame");
        assert_eq!(sanitize_name("普通名字"), "普通名字", "中文不受影响");
        assert_eq!(sanitize_name("a/b\\c|d*e"), "abcde");
        assert_eq!(version_str_from_tag("4.3.2-stable"), "4.3");
        assert_eq!(version_str_from_tag("v4.4-dev6"), "4.4");
        assert_eq!(version_str_from_tag(""), "4.3", "兜底 4.3");
    }

    #[test]
    fn ini_matches_node_shape() {
        let ini = godot_ini("Demo", "4.3", "forward_plus");
        assert!(ini.contains("config/name=\"Demo\""));
        assert!(ini.contains("config/features=PackedStringArray(\"4.3\", \"Forward Plus\")"));
        assert!(ini.contains("renderer/rendering_method=\"forward_plus\""));
        assert!(ini.contains("renderer/rendering_method.mobile=\"mobile\""));
        let ini2 = godot_ini("X", "3.6", "gl_compatibility");
        assert!(ini2.contains("\"GL Compatibility\"") && ini2.contains("gl_compatibility"));
    }

    #[test]
    fn create_files_and_git() {
        let base = std::env::temp_dir().join(format!(
            "gpm-create-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let (dir, git) = create_project_files(&base, "Test Game", "forward_plus", Some("4.3.2-stable"), false).unwrap();
        assert!(dir.join("project.godot").is_file());
        assert!(dir.join("icon.svg").is_file());
        assert_eq!(std::fs::read_to_string(dir.join(".editorconfig")).unwrap(), EDITORCONFIG);
        assert!(git.is_none(), "未要求 git 时不初始化");
        // git 路径(git 可用时走完三态之一)
        let (dir2, git2) = create_project_files(&base, "Git Game", "mobile", Some("4.3-stable"), true).unwrap();
        let (initialized, _err, committed) = git2.unwrap();
        assert!(dir2.join(".gitignore").is_file());
        if initialized {
            assert!(dir2.join(".git").exists(), "git 可用则目录存在;committed={committed}");
        }
        // 重复名拒绝
        assert!(create_project_files(&base, "Test Game", "forward_plus", None, false).is_err());
        std::fs::remove_dir_all(&base).ok();
    }
}
