use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio_util::sync::CancellationToken;

// Pinned from the publisher's artifact/56.json. Verify every cached/downloaded
// JAR before adding executable code to the JVM; never trust a skin site's JAR.
const URL: &str = "https://authlib-injector.yushi.moe/artifact/56/authlib-injector-1.2.8.jar";
const SHA256: &str = "9c7f4343e6c82034958ffb48c14a2cb0c85928be7283103ce17da00c6d5a7b10";
const MAX_BYTES: usize = 16 * 1024 * 1024;
static DOWNLOAD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(super) async fn prepare(
    root: &Path,
    server: &str,
    client: &reqwest::Client,
    cancel: &CancellationToken,
) -> Result<String> {
    let server = crate::accounts::yggdrasil_server_url(server)?;
    let path = crate::paths::safe_join(root, ".tmcl/authlib-injector/authlib-injector-1.2.8.jar")?;
    ensure(&path, URL, SHA256, client, cancel).await?;
    Ok(format!("-javaagent:{}={server}", path.to_string_lossy()))
}

fn matches(bytes: &[u8], checksum: &str) -> bool {
    bytes.starts_with(b"PK") && hex::encode(Sha256::digest(bytes)) == checksum
}

async fn ensure(
    path: &Path,
    url: &str,
    checksum: &str,
    client: &reqwest::Client,
    cancel: &CancellationToken,
) -> Result<()> {
    let _guard = tokio::select! {
        _ = cancel.cancelled() => bail!("启动已取消"),
        guard = DOWNLOAD.lock() => guard,
    };
    if tokio::fs::metadata(path)
        .await
        .is_ok_and(|m| m.len() <= MAX_BYTES as u64)
    {
        if let Ok(bytes) = tokio::fs::read(path).await {
            if matches(&bytes, checksum) {
                return Ok(());
            }
        }
    }
    let download = async {
        let mut response = client
            .get(url)
            .timeout(std::time::Duration::from_secs(120))
            .send()
            .await
            .context("无法下载 authlib-injector，请检查网络后重试")?
            .error_for_status()?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > MAX_BYTES {
                bail!("验证组件大小异常");
            }
            bytes.extend_from_slice(&chunk);
        }
        if !matches(&bytes, checksum) {
            bail!("authlib-injector 校验失败，请重试");
        }
        Ok::<_, anyhow::Error>(bytes)
    };
    let bytes = tokio::select! {
        _ = cancel.cancelled() => bail!("启动已取消"),
        bytes = download => bytes?,
    };
    crate::paths::atomic_write(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn downloads_are_verified_before_replacing_corrupt_cache() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("game with spaces/agent.jar");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/agent.jar", listener.local_addr().unwrap());
        let router = axum::Router::new().fallback(|| async { b"PK-valid-download".to_vec() });
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let client = crate::http_client().unwrap();
        let cancel = CancellationToken::new();
        let hash = hex::encode(Sha256::digest(b"PK-valid-download"));
        assert!(ensure(&path, &url, SHA256, &client, &cancel).await.is_err());
        assert!(!path.exists());
        ensure(&path, &url, &hash, &client, &cancel).await.unwrap();
        std::fs::write(&path, b"PK-corrupt").unwrap();
        ensure(&path, &url, &hash, &client, &cancel).await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"PK-valid-download");
        server.abort();
        ensure(&path, &url, &hash, &client, &cancel).await.unwrap();
    }

    #[tokio::test]
    async fn verified_cache_is_reused_and_corruption_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent.jar");
        let content = b"PK-test-agent";
        let checksum = hex::encode(Sha256::digest(content));
        std::fs::write(&path, content).unwrap();
        let client = crate::http_client().unwrap();
        let cancel = CancellationToken::new();
        ensure(
            &path,
            "http://127.0.0.1:1/missing",
            &checksum,
            &client,
            &cancel,
        )
        .await
        .unwrap();
        std::fs::write(&path, b"PK-corrupted").unwrap();
        assert!(ensure(
            &path,
            "http://127.0.0.1:1/missing",
            &checksum,
            &client,
            &cancel
        )
        .await
        .is_err());
        cancel.cancel();
        assert!(ensure(&path, URL, SHA256, &client, &cancel).await.is_err());
    }
}
