// HTTP 下载器:断点续传(.part + Range)+ 统一 UA + 可选代理 + SHA-256 校验。
// 对齐 lib/http.js 的行为面:UA 常量、.part 临时文件、主地址失败回落由调用方(领域层)负责。
// 验收:引擎/模板下载走本模块;诊断三链路复用同一 client 构造(与设置页「网络诊断」同口径)。
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Instant;
use tokio::io::{AsyncSeekExt, AsyncWriteExt, SeekFrom};

pub const USER_AGENT: &str = "ztools-godot-plugin";

pub fn build_client(proxy: Option<&str>) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder().user_agent(USER_AGENT);
    if let Some(p) = proxy {
        if !p.is_empty() {
            b = b.proxy(reqwest::Proxy::all(p).map_err(|e| format!("代理配置无效:{e}"))?);
        }
    }
    b.build().map_err(|e| format!("客户端构建失败:{e}"))
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

pub struct DownloadOptions {
    pub url: String,
    pub dest: std::path::PathBuf,
    pub proxy: Option<String>,
    pub sha256: Option<String>,
}

/// 断点续传下载:已有 dest.part 的字节数作为 Range 起点(206 才续传,200 从头来),
/// 成功后原子改名为 dest。返回 (总字节数, 全文件 sha256)。
/// on_progress(received, total) 以「含续传起点」的口径回报,分母与进度条语义一致。
pub async fn download(
    opts: DownloadOptions,
    mut on_progress: impl FnMut(u64, Option<u64>) + Send,
) -> Result<(u64, String), String> {
    let client = build_client(opts.proxy.as_deref())?;
    let part = opts.dest.with_extension("part");
    let mut start: u64 = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);

    let mut req = client.get(&opts.url);
    if start > 0 {
        req = req.header("Range", format!("bytes={start}-"));
    }
    let resp = req.send().await.map_err(|e| format!("请求失败:{e}"))?;
    let status = resp.status();
    if status != reqwest::StatusCode::OK && status != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!("HTTP {status}"));
    }
    // 服务器不支持续传(对 Range 回了 200):丢弃旧 part 从头下
    let resume_ok = status == reqwest::StatusCode::PARTIAL_CONTENT;
    if !resume_ok {
        start = 0;
    }
    let total = resp.content_length().map(|l| l + start);

    let mut file = if resume_ok {
        let mut f = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .await
            .map_err(|e| format!("打开续传文件失败:{e}"))?;
        // 已有字节计入哈希:SHA-256 必须覆盖完整文件
        let existing = tokio::fs::read(&part).await.map_err(|e| format!("读续传文件失败:{e}"))?;
        let mut full = Sha256::new();
        full.update(&existing);
        f.seek(SeekFrom::End(0)).await.map_err(|e| e.to_string())?;
        (f, Some(full))
    } else {
        let f = tokio::fs::File::create(&part).await.map_err(|e| format!("创建文件失败:{e}"))?;
        (f, Some(Sha256::new()))
    };
    let (mut file, mut hasher) = file;
    let mut hasher = hasher.take().unwrap();

    let mut received = start;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断:{e}"))?;
        file.write_all(&chunk).await.map_err(|e| format!("写入失败:{e}"))?;
        hasher.update(&chunk);
        received += chunk.len() as u64;
        on_progress(received, total);
    }
    file.flush().await.map_err(|e| format!("刷盘失败:{e}"))?;
    drop(file);

    let hash = hex(&hasher.finalize());
    if let Some(expected) = &opts.sha256 {
        if !expected.is_empty() && !expected.eq_ignore_ascii_case(&hash) {
            return Err(format!("SHA-256 校验失败(期望 {expected},实际 {hash})"));
        }
    }
    tokio::fs::rename(&part, &opts.dest).await.map_err(|e| format!("改名失败:{e}"))?;
    Ok((received, hash))
}

/// 诊断探测:GET 一次,回报可达性与耗时(状态码非 2xx 也算「不可达」口径由调用方定,
/// 这里如实带出 status)。
pub async fn probe(client: &reqwest::Client, url: &str) -> (bool, u128, Option<String>) {
    let t0 = Instant::now();
    match client.get(url).send().await {
        Ok(resp) => {
            let ms = t0.elapsed().as_millis();
            let ok = resp.status().is_success();
            (ok, ms, Some(resp.status().as_u16().to_string()))
        }
        Err(e) => (false, t0.elapsed().as_millis(), Some(e.to_string())),
    }
}

pub use build_client as client_with_proxy;
// build_client 本身也是 pub,此 re-export 只是给调用方一个更达意的名字

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_encoding() {
        assert_eq!(hex(&[0xde, 0xad, 0xbe, 0xef]), "deadbeef");
        assert_eq!(hex(&[]), "");
        assert_eq!(hex(&[0x00, 0xff]), "00ff");
    }

    #[test]
    fn client_construction() {
        assert!(build_client(None).is_ok(), "无代理默认可构建");
        assert!(build_client(Some("ht tp://不合法 url")).is_err(), "解析不了的代理要报可读错误");
    }
}
