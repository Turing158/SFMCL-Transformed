use super::*;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use std::{
    io::{Cursor, Write},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

struct Server {
    failed: AtomicBool,
    slow: bool,
    delay: Duration,
    downloads: AtomicUsize,
    body: Vec<u8>,
}

async fn serve(State(state): State<Arc<Server>>, headers: HeaderMap) -> impl IntoResponse {
    if headers
        .get("range")
        .is_none_or(|range| range != "bytes=0-65535")
    {
        state.downloads.fetch_add(1, Ordering::SeqCst);
    }
    tokio::time::sleep(state.delay).await;
    if state.slow {
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
    if state.failed.load(Ordering::SeqCst) {
        (StatusCode::SERVICE_UNAVAILABLE, vec![])
    } else {
        (StatusCode::OK, state.body.clone())
    }
}

fn fixture() -> (Vec<u8>, Release) {
    // Empty executables are never launched; only download/install integrity is tested.
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for name in ["easytier-core.exe", "easytier-cli.exe"] {
        zip.start_file(
            format!("easytier-windows-x86_64/{name}"),
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"").unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    let mut release = release_for("x86_64").unwrap();
    release.size = bytes.len() as u64;
    release.archive_hash = Box::leak(hex::encode(Sha256::digest(&bytes)).into_boxed_str());
    release.archive_sha512 = Box::leak(hex::encode(sha2::Sha512::digest(&bytes)).into_boxed_str());
    release.core_hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    release.cli_hash = release.core_hash;
    (bytes, release)
}

async fn start_server(state: Arc<Server>) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/component.zip", listener.local_addr().unwrap());
    let router = Router::new()
        .route("/component.zip", get(serve))
        .with_state(state);
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (url, task)
}

async fn wait_for(
    downloads: &DownloadManager,
    status: Status,
) -> crate::downloads::DownloadSnapshot {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(snapshot) = downloads
                .snapshots()
                .await
                .into_iter()
                .find(|s| s.status == status)
            {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}

fn job() -> Arc<Job> {
    crate::jobs::Jobs::default().create(
        crate::jobs::JobKind::Other,
        "准备联机组件".into(),
        &["检查组件", "获取组件", "校验并安装"],
    )
}

fn start_download(
    root: PathBuf,
    release: Release,
    url: String,
    downloads: Arc<DownloadManager>,
    job: Arc<Job>,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<Result<Binaries>> {
    tokio::spawn(async move {
        let spec = DownloadSpec {
            url,
            path: "component.zip".into(),
            size: Some(release.size),
            sha1: None,
            sha512: None,
        };
        let result = download_archive(&root, &release, spec, &downloads, &job, &cancel).await;
        job.finish(
            &result
                .as_ref()
                .map(|_| ())
                .map_err(|error| anyhow::anyhow!("{error:#}")),
        );
        result
    })
}

fn assert_clean(root: &Path, snapshot: &crate::downloads::DownloadSnapshot) {
    assert!(!snapshot.root.exists(), "owned archive directory remained");
    assert!(
        !root
            .join("downloads/cache/tmcl-downloads")
            .join(&snapshot.id)
            .exists(),
        "partial download cache remained"
    );
}

#[tokio::test]
async fn failed_component_download_retries_and_installs_through_download_center() {
    let temp = tempfile::tempdir().unwrap();
    let (body, release) = fixture();
    let state = Arc::new(Server {
        failed: AtomicBool::new(true),
        slow: false,
        delay: Duration::ZERO,
        downloads: AtomicUsize::new(0),
        body,
    });
    let (url, server) = start_server(state.clone()).await;
    let downloads = DownloadManager::open(&temp.path().join("downloads"), 1).unwrap();
    let job = job();
    let task = start_download(
        temp.path().into(),
        release,
        url,
        downloads.clone(),
        job.clone(),
        CancellationToken::new(),
    );
    let failed = wait_for(&downloads, Status::Failed).await;
    assert!(!task.is_finished(), "workflow must await retry");
    state.failed.store(false, Ordering::SeqCst);
    downloads.resume(&failed.id).await.unwrap();
    let files = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    server.abort();
    let _ = server.await;
    assert!(files.core.is_file() && files.cli.is_file());
    assert_eq!(job.snapshot().status, Status::Completed);
    assert_eq!(
        downloads.snapshot(&failed.id).await.unwrap().status,
        Status::Completed
    );
    assert_clean(temp.path(), &failed);
}

#[tokio::test]
async fn component_download_pause_and_both_cancellation_paths_release_owned_files() {
    for from_job in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let (body, release) = fixture();
        let (url, server) = start_server(Arc::new(Server {
            failed: AtomicBool::new(false),
            slow: true,
            delay: Duration::ZERO,
            downloads: AtomicUsize::new(0),
            body,
        }))
        .await;
        let downloads = DownloadManager::open(&temp.path().join("downloads"), 1).unwrap();
        let job = job();
        let task = start_download(
            temp.path().into(),
            release,
            url,
            downloads.clone(),
            job.clone(),
            CancellationToken::new(),
        );
        let active = wait_for(&downloads, Status::Running).await;
        downloads.pause(&active.id).await.unwrap();
        assert_eq!(
            downloads.snapshot(&active.id).await.unwrap().status,
            Status::Paused
        );
        assert!(!task.is_finished());
        downloads.resume(&active.id).await.unwrap();
        if from_job {
            job.cancel.cancel();
        } else {
            downloads.cancel(&active.id).await.unwrap();
        }
        assert!(tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        server.abort();
        let _ = server.await;
        assert_eq!(job.snapshot().status, Status::Cancelled);
        assert_eq!(
            downloads.snapshot(&active.id).await.unwrap().status,
            Status::Cancelled
        );
        assert_clean(temp.path(), &active);
    }
}

#[tokio::test]
async fn downloaded_component_still_requires_the_pinned_archive_hash() {
    let temp = tempfile::tempdir().unwrap();
    let (mut body, mut release) = fixture();
    body[0] ^= 1;
    // Exercise the independent SHA-256 installation check after the download
    // digest has accepted this fixture.
    release.archive_sha512 = Box::leak(hex::encode(sha2::Sha512::digest(&body)).into_boxed_str());
    let (url, server) = start_server(Arc::new(Server {
        failed: AtomicBool::new(false),
        slow: false,
        delay: Duration::ZERO,
        downloads: AtomicUsize::new(0),
        body,
    }))
    .await;
    let downloads = DownloadManager::open(&temp.path().join("downloads"), 1).unwrap();
    let job = job();
    let task = start_download(
        temp.path().into(),
        release,
        url,
        downloads.clone(),
        job.clone(),
        CancellationToken::new(),
    );
    assert!(tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    server.abort();
    let _ = server.await;
    assert_eq!(job.snapshot().status, Status::Failed);
    assert!(!temp
        .path()
        .join("easytier-2.6.4-x86_64/easytier-core.exe")
        .exists());
    assert_clean(temp.path(), &downloads.snapshots().await[0]);
}

#[tokio::test]
async fn fastest_component_source_falls_back_on_archive_digest_failure() {
    let temp = tempfile::tempdir().unwrap();
    let (body, release) = fixture();
    let mut corrupt = body.clone();
    corrupt[0] ^= 1;
    let fast = Arc::new(Server {
        failed: AtomicBool::new(false),
        slow: false,
        delay: Duration::from_millis(1),
        downloads: AtomicUsize::new(0),
        body: corrupt,
    });
    let good = Arc::new(Server {
        failed: AtomicBool::new(false),
        slow: false,
        delay: Duration::from_millis(80),
        downloads: AtomicUsize::new(0),
        body,
    });
    let (fast_url, fast_server) = start_server(fast.clone()).await;
    let (good_url, good_server) = start_server(good.clone()).await;
    let downloads = DownloadManager::open(&temp.path().join("downloads"), 1).unwrap();
    downloads
        .sources()
        .register(&fast_url, vec![good_url, fast_url.clone()]);
    let job = job();
    let task = start_download(
        temp.path().into(),
        release,
        fast_url,
        downloads.clone(),
        job.clone(),
        CancellationToken::new(),
    );
    let files = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    fast_server.abort();
    good_server.abort();
    let _ = fast_server.await;
    let _ = good_server.await;
    assert!(files.core.is_file() && files.cli.is_file());
    assert_eq!(fast.downloads.load(Ordering::SeqCst), 1);
    assert_eq!(good.downloads.load(Ordering::SeqCst), 1);
    let snapshot = downloads.snapshots().await.pop().unwrap();
    assert_eq!(snapshot.files[0].attempts, 2);
    assert!(snapshot.files[0].spec.sha512.is_some());
    assert_eq!(job.snapshot().status, Status::Completed);
    assert_clean(temp.path(), &snapshot);
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "downloads and verifies an official EasyTier ZIP using the documented sources"]
async fn live_easytier_download_uses_measured_sources_and_official_hashes() {
    let temp = tempfile::tempdir().unwrap();
    let release = release().unwrap();
    let official = format!("https://github.com/EasyTier/EasyTier/releases/download/v{VERSION}/easytier-windows-{}-v{VERSION}.zip", release.arch);
    let downloads = DownloadManager::open(&temp.path().join("downloads"), 1).unwrap();
    downloads
        .sources()
        .set_mode(crate::minecraft::download_source::MinecraftDownloadSource::Official);
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
        "EasyTier measured source order: {:?}",
        ordered
            .iter()
            .map(|url| reqwest::Url::parse(url)
                .unwrap()
                .host_str()
                .unwrap()
                .to_owned())
            .collect::<Vec<_>>()
    );
    let job = job();
    let mut preparation = Box::pin(prepare(temp.path(), None, &downloads, &job, &cancel));
    let outcome = tokio::select! {
        result = &mut preparation => result,
        _ = tokio::time::sleep(Duration::from_secs(90)) => {
            cancel.cancel();
            let _ = preparation.await;
            Err(anyhow::anyhow!("EasyTier public download timed out"))
        }
    };
    job.finish(
        &outcome
            .as_ref()
            .map(|_| ())
            .map_err(|error| anyhow::anyhow!("{error:#}")),
    );
    let files = outcome.unwrap();
    assert!(files.core.is_file() && files.cli.is_file() && installed(temp.path()));
    let snapshot = downloads.snapshots().await.pop().unwrap();
    assert_eq!(snapshot.status, Status::Completed);
    assert_clean(temp.path(), &snapshot);
}
