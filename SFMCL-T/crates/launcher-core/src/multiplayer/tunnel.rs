//! Account-free, session-owned Cloudflare Quick Tunnels. Only the room's
//! loopback WebSocket listener is exposed; never the game's port or RPC portal.
use super::{components, engine};
use crate::{
    downloads::{DownloadManager, DownloadSpec},
    jobs::Job,
};
use anyhow::{ensure, Context, Result};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub const VERSION: &str = "2026.10.7";

struct Release {
    arch: &'static str,
    size: u64,
    hash: &'static str,
}

fn release() -> Result<Release> {
    ensure!(cfg!(windows), "联机入口目前支持 Windows");
    match std::env::consts::ARCH {
        "x86_64" => Ok(Release {
            arch: "amd64",
            size: 55390512,
            hash: "2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343",
        }),
        "x86" => Ok(Release {
            arch: "386",
            size: 38097032,
            hash: "88c6b972b410db0e26745f593510d772c825a13c5a2374819e3f13a05b333082",
        }),
        _ => anyhow::bail!("当前处理器架构尚无已验证的隧道组件"),
    }
}

fn path(root: &Path, release: &Release) -> PathBuf {
    root.join(format!("cloudflared-{VERSION}-{}", release.arch))
        .join("cloudflared.exe")
}

fn install(root: &Path, input: &Path, release: &Release) -> Result<PathBuf> {
    ensure!(
        std::fs::metadata(input)?.len() == release.size
            && components::digest(input)? == release.hash,
        "隧道组件校验失败，请重新准备组件"
    );
    let target = path(root, release);
    let directory = target.parent().context("隧道组件目录无效")?;
    std::fs::create_dir_all(directory)?;
    crate::paths::atomic_write(&target, &std::fs::read(input)?)?;
    crate::paths::atomic_write(
        &directory.join("LICENSE"),
        include_bytes!("../../../../licenses/cloudflared/LICENSE"),
    )?;
    Ok(target)
}

#[cfg(test)]
pub(super) fn install_for_test(root: &Path, input: &Path) -> Result<PathBuf> {
    install(root, input, &release()?)
}

pub async fn prepare(
    root: &Path,
    downloads: &Arc<DownloadManager>,
    job: &Job,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    components::check_cancel(job, cancel)?;
    job.step(0, "检查 Cloudflare Tunnel 组件");
    let release = release()?;
    let target = path(root, &release);
    if components::digest(&target).is_ok_and(|hash| hash == release.hash) {
        return Ok(target);
    }
    let filename = format!("cloudflared-windows-{}.exe", release.arch);
    let spec = DownloadSpec {
        url: format!(
            "https://github.com/cloudflare/cloudflared/releases/download/{VERSION}/{filename}"
        ),
        path: filename,
        size: Some(release.size),
        sha1: None,
        sha512: None,
    };
    components::download_component(
        root,
        spec,
        format!("Cloudflare Tunnel {VERSION} · 联机入口"),
        downloads,
        job,
        cancel,
        |input| install(root, input, &release),
    )
    .await
}

fn endpoint_from_line(line: &str) -> Option<String> {
    // Never follow arbitrary URLs printed in diagnostics or release notes.
    static ENDPOINT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let pattern = ENDPOINT.get_or_init(|| {
        regex::Regex::new(r"https://([a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com)(?:[\s/|]|$)")
            .unwrap()
    });
    pattern
        .captures(line)
        .map(|capture| format!("wss://{}", &capture[1]))
}

/// TLS and the WebSocket upgrade are checked before publishing an invitation.
/// This client deliberately does not use EasyTier's permissive TLS verifier.
async fn probe(endpoint: &str) -> Result<()> {
    let response = reqwest::Client::builder()
        .http1_only()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()?
        .get(endpoint.replacen("wss://", "https://", 1))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .send()
        .await
        .context("无法连接联机入口")?;
    ensure!(
        response.status() == reqwest::StatusCode::SWITCHING_PROTOCOLS
            && response
                .headers()
                .get("Sec-WebSocket-Accept")
                .is_some_and(|value| value == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="),
        "联机入口未完成 WebSocket 握手"
    );
    Ok(())
}

pub struct Tunnel {
    #[cfg(windows)]
    process: super::owned_process::OwnedProcess,
    reader: tokio::task::JoinHandle<()>,
    _work: tempfile::TempDir,
    metrics: u16,
    pub endpoint: String,
}

impl Tunnel {
    pub async fn start(
        executable: &Path,
        root: &Path,
        listener: u16,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        #[cfg(not(windows))]
        {
            let _ = (executable, root, listener, cancel);
            anyhow::bail!("联机入口目前支持 Windows");
        }
        #[cfg(windows)]
        {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let work = tempfile::Builder::new()
                .prefix("tunnel-session-")
                .tempdir_in(root)?;
            // Explicit empty configuration and isolated cwd prevent the user's
            // named-tunnel configuration or credentials from being picked up.
            let config = work.path().join("config.yml");
            std::fs::write(&config, "{}\n")?;
            let metrics = engine::free_port()?;
            let metrics_address = format!("127.0.0.1:{metrics}");
            let origin = format!("http://127.0.0.1:{listener}");
            let (process, output) = super::owned_process::OwnedProcess::spawn_logged(
                executable,
                &[
                    "tunnel",
                    "--config",
                    &config.to_string_lossy(),
                    "--no-autoupdate",
                    "--url",
                    &origin,
                    "--protocol",
                    "http2",
                    "--metrics",
                    &metrics_address,
                    "--loglevel",
                    "info",
                ],
                work.path(),
            )?;
            let (send, mut receive) = tokio::sync::watch::channel(None::<String>);
            let reader = tokio::spawn(async move {
                let mut output = BufReader::new(tokio::fs::File::from_std(output));
                loop {
                    let mut line = String::new();
                    match output.read_line(&mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) if line.len() > 16384 => break,
                        Ok(_) => {
                            #[cfg(test)]
                            if std::env::var_os("SFMCL_TUNNEL_DIAGNOSTICS").is_some() {
                                eprint!("{line}");
                            }
                            if let Some(endpoint) = endpoint_from_line(&line) {
                                send.send_replace(Some(endpoint));
                            }
                        }
                    }
                }
            });
            let mut tunnel = Self {
                process,
                reader,
                _work: work,
                metrics,
                endpoint: String::new(),
            };
            let started = std::time::Instant::now();
            let mut stage = "Cloudflare 临时地址创建超时";
            loop {
                ensure!(
                    tunnel.running(),
                    "Cloudflare Tunnel 意外退出，请重新创建房间"
                );
                ensure!(
                    !tunnel.reader.is_finished(),
                    "无法读取 Cloudflare Tunnel 状态，请重新创建房间"
                );
                let endpoint = receive.borrow_and_update().clone();
                if let Some(endpoint) = endpoint {
                    stage = "Cloudflare 隧道连接超时";
                    if tunnel.healthy().await {
                        stage = "Cloudflare 联机入口校验超时";
                        if probe(&endpoint).await.is_ok() {
                            tunnel.endpoint = endpoint;
                            return Ok(tunnel);
                        }
                    }
                }
                ensure!(
                    started.elapsed() < Duration::from_secs(90),
                    "{stage}，请检查网络后重试"
                );
                tokio::select! {
                    _ = cancel.cancelled() => anyhow::bail!("创建房间已取消"),
                    _ = tokio::time::sleep(Duration::from_millis(500)) => {},
                }
            }
        }
    }

    pub fn running(&self) -> bool {
        #[cfg(windows)]
        {
            self.process.running()
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    pub async fn healthy(&self) -> bool {
        if !self.running() {
            return false;
        }
        let Ok(client) = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
        else {
            return false;
        };
        client
            .get(format!("http://127.0.0.1:{}/ready", self.metrics))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
    }

    pub fn stop(&self) -> Result<()> {
        #[cfg(windows)]
        {
            self.process.stop()?;
        }
        self.reader.abort();
        Ok(())
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_quick_tunnel_endpoints_are_accepted() {
        assert_eq!(
            endpoint_from_line("INF | https://quiet-blue-bird.trycloudflare.com |"),
            Some("wss://quiet-blue-bird.trycloudflare.com".into())
        );
        for line in [
            "https://developers.cloudflare.com",
            "https://trycloudflare.com",
            "https://x.trycloudflare.com.evil.test",
            "https://x.trycloudflare.com@evil.test",
            "https://user@x.trycloudflare.com",
        ] {
            assert!(endpoint_from_line(line).is_none());
        }
    }

    #[test]
    fn unverified_tunnel_executable_is_never_installed() {
        let work = tempfile::tempdir().unwrap();
        let input = work.path().join("fake.exe");
        std::fs::write(&input, b"not the official binary").unwrap();
        let release = release().unwrap();
        assert!(install(work.path(), &input, &release).is_err());
        assert!(!path(work.path(), &release).exists());
    }
}
