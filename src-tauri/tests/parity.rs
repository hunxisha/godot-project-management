//! 双端逐字节 diff 验收(#[ignore]):读 TEMP/gpm-parity/api.json,build_library 到 rust/ 子目录,
//! 与 Node 管线(docmodel.js)产物逐字节比对。运行:cargo test --test parity -- --ignored --nocapture
#![cfg(test)]
use godot_workshop::docs;

#[tokio::test]
#[ignore]
async fn node_rust_slices_are_byte_identical() {
    let base = std::path::PathBuf::from(std::env::var("TEMP").unwrap()).join("gpm-parity");
    let api_text = std::fs::read_to_string(base.join("api.json")).expect("先跑 node 侧生成 fixture");
    let api: serde_json::Value = serde_json::from_str(&api_text).unwrap();
    let out = base.join("rust");
    let _ = std::fs::remove_dir_all(&out);
    let (count, _) = docs::build_library(&api, &std::collections::HashMap::new(), &out).unwrap();
    assert_eq!(count, 4);
    // 逐字节比对(node/ 与 rust/ 下同名文件)
    let mut mismatches = Vec::new();
    for name in ["Node.json", "Sprite.json", "Vector2.json", "@GlobalScope.json", "index.json"] {
        let n = std::fs::read(base.join("node").join(name)).unwrap();
        let r = std::fs::read(out.join(name)).unwrap();
        if n != r {
            mismatches.push(format!(
                "{name} 不一致\n  node: {}\n  rust: {}",
                String::from_utf8_lossy(&n),
                String::from_utf8_lossy(&r)
            ));
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n---\n"));
}
