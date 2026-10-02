// 项目启动域:以引擎可执行拉起项目(editor=编辑器 / run=直接运行)。
// 参数构造与 lib/launcher.js 一致:--path 指向项目目录;编辑器模式由引擎自身记忆,无需额外参数。
use serde_json::json;
use std::path::Path;
use std::process::{Command, Stdio};

/// 构造引擎命令行(纯函数便于断言)
pub fn build_args(action: &str) -> Vec<String> {
    match action {
        "run" => vec!["--path".into()],
        // editor 是默认行为,显式 -e 与 ZTools 版保持一致
        _ => vec!["-e".into(), "--path".into()],
    }
}

/// 拉起项目;返回 (是否成功, 错误)。进程脱离父进程(spawn 不等待)。
pub fn launch(exe: &Path, project_dir: &Path, action: &str) -> Result<(), String> {
    if !exe.is_file() {
        return Err(format!("引擎可执行不存在:{}", exe.display()));
    }
    if !project_dir.join("project.godot").is_file() {
        return Err(format!("目录不是 Godot 项目:{}", project_dir.display()));
    }
    let mut cmd = Command::new(exe);
    cmd.args(build_args(action))
        .arg(project_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    cmd.spawn().map_err(|e| format!("启动失败:{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arg_shapes() {
        assert_eq!(build_args("editor"), vec!["-e", "--path"]);
        assert_eq!(build_args("run"), vec!["--path"]);
    }

    #[test]
    fn rejects_missing_exe_and_project() {
        let tmp = std::env::temp_dir().join(format!("gpm-launch-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        // exe 不存在
        let r = launch(Path::new(&tmp.join("nope.exe")), Path::new(&tmp), "editor");
        assert!(r.is_err());
        // exe 有了但目录没 project.godot
        let fake_exe = tmp.join("fake.exe");
        std::fs::write(&fake_exe, "x").unwrap();
        let r2 = launch(Path::new(&fake_exe), Path::new(&tmp), "editor");
        assert!(r2.is_err());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn json_shape_note() {
        // 占位:确保 json 宏可用(域内返回体在 main.rs 组装)
        let _ = json!({ "ok": true });
    }
}
