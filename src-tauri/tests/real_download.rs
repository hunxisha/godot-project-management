//! 真实下载验收(#[ignore],显式跑:cargo test --test real_download -- --ignored)
//! 验证三件事:① releases 拉取真实归档;② .part 截断后续传到完成;
//! ③ 产物 zip 能被安全解压打开。需代理时设置 HTTPS_PROXY。
#![cfg(test)]

use serde_json::json;
use std::path::PathBuf;

#[tokio::test]
#[ignore]
async fn real_download_resume_and_extract() {
    let base = std::env::temp_dir().join(format!("gpm-accept-{}", std::process::id()));
    std::fs::create_dir_all(&base).unwrap();
    let proxy = std::env::var("HTTPS_PROXY").ok();

    // ① 真实归档(强制绕过缓存)
    let (rels, stale) = godot_workshop::releases::fetch_releases(proxy.clone(), true, &base, 1).await.unwrap();
    assert!(!stale && !rels.is_empty(), "归档非空");
    let stable = rels
        .iter()
        .find(|r| r["tag"].as_str().unwrap_or("").contains("4.3-stable"))
        .expect("归档含 4.3-stable");
    let assets = stable["assets"].as_array().unwrap();
    let asset = godot_workshop::versions::pick_asset(assets, "windows").expect("windows 资产在列");

    // ② 下载 → 截断 1MB → 续传完成
    let url = asset["url"].as_str().unwrap().to_string();
    let dest: PathBuf = base.join("godot-win64.zip");
    let (n1, _) = godot_workshop::http::download(
        godot_workshop::http::DownloadOptions { url: url.clone(), dest: dest.clone(), proxy: proxy.clone(), sha256: None },
        |_, _| {},
    )
    .await
    .unwrap();
    let part = dest.with_extension("part");
    assert!(!part.exists(), "成功后 .part 已改名");
    // 截断:把目标文件末尾 1MB 剪回 .part,模拟中断
    let cut = (std::fs::metadata(&dest).unwrap().len() - 1024 * 1024) as usize;
    let mut head = std::fs::read(&dest).unwrap();
    head.truncate(cut);
    std::fs::write(&part, head).unwrap();
    std::fs::remove_file(&dest).unwrap();
    let (n2, _) = godot_workshop::http::download(
        godot_workshop::http::DownloadOptions { url, dest: dest.clone(), proxy, sha256: None },
        |_, _| {},
    )
    .await
    .unwrap();
    assert_eq!(n1, n2, "续传后总字节数一致(完整文件 {n1} vs {n2})");

    // ③ 产物可安全解压
    let out = base.join("unzipped");
    let files = godot_workshop::extract::unzip(&dest, &out).unwrap();
    assert!(files > 0, "解压出 {files} 个文件");
    let exes: Vec<_> = std::fs::read_dir(&out).unwrap()
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect();
    assert!(exes.iter().any(|f| f.ends_with(".exe")), "解压出引擎可执行: {:?}", exes);
    let _ = json!({});
    std::fs::remove_dir_all(&base).ok();
}
