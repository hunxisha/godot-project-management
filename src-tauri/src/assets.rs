// 市场资产域:plugin.cfg 嗅探、插件目录定位、启用改写、安装清单。
// 判据铁律:zip 内容里有没有 plugin.cfg 是插件与纯素材的唯一可靠分界(type 字段不可信)。
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// 递归收集 plugin.cfg 路径(限深 5,跳过隐藏目录)
pub fn find_plugin_cfgs(dir: &Path) -> Vec<PathBuf> {
    find_cfgs_inner(dir, 0)
}

fn find_cfgs_inner(dir: &Path, depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if depth > 5 {
        return out;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            out.extend(find_cfgs_inner(&p, depth + 1));
        } else if name == "plugin.cfg" {
            out.push(p);
        }
    }
    out
}

/// 安装源目录列表:取 plugin.cfg 所在目录的父目录(去重);
/// 无 plugin.cfg 时回退 addons/(存在)或解压根。
pub fn locate_sources(extract_dir: &Path) -> Vec<PathBuf> {
    let mut sources: Vec<PathBuf> = Vec::new();
    for c in find_plugin_cfgs(extract_dir) {
        // cfg 在 <源>/<插件目录>/plugin.cfg → 父目录的父目录即源
        if let Some(p) = c.parent().and_then(|d| d.parent()) {
            if !sources.contains(&p.to_path_buf()) {
                sources.push(p.to_path_buf());
            }
        }
    }
    if sources.is_empty() {
        let addons = extract_dir.join("addons");
        return vec![if addons.is_dir() { addons } else { extract_dir.to_path_buf() }];
    }
    sources
}

/// 解析 plugin.cfg 的 name/version/author
pub fn parse_plugin_cfg(path: &Path) -> Value {
    let Ok(text) = std::fs::read_to_string(path) else { return json!({}) };
    let mut out = serde_json::Map::new();
    for line in text.lines() {
        let t = line.trim();
        let Some((k, v)) = t.split_once('=') else { continue };
        let k = k.trim();
        let v = v.trim().trim_matches('"');
        if matches!(k, "name" | "version" | "author") {
            out.insert(k.to_string(), json!(v));
        }
    }
    Value::Object(out)
}

/// 在 project.godot 的 [editor_plugins] enabled 行增删插件路径(只精确改写该行;缺 section 追加末尾)
pub fn set_plugin_enabled(project_godot_text: &str, dir_names: &[String], enable: bool) -> String {
    let paths: Vec<String> = dir_names.iter().map(|d| format!("res://addons/{d}/plugin.cfg")).collect();
    let mut current: Vec<String> = Vec::new();
    for line in project_godot_text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("enabled=") {
            let inner = rest.trim().trim_start_matches("PackedStringArray(").trim_end_matches(')');
            let mut items: Vec<String> = Vec::new();
            let mut cur = String::new();
            let mut in_q = false;
            for ch in inner.chars() {
                match ch {
                    '"' => {
                        in_q = !in_q;
                        if !in_q && !cur.is_empty() {
                            items.push(std::mem::take(&mut cur));
                        }
                    }
                    c if in_q => cur.push(c),
                    _ => {}
                }
            }
            current = items;
        }
    }
    for p in &paths {
        if enable {
            if !current.contains(p) {
                current.push(p.clone());
            }
        } else {
            current.retain(|x| x != p);
        }
    }
    let arr = if current.is_empty() {
        "PackedStringArray()".to_string()
    } else {
        format!("PackedStringArray({})", current.iter().map(|p| format!("\"{p}\"")).collect::<Vec<_>>().join(", "))
    };
    let mut replaced = false;
    let mut out_lines: Vec<String> = Vec::new();
    let mut in_section = false;
    let mut section_written = false;
    for line in project_godot_text.lines() {
        let t = line.trim();
        if t == "[editor_plugins]" {
            in_section = true;
            section_written = true;
            out_lines.push(line.to_string());
            out_lines.push(format!("enabled={arr}"));
            replaced = true;
            continue;
        }
        if t.starts_with('[') && t.ends_with(']') && in_section {
            in_section = false;
        }
        if in_section && t.starts_with("enabled=") {
            continue; // 已在 section 开头重写
        }
        out_lines.push(line.to_string());
    }
    if !replaced && !section_written {
        out_lines.push("[editor_plugins]".to_string());
        out_lines.push(format!("enabled={arr}"));
    }
    let mut s = out_lines.join("\n");
    if !project_godot_text.ends_with('\n') && !s.ends_with('\n') {
        // 保持原文件是否带尾换行的形态
        let _ = &mut s;
    }
    s
}

/// 收集目录下全部文件(相对路径,/ 分隔),供素材安装清单记录
pub fn collect_files(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    walk_files(root, root, &mut out);
    out.sort();
    out
}

fn walk_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_files(root, &p, out);
        } else {
            let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
            out.push(rel);
        }
    }
}

/// 素材安装记录(kind=asset)的 db 文档体
pub fn asset_record(asset_id: &str, project_id: &str, title: &str, version: &str, top_entries: &[String], installed_paths: &[String], dest_root: &str) -> Value {
    json!({
        "_id": format!("godot/asset/{project_id}/{asset_id}"),
        "assetId": asset_id,
        "projectId": project_id,
        "title": title,
        "versionString": version,
        "kind": "asset",
        "dirNames": top_entries,
        "installedPaths": installed_paths,
        "destRoot": dest_root,
        "installedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_tree(base: &Path, files: &[(&str, &str)]) {
        for (rel, body) in files {
            let p = base.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
    }

    #[test]
    fn sniffing_and_sources() {
        let base = std::env::temp_dir().join(format!("gpm-asset-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        // 结构 1:addons/x/plugin.cfg(标准)
        write_tree(&base, &[("addons/myplug/plugin.cfg", "[plugin]\nname=\"MyPlug\"\nversion=\"1.0\"")]);
        let cfgs = find_plugin_cfgs(&base);
        assert_eq!(cfgs.len(), 1);
        let sources = locate_sources(&base);
        assert_eq!(sources[0], base.join("addons"), "标准结构源 = addons/");

        // 结构 2:wrapper/x/addons/y/plugin.cfg(包装层)
        let b2 = base.join("w");
        write_tree(&b2, &[("wrapper/inner/addons/real/plugin.cfg", "[plugin]")]);
        let sources2 = locate_sources(&b2);
        assert_eq!(sources2[0], b2.join("wrapper/inner/addons"), "取 cfg 父目录的父目录");

        // 无 plugin.cfg → 素材,回退根
        let b3 = base.join("mat");
        write_tree(&b3, &[("sprites/a.png", "x")]);
        assert!(find_plugin_cfgs(&b3).is_empty());
        assert_eq!(locate_sources(&b3)[0], b3, "素材回退解压根");

        // 隐藏目录被跳过
        let b4 = base.join("hid");
        write_tree(&b4, &[(".hidden/plugin.cfg", "x")]);
        assert!(find_plugin_cfgs(&b4).is_empty(), "隐藏目录不参与嗅探");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn plugin_cfg_parse() {
        let base = std::env::temp_dir().join(format!("gpm-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let f = base.join("plugin.cfg");
        std::fs::write(&f, "[plugin]\n\nname=\"My Plug\"\nversion=\"1.2.3\"\nauthor=\"Dev\"\nscript=\"a.gd\"\n").unwrap();
        let cfg = parse_plugin_cfg(&f);
        assert_eq!(cfg["name"], "My Plug");
        assert_eq!(cfg["version"], "1.2.3");
        assert_eq!(cfg["author"], "Dev");
        assert!(cfg.get("script").is_none(), "只取三个字段");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn enable_line_rewrite() {
        let godot_ini = "[application]\nconfig/name=\"X\"\n\n[editor_plugins]\nenabled=PackedStringArray(\"res://addons/a/plugin.cfg\")\n\n[rendering]\n";
        // 启用 b:追加
        let out = set_plugin_enabled(godot_ini, &["b".to_string()], true);
        assert!(out.contains("res://addons/a/plugin.cfg") && out.contains("res://addons/b/plugin.cfg"));
        assert!(out.contains("[rendering]"), "后续 section 不受影响");
        // 禁用 a:仅删 a
        let out2 = set_plugin_enabled(&out, &["a".to_string()], false);
        assert!(!out2.contains("res://addons/a/plugin.cfg") && out2.contains("res://addons/b/plugin.cfg"));
        // 无 section 的项目文件 → 追加末尾
        let out3 = set_plugin_enabled("config_version=5\n", &["c".to_string()], true);
        assert!(out3.contains("[editor_plugins]") && out3.contains("res://addons/c/plugin.cfg"));
        // 全禁后空数组
        let out4 = set_plugin_enabled(&out2, &["b".to_string()], false);
        assert!(out4.contains("enabled=PackedStringArray()"));
    }

    #[test]
    fn manifest_collection() {
        let base = std::env::temp_dir().join(format!("gpm-man-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        write_tree(&base, &[("sprites/a.png", "x"), ("sprites/sub/b.png", "y"), ("readme.md", "z")]);
        let files = collect_files(&base);
        assert_eq!(files, vec!["readme.md", "sprites/a.png", "sprites/sub/b.png"], "相对路径 + 排序");
        std::fs::remove_dir_all(&base).ok();
    }
}
