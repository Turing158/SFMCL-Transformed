//! Account-free, session-owned Cloudflare Quick Tunnels. Only the room's
//! loopback WebSocket listener is exposed; never the game's port or RPC portal.
use super::{components, engine};
use crate::{
    downloads::{DownloadManager, DownloadSpec},
    jobs::Job,
};
use anyhow::{ensure, Context, Result};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

pub const VERSION: &str = "2026.10.7";

struct Release {
    arch: &'static str,
    size: u64,
    hash: &'static str,
    sha512: &'static str,
}

fn release() -> Result<Release> {
    ensure!(cfg!(windows), "联机入口目前支持 Windows");
    match std::env::consts::ARCH {
        "x86_64" => Ok(Release {
            arch: "amd64",
            size: 55390512,
            hash: "2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343",
            sha512: "e6a8f57c45a08c81a956d640503125f35ea9dd9bac5aad8095a8ac06b58b04c7bfa97622d18c43c64a53df53f1f6fd4804dd51f716175b9b29fb4d0c8116ebc4",
        }),
        "x86" => Ok(Release {
            arch: "386",
            size: 38097032,
            hash: "88c6b972b410db0e26745f593510d772c825a13c5a2374819e3f13a05b333082",
            sha512: "32fc76768ee3324d6a8a843079f0c2c1f97b75c9a9e939004682a91b20b5f0fdf323ac38637107118e289a63a5e82f4292ce31a6425e408a63352850e3dad2ce",
        }),
        _ => anyhow::bail!("当前处理器架构尚无已验证的隧道组件"),
    }
}

fn path(root: &Path, release: &Release) -> PathBuf {
    root.join(format!("cloudflared-{VERSION}-{}", release.arch))
        .join("cloudflared.exe")
}

pub fn installed(root: &Path) -> bool {
    let Ok(release) = release() else { return false };
    let target = path(root, &release);
    std::fs::metadata(&target).is_ok_and(|metadata| metadata.len() == release.size)
        && components::digest(&target).is_ok_and(|hash| hash == release.hash)
}

pub struct Installation {
    pub executable: PathBuf,
    pub version: String,
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

fn command_version(text: &str) -> Option<&str> {
    text.lines().find_map(|line| {
        let version = line
            .trim()
            .strip_prefix("cloudflared version ")?
            .split_whitespace()
            .next()?;
        semver::Version::parse(version).ok()?;
        Some(version)
    })
}

async fn probe_command(
    executable: &Path,
    job: &Job,
    cancel: &CancellationToken,
) -> Result<Option<String>> {
    components::check_cancel(job, cancel)?;
    let mut command = tokio::process::Command::new(executable);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let Ok(mut child) = command.spawn() else {
        return Ok(None);
    };
    let mut stdout = child
        .stdout
        .take()
        .context("无法读取隧道组件版本")?
        .take(4097);
    let mut stderr = child
        .stderr
        .take()
        .context("无法读取隧道组件版本")?
        .take(4097);
    let read_version = async {
        let mut output = Vec::new();
        let mut errors = Vec::new();
        let (_, _, status) = tokio::try_join!(
            stdout.read_to_end(&mut output),
            stderr.read_to_end(&mut errors),
            child.wait(),
        )?;
        ensure!(status.success() && output.len() <= 4096 && errors.len() <= 4096);
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output),
            String::from_utf8_lossy(&errors),
        );
        Ok::<_, anyhow::Error>(command_version(&text).map(str::to_owned))
    };
    let version = tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        _ = job.cancel.cancelled() => None,
        result = tokio::time::timeout(Duration::from_secs(3), read_version) => {
            result.ok().and_then(Result::ok).flatten()
        },
    };
    if version.is_none() {
        let _ = child.kill().await;
    }
    components::check_cancel(job, cancel)?;
    Ok(version)
}

async fn system_installation(
    search_path: Option<&OsStr>,
    job: &Job,
    cancel: &CancellationToken,
) -> Result<Option<Installation>> {
    if let Some(search_path) = search_path {
        for directory in std::env::split_paths(search_path) {
            components::check_cancel(job, cancel)?;
            let candidate = directory.join(if cfg!(windows) {
                "cloudflared.exe"
            } else {
                "cloudflared"
            });
            if !candidate.is_file() {
                continue;
            }
            // The tunnel runs in an isolated working directory, so retain an
            // absolute executable path instead of resolving PATH again later.
            let Ok(executable) = std::fs::canonicalize(candidate) else {
                continue;
            };
            if let Some(version) = probe_command(&executable, job, cancel).await? {
                return Ok(Some(Installation {
                    executable,
                    version,
                }));
            }
        }
    }
    Ok(None)
}

pub async fn prepare(
    root: &Path,
    downloads: &Arc<DownloadManager>,
    job: &Job,
    cancel: &CancellationToken,
    step_offset: usize,
) -> Result<Installation> {
    components::check_cancel(job, cancel)?;
    job.step(step_offset, "检查系统 cloudflared 命令");
    let search_path = std::env::var_os("PATH");
    if let Some(installation) = system_installation(search_path.as_deref(), job, cancel).await? {
        job.step(
            step_offset,
            format!("使用已安装的 Cloudflare Tunnel {}", installation.version),
        );
        return Ok(installation);
    }
    job.step(step_offset, "检查启动器内的 Cloudflare Tunnel 组件");
    let release = release()?;
    let target = path(root, &release);
    if installed(root) {
        return Ok(Installation {
            executable: target,
            version: VERSION.into(),
        });
    }
    let filename = format!("cloudflared-windows-{}.exe", release.arch);
    job.log("Cloudflare Tunnel 组件自动测速，使用与 EasyTier 共用的官方直连及加速源".into());
    let spec = DownloadSpec {
        url: format!(
            "https://github.com/cloudflare/cloudflared/releases/download/{VERSION}/{filename}"
        ),
        path: filename,
        size: Some(release.size),
        sha1: None,
        sha512: None,
    };
    let executable =
        download_release(root, &release, spec, downloads, job, cancel, step_offset).await?;
    Ok(Installation {
        executable,
        version: VERSION.into(),
    })
}

async fn download_release(
    root: &Path,
    release: &Release,
    mut spec: DownloadSpec,
    downloads: &Arc<DownloadManager>,
    job: &Job,
    cancel: &CancellationToken,
    step_offset: usize,
) -> Result<PathBuf> {
    // Check the digest during transfer so a corrupt accelerator can be replaced.
    // The installed executable is also checked against the pinned SHA-256.
    spec.sha512 = Some(release.sha512.into());
    components::download_component(
        root,
        spec,
        format!("Cloudflare Tunnel {VERSION} · 联机入口"),
        downloads,
        job,
        cancel,
        step_offset,
        |input| install(root, input, release),
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

    fn job() -> Arc<Job> {
        crate::jobs::Jobs::default().create(
            crate::jobs::JobKind::Other,
            "准备 Cloudflare Tunnel".into(),
            &["检查组件", "获取组件", "校验并安装"],
        )
    }

    #[test]
    fn recognizes_cloudflared_version_output_without_requiring_bundled_version() {
        assert_eq!(
            command_version("cloudflared version 2026.10.1 (built 2026-10-15T09:15 UTC)\n"),
            Some("2026.10.1"),
        );
        assert_eq!(
            command_version("\ncloudflared version 2025.7.0\n"),
            Some("2025.7.0"),
        );
        for text in [
            "",
            "cloudflared version",
            "cloudflared version unavailable",
            "another-program version 2026.10.1",
        ] {
            assert!(command_version(text).is_none());
        }
    }

    #[tokio::test]
    async fn missing_and_unrunnable_system_commands_allow_installation_fallback() {
        let work = tempfile::tempdir().unwrap();
        let job = job();
        let cancel = CancellationToken::new();
        assert!(system_installation(None, &job, &cancel)
            .await
            .unwrap()
            .is_none());
        let search_path = std::env::join_paths([work.path()]).unwrap();
        assert!(system_installation(Some(&search_path), &job, &cancel)
            .await
            .unwrap()
            .is_none());
        std::fs::write(
            work.path().join(if cfg!(windows) {
                "cloudflared.exe"
            } else {
                "cloudflared"
            }),
            b"not an executable",
        )
        .unwrap();
        assert!(system_installation(Some(&search_path), &job, &cancel)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn cancelled_command_detection_stops_preparation() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let job = job();
        assert!(probe_command(Path::new("cloudflared"), &job, &cancel)
            .await
            .is_err());
        assert!(job.cancel.is_cancelled());
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires a working cloudflared command on PATH"]
    async fn installed_system_command_skips_download_and_local_installation() {
        let work = tempfile::Builder::new()
            .prefix("system cloudflared test ")
            .tempdir()
            .unwrap();
        let downloads = DownloadManager::open(&work.path().join("downloads"), 1).unwrap();
        let installation = prepare(
            work.path(),
            &downloads,
            &job(),
            &CancellationToken::new(),
            0,
        )
        .await
        .unwrap();
        let executable = installation.executable;
        assert!(semver::Version::parse(&installation.version).is_ok());
        assert!(executable.is_absolute() && executable.is_file());
        assert!(!executable.starts_with(work.path()));
        assert!(downloads.snapshots().await.is_empty());
        assert!(!path(work.path(), &release().unwrap()).exists());
    }

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

    #[tokio::test]
    async fn fastest_tunnel_source_falls_back_on_digest_failure_and_cleans_scratch() {
        use axum::{http::HeaderMap, routing::get, Router};
        use sha2::Digest;
        use std::sync::atomic::{AtomicUsize, Ordering};

        async fn source(
            body: Vec<u8>,
            delay: u64,
        ) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
            let transfers = Arc::new(AtomicUsize::new(0));
            let counter = transfers.clone();
            let app = Router::new().route(
                "/component.exe",
                get(move |headers: HeaderMap| {
                    let body = body.clone();
                    let counter = counter.clone();
                    async move {
                        if headers
                            .get("range")
                            .is_none_or(|range| range != "bytes=0-65535")
                        {
                            counter.fetch_add(1, Ordering::SeqCst);
                        }
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        body
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/component.exe", listener.local_addr().unwrap());
            let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            (url, transfers, task)
        }

        let work = tempfile::tempdir().unwrap();
        let body = b"verified cloudflared fixture".to_vec();
        let release = Release {
            arch: "test",
            size: body.len() as u64,
            hash: Box::leak(hex::encode(sha2::Sha256::digest(&body)).into_boxed_str()),
            sha512: Box::leak(hex::encode(sha2::Sha512::digest(&body)).into_boxed_str()),
        };
        let mut corrupt = body.clone();
        corrupt[0] ^= 1;
        let (fast_url, fast_count, fast_server) = source(corrupt, 1).await;
        let (good_url, good_count, good_server) = source(body, 80).await;
        let downloads = DownloadManager::open(&work.path().join("downloads"), 1).unwrap();
        downloads
            .sources()
            .register(&fast_url, vec![good_url, fast_url.clone()]);
        let job = crate::jobs::Jobs::default().create(
            crate::jobs::JobKind::Other,
            "准备联机组件".into(),
            &[
                "检查 EasyTier",
                "获取 EasyTier",
                "安装 EasyTier",
                "检查 Cloudflare Tunnel",
                "获取 Cloudflare Tunnel",
                "安装 Cloudflare Tunnel",
            ],
        );
        let spec = DownloadSpec {
            url: fast_url,
            path: "component.exe".into(),
            size: Some(release.size),
            sha1: None,
            sha512: None,
        };
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            download_release(
                work.path(),
                &release,
                spec,
                &downloads,
                &job,
                &CancellationToken::new(),
                3,
            ),
        )
        .await
        .unwrap();
        job.finish(
            &outcome
                .as_ref()
                .map(|_| ())
                .map_err(|error| anyhow::anyhow!("{error:#}")),
        );
        let executable = outcome.unwrap();
        fast_server.abort();
        good_server.abort();
        let _ = fast_server.await;
        let _ = good_server.await;
        assert_eq!(components::digest(&executable).unwrap(), release.hash);
        assert_eq!(fast_count.load(Ordering::SeqCst), 1);
        assert_eq!(good_count.load(Ordering::SeqCst), 1);
        assert_eq!(job.snapshot().current_step, 5);
        let snapshot = downloads.snapshots().await.pop().unwrap();
        assert_eq!(snapshot.files[0].attempts, 2);
        assert!(snapshot.files[0].spec.sha512.is_some());
        assert!(!snapshot.root.exists());
        assert!(!work
            .path()
            .join("downloads/cache/tmcl-downloads")
            .join(&snapshot.id)
            .exists());
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "downloads and verifies cloudflared from shared GitHub sources; requires no system command on PATH"]
    async fn live_cloudflared_download_uses_shared_sources_and_official_hashes() {
        let work = tempfile::tempdir().unwrap();
        let downloads = DownloadManager::open(&work.path().join("downloads"), 1).unwrap();
        downloads
            .sources()
            .set_mode(crate::minecraft::download_source::MinecraftDownloadSource::Official);
        let release = release().unwrap();
        let official = format!("https://github.com/cloudflare/cloudflared/releases/download/{VERSION}/cloudflared-windows-{}.exe", release.arch);
        let job = job();
        let cancel = CancellationToken::new();
        let ordered = downloads
            .sources()
            .order(
                &crate::http_client().unwrap(),
                &crate::download_sources::candidates(&official),
                &cancel,
            )
            .await
            .unwrap();
        println!(
            "Cloudflare Tunnel measured source order: {:?}",
            ordered
                .iter()
                .map(|url| reqwest::Url::parse(url)
                    .unwrap()
                    .host_str()
                    .unwrap()
                    .to_owned())
                .collect::<Vec<_>>()
        );
        let mut preparation = Box::pin(prepare(work.path(), &downloads, &job, &cancel, 0));
        let outcome = tokio::select! {
            result = &mut preparation => result,
            _ = tokio::time::sleep(Duration::from_secs(90)) => {
                cancel.cancel(); let _ = preparation.await;
                Err(anyhow::anyhow!("Cloudflare Tunnel public download timed out"))
            }
        };
        let installation = outcome.unwrap();
        assert!(installed(work.path()));
        assert_eq!(installation.version, VERSION);
        let snapshot = downloads.snapshots().await.pop().unwrap();
        assert_eq!(snapshot.status, crate::downloads::Status::Completed);
        assert!(snapshot.files[0].spec.sha512.is_some());
        assert!(!snapshot.root.exists());
        println!(
            "Verified {} bytes in {} transfer attempt(s)",
            release.size, snapshot.files[0].attempts
        );
    }
}
