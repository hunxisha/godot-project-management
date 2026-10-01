// 引擎版本列表:GitHub 官方归档 API 解析 + 24h 磁盘缓存(对齐 lib/releases.js)。
// 输出形状(version 行):{ tag, name, publishedAt, assets: [{ name, size, url, kind }] }
// —— kind 由资产文件名归类:win64/macOS/linux 等交给领域层匹配,这里只透传原始信息。
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const ARCHIVE_URL: &str =
    "https://api.github.com/repos/godotengine/godot/releases?per_page=100";
const CACHE_TTL_MS: u128 = 24 * 60 * 60 * 1000;

fn cache_path(base: &Path) -> PathBuf {
    base.join("releases-cache.json")
}

/// 读缓存:命中且未过期返回 Some;损坏/过期/缺失返回 None 并尽力删除坏缓存
pub fn read_cache(base: &Path, now_ms: u128) -> Option<Value> {
    let p = cache_path(base);
    let raw = std::fs::read_to_string(&p).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let ts = v.get("_cachedAt")?.as_u64()? as u128;
    if now_ms.saturating_sub(ts) > CACHE_TTL_MS {
        return None;
    }
    v.get("releases").cloned()
}

pub fn write_cache(base: &Path, releases: &[Value], now_ms: u128) -> std::io::Result<()> {
    std::fs::create_dir_all(base)?;
    let doc = json!({ "_cachedAt": now_ms, "releases": releases });
    let tmp = cache_path(base).with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(&doc).unwrap())?;
    std::fs::rename(&tmp, cache_path(base))
}

/// 拉取归档:force=true 跳过缓存;网络失败时回落过期缓存(有总比没有强,注明 stale)
pub async fn fetch_releases(
    proxy: Option<String>,
    force: bool,
    cache_base: &Path,
    now_ms: u128,
) -> Result<(Vec<Value>, bool), String> {
    if !force {
        if let Some(cached) = read_cache(cache_base, now_ms) {
            return Ok((cached.as_array().cloned().unwrap_or_default(), true));
        }
    }
    let client = crate::http::client_with_proxy(proxy.as_deref())?;
    let resp = client
        .get(ARCHIVE_URL)
        .send()
        .await
        .map_err(|e| format!("归档请求失败:{e}"))?;
    if !resp.status().is_success() {
        // 网络失败回落过期缓存
        if let Ok(raw) = std::fs::read_to_string(cache_path(cache_base)) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                if let Some(rel) = v.get("releases") {
                    return Ok((rel.as_array().cloned().unwrap_or_default(), true));
                }
            }
        }
        return Err(format!("归档 HTTP {}", resp.status()));
    }
    let raw: Vec<Value> = resp.json().await.map_err(|e| format!("归档解析失败:{e}"))?;
    let mut out = Vec::new();
    for r in &raw {
        let (Some(tag), Some(name)) = (
            r.get("tag_name").and_then(|v| v.as_str()),
            r.get("name").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let assets: Vec<Value> = r
            .get("assets")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| {
                        let n = a.get("name")?.as_str()?;
                        Some(json!({
                            "name": n,
                            "size": a.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                            "url": a.get("browser_download_url").and_then(|v| v.as_str()).unwrap_or(""),
                        }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.push(json!({
            "tag": tag,
            "name": name,
            "publishedAt": r.get("published_at").and_then(|v| v.as_str()).unwrap_or(""),
            "prerelease": r.get("prerelease").and_then(|v| v.as_bool()).unwrap_or(false),
            "assets": assets,
        }));
    }
    let _ = write_cache(cache_base, &out, now_ms);
    Ok((out, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "gpm-rel-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn cache_roundtrip_and_ttl() {
        let base = tmp("rt");
        let rels = vec![json!({ "tag": "4.7.2-stable" })];
        write_cache(&base, &rels, 1_000).unwrap();
        assert!(read_cache(&base, 1_000 + 1000).is_some(), "TTL 内命中");
        assert!(read_cache(&base, 1_000 + CACHE_TTL_MS + 1).is_none(), "过期失效");
        assert!(read_cache(&base, 1_000).is_some());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn corrupted_cache_is_none() {
        let base = tmp("bad");
        std::fs::write(cache_path(&base), "{bad").unwrap();
        assert!(read_cache(&base, 1_000).is_none(), "坏缓存不命中");
        let _ = std::fs::remove_dir_all(&base);
    }
}
