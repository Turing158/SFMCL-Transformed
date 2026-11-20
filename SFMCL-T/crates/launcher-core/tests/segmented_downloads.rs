use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderMap, Response},
    routing::get,
    Router,
};
use sfmcl_t_core::{
    downloads::{DownloadManager, DownloadSpec, Status},
    minecraft::download_source::MinecraftDownloadSource,
};
use sha1::{Digest, Sha1};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const MIB: usize = 1024 * 1024;
#[derive(Clone, Debug)]
struct Request {
    mode: String,
    range: Option<(usize, usize)>,
    if_range: Option<String>,
}
struct Fixture {
    size: usize,
    delay: Duration,
    requests: Mutex<Vec<Request>>,
    active: AtomicUsize,
    peak: AtomicUsize,
    interrupted: AtomicUsize,
}
struct Active(Arc<Fixture>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}
fn payload(start: usize, end: usize) -> Vec<u8> {
    (start..end).map(|index| (index % 251) as u8).collect()
}
async fn serve(
    State(state): State<Arc<Fixture>>,
    Path((mode, _name)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response<Body> {
    assert_eq!(headers.get("accept-encoding").unwrap(), "identity");
    if state.size == 0 {
        return Response::builder()
            .status(if headers.contains_key("range") {
                416
            } else {
                200
            })
            .header("Content-Length", 0)
            .body(Body::empty())
            .unwrap();
    }
    let range = headers
        .get("range")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes="))
        .and_then(|value| value.split_once('-'))
        .and_then(|(start, end)| {
            Some((
                start.parse::<usize>().ok()?,
                if end.is_empty() {
                    state.size - 1
                } else {
                    end.parse::<usize>().ok()?
                },
            ))
        });
    let request = Request {
        mode: mode.clone(),
        range,
        if_range: headers
            .get("if-range")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
    };
    state.requests.lock().unwrap().push(request);
    if mode == "redirect" {
        return Response::builder()
            .status(302)
            .header("Location", "/valid/redirected")
            .body(Body::empty())
            .unwrap();
    }
    let probe = range == Some((0, 0));
    let segment = range.is_some() && !probe;
    if segment && mode == "416" {
        return Response::builder().status(416).body(Body::empty()).unwrap();
    }
    let range = if mode == "ignore" || (segment && mode == "segment200") {
        None
    } else {
        range
    };
    let (start, end) = range.unwrap_or((0, state.size - 1));
    if start >= state.size || end >= state.size {
        return Response::builder().status(416).body(Body::empty()).unwrap();
    }
    let mut response = Response::builder()
        .status(if range.is_some() { 206 } else { 200 })
        .header(
            "Content-Length",
            if segment && mode == "bad-length" {
                end - start
            } else {
                end - start + 1
            },
        );
    if !matches!(
        mode.as_str(),
        "no-validator" | "weak" | "modified" | "modified-changed"
    ) {
        response = response.header(
            "ETag",
            if mode == "invalid-etag" {
                "\"bad\"tag\""
            } else if mode == "changed" && segment {
                "\"v2\""
            } else {
                "\"v1\""
            },
        );
    }
    if mode == "weak" {
        response = response.header("ETag", "W/\"v1\"");
    }
    if mode == "modified" || mode == "modified-changed" {
        response = response.header(
            "Last-Modified",
            if mode == "modified-changed" && segment {
                "Thu, 19 Nov 2026 00:00:00 GMT"
            } else {
                "Wed, 18 Nov 2026 00:00:00 GMT"
            },
        );
    }
    if mode == "compressed" {
        response = response.header("Content-Encoding", "gzip");
    }
    if range.is_some() {
        response = response.header(
            "Content-Range",
            format!(
                "bytes {}-{}/{}",
                if (mode == "bad-range" && segment) || (mode == "bad-probe" && probe) {
                    start + 1
                } else {
                    start
                },
                end,
                state.size
            ),
        );
    }
    let active = state.active.fetch_add(1, Ordering::SeqCst) + 1;
    state.peak.fetch_max(active, Ordering::SeqCst);
    let guard = Active(state.clone());
    let interrupt = mode == "interrupt"
        && segment
        && start == 0
        && state.interrupted.fetch_add(1, Ordering::SeqCst) == 0;
    let corrupt = mode == "corrupt";
    let body = futures_util::stream::unfold((start, guard), move |(position, guard)| async move {
        if position > end {
            return None;
        }
        tokio::time::sleep(guard.0.delay).await;
        if interrupt && position >= 32768 {
            return Some((
                Err(std::io::Error::other("fixture interruption")),
                (end + 1, guard),
            ));
        }
        let next = (position + 32768).min(end + 1);
        let mut data = payload(position, next);
        if corrupt && !data.is_empty() {
            data[0] ^= 1;
        }
        Some((Ok(Bytes::from(data)), (next, guard)))
    });
    response.body(Body::from_stream(body)).unwrap()
}
struct Server {
    url: String,
    state: Arc<Fixture>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn start(size: usize, delay_ms: u64) -> Self {
        let state = Arc::new(Fixture {
            size,
            delay: Duration::from_millis(delay_ms),
            requests: Mutex::new(Vec::new()),
            active: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            interrupted: AtomicUsize::new(0),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/{mode}/{name}", get(serve))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self { url, state, task }
    }
    fn spec(&self, mode: &str, name: &str) -> DownloadSpec {
        let mut hash = Sha1::new();
        for start in (0..self.state.size).step_by(MIB) {
            hash.update(payload(start, (start + MIB).min(self.state.size)));
        }
        DownloadSpec {
            url: format!("{}/{mode}/{name}", self.url),
            path: name.into(),
            size: Some(self.state.size as u64),
            sha1: Some(hex::encode(hash.finalize())),
            sha512: None,
        }
    }
}
async fn finish(manager: &DownloadManager, id: &str) {
    let result = tokio::time::timeout(
        Duration::from_secs(60),
        manager.wait(id, &CancellationToken::new()),
    )
    .await
    .unwrap();
    assert!(
        result.is_ok(),
        "{result:?}: {:?}",
        manager.snapshot(id).await.unwrap()
    );
}
fn manager(temp: &tempfile::TempDir, budget: usize) -> Arc<DownloadManager> {
    let manager = DownloadManager::open(&temp.path().join("state"), 8).unwrap();
    manager
        .sources()
        .set_mode(MinecraftDownloadSource::Official);
    manager.set_connection_limit(budget);
    manager
}
fn part(snapshot: &sfmcl_t_core::downloads::DownloadSnapshot, name: &str) -> std::path::PathBuf {
    snapshot.cache_dir.as_ref().unwrap().join(format!(
        "tmcl-downloads/{}/{}.part",
        snapshot.id,
        hex::encode(Sha1::digest(name.as_bytes()))
    ))
}

#[tokio::test]
async fn fixed_ranges_under_every_connection_budget() {
    for (size, count, budget) in [
        (MIB, 4, 1),
        (2 * MIB, 4, 2),
        (4 * MIB, 4, 4),
        (8 * MIB, 4, 8),
        (8 * MIB + 1, 8, 10),
        (64 * MIB, 8, 16),
        (64 * MIB + 1, 10, 16),
    ] {
        let server = Server::start(size, 1).await;
        let temp = tempfile::tempdir().unwrap();
        let manager = manager(&temp, budget);
        let id = manager
            .enqueue(
                "ranges".into(),
                temp.path().join("game"),
                vec![server.spec("valid", "file.bin")],
            )
            .await
            .unwrap();
        finish(&manager, &id).await;
        let snapshot = manager.snapshot(&id).await.unwrap();
        assert_eq!(snapshot.downloaded(), size as u64);
        assert_eq!(
            std::fs::read(temp.path().join("game/file.bin")).unwrap(),
            payload(0, size)
        );
        let requests = server.state.requests.lock().unwrap();
        let mut ranges = requests
            .iter()
            .filter_map(|request| request.range)
            .filter(|range| *range != (0, 0))
            .collect::<Vec<_>>();
        assert_eq!(ranges.len(), count);
        ranges.sort_unstable();
        assert_eq!(ranges[0].0, 0);
        assert_eq!(ranges.last().unwrap().1, size - 1);
        assert!(ranges.windows(2).all(|pair| pair[0].1 + 1 == pair[1].0));
        assert!(requests
            .iter()
            .filter(|request| request.range != Some((0, 0)))
            .all(|request| request.if_range.as_deref() == Some("\"v1\"")));
        assert!(server.state.peak.load(Ordering::SeqCst) <= budget);
        if budget >= count {
            assert!(server.state.peak.load(Ordering::SeqCst) >= count);
        }
        assert!(!part(&snapshot, "file.bin").parent().unwrap().exists());
    }
}

#[tokio::test]
async fn http_fallback_versions_hashes_unknown_size_and_redirects() {
    let server = Server::start(MIB, 1).await;
    for mode in [
        "ignore",
        "segment200",
        "416",
        "bad-range",
        "bad-length",
        "bad-probe",
        "changed",
        "no-validator",
        "weak",
        "modified",
        "modified-changed",
        "redirect",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let manager = manager(&temp, 4);
        let spec = server.spec(mode, "file.bin");
        let id = manager
            .enqueue(mode.into(), temp.path().join("game"), vec![spec])
            .await
            .unwrap();
        finish(&manager, &id).await;
        assert_eq!(
            std::fs::read(temp.path().join("game/file.bin")).unwrap(),
            payload(0, MIB)
        );
    }
    // A missing or weak validator needs a trusted hash; otherwise only the
    // one-byte capability probe and one ordinary request are allowed.
    for mode in ["no-validator", "weak", "invalid-etag"] {
        let before = server.state.requests.lock().unwrap().len();
        let temp = tempfile::tempdir().unwrap();
        let manager = manager(&temp, 4);
        let mut spec = server.spec(mode, "no-hash.bin");
        spec.sha1 = None;
        let id = manager
            .enqueue(mode.into(), temp.path().join("game"), vec![spec])
            .await
            .unwrap();
        finish(&manager, &id).await;
        let requests = server.state.requests.lock().unwrap();
        assert_eq!(requests.len() - before, 2);
        assert!(requests[before + 1].range.is_none());
    }
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp, 4);
    let mut spec = server.spec("valid", "unknown.bin");
    spec.size = None;
    let id = manager
        .enqueue("unknown".into(), temp.path().join("game"), vec![spec])
        .await
        .unwrap();
    finish(&manager, &id).await;
    assert_eq!(
        manager.snapshot(&id).await.unwrap().files[0].total,
        Some(MIB as u64)
    );
    let ignores = server
        .state
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.mode == "ignore")
        .count();
    assert_eq!(ignores, 1, "the ignored probe response must be reused");
}

#[tokio::test]
async fn local_retry_only_requests_the_failed_segment_prefix() {
    let server = Server::start(MIB, 3).await;
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp, 4);
    let id = manager
        .enqueue(
            "retry".into(),
            temp.path().join("game"),
            vec![server.spec("interrupt", "file.bin")],
        )
        .await
        .unwrap();
    finish(&manager, &id).await;
    {
        let requests = server.state.requests.lock().unwrap();
        assert_eq!(requests.len(), 6); // probe + 4 segments + 1 local retry
        assert!(requests
            .iter()
            .any(|request| request.range == Some((32768, MIB / 4 - 1))));
    }
    assert_eq!(manager.snapshot(&id).await.unwrap().files[0].attempts, 1);
}

#[tokio::test]
async fn pause_restart_resume_preserves_ranges_and_durable_offsets() {
    let server = Server::start(4 * MIB, 8).await;
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp, 2);
    let spec = server.spec("valid", "file.bin");
    let id = manager
        .enqueue("pause".into(), temp.path().join("game"), vec![spec.clone()])
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if manager.snapshot(&id).await.unwrap().downloaded() >= 131072 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(3)).await;
        }
    })
    .await
    .unwrap();
    manager.pause(&id).await.unwrap();
    let paused = manager.snapshot(&id).await.unwrap();
    assert_eq!(paused.status, Status::Paused);
    assert_eq!(paused.active_workers, 0);
    let part = part(&paused, "file.bin");
    let meta_path = part.with_extension("part.segments.json");
    let metadata: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&meta_path).unwrap()).unwrap();
    for (index, segment) in metadata["segments"].as_array().unwrap().iter().enumerate() {
        let recorded = segment["downloaded"].as_u64().unwrap();
        let actual = std::fs::metadata(part.with_extension(format!("part.segment-{index}")))
            .map(|file| file.len())
            .unwrap_or(0);
        assert_eq!(actual, recorded);
    }
    let before = std::fs::read(&meta_path).unwrap();
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(std::fs::read(&meta_path).unwrap(), before);
    drop(manager);
    let restored = DownloadManager::open(&temp.path().join("state"), 8).unwrap();
    restored.set_connection_limit(1);
    restored.resume(&id).await.unwrap();
    restored.resume(&id).await.unwrap();
    finish(&restored, &id).await;
    assert_eq!(
        std::fs::read(temp.path().join("game/file.bin")).unwrap(),
        payload(0, 4 * MIB)
    );
    assert!(!meta_path.exists());
    let requests = server.state.requests.lock().unwrap();
    assert!(requests.iter().any(|request| request
        .range
        .is_some_and(|(start, end)| start > 0 && end == MIB - 1)));
}

#[tokio::test]
async fn corrupt_metadata_cancel_cleanup_and_target_protection() {
    let server = Server::start(MIB, 4).await;
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp, 2);
    let id = manager
        .enqueue(
            "cleanup".into(),
            temp.path().join("game"),
            vec![server.spec("valid", "file.bin")],
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(35)).await;
    manager.pause(&id).await.unwrap();
    let path = part(&manager.snapshot(&id).await.unwrap(), "file.bin");
    std::fs::write(path.with_extension("part.segments.json"), b"corrupt record").unwrap();
    std::fs::write(path.with_extension("part.segment-0"), vec![0; MIB]).unwrap();
    manager.resume(&id).await.unwrap();
    finish(&manager, &id).await;
    assert_eq!(
        std::fs::read(temp.path().join("game/file.bin")).unwrap(),
        payload(0, MIB)
    );
    manager.clear(&id).await.unwrap();
    std::fs::write(temp.path().join("game/file.bin"), b"original target").unwrap();
    let id = manager
        .enqueue(
            "bad hash".into(),
            temp.path().join("game"),
            vec![server.spec("corrupt", "file.bin")],
        )
        .await
        .unwrap();
    assert!(manager.wait(&id, &CancellationToken::new()).await.is_err());
    assert_eq!(
        std::fs::read(temp.path().join("game/file.bin")).unwrap(),
        b"original target"
    );
    manager.clear(&id).await.unwrap();
    let id = manager
        .enqueue(
            "cancel".into(),
            temp.path().join("game"),
            vec![server.spec("valid", "file.bin")],
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(35)).await;
    manager.cancel(&id).await.unwrap();
    let snapshot = manager.snapshot(&id).await.unwrap();
    manager.clear(&id).await.unwrap();
    assert!(!part(&snapshot, "file.bin").parent().unwrap().exists());
    assert_eq!(
        std::fs::read(temp.path().join("game/file.bin")).unwrap(),
        b"original target"
    );
}

#[tokio::test]
async fn batches_probes_and_dynamic_budget_share_the_same_connections() {
    let server = Server::start(MIB, 10).await;
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp, 2);
    manager.sources().set_mode(MinecraftDownloadSource::Auto);
    let first = server.spec("valid", "large.bin");
    let alternative = format!("{}/valid/mirror.bin", server.url);
    manager
        .sources()
        .register(&first.url, vec![first.url.clone(), alternative]);
    let id = manager
        .enqueue("batch1".into(), temp.path().join("game"), vec![first])
        .await
        .unwrap();
    let other = manager
        .enqueue(
            "batch2".into(),
            temp.path().join("game"),
            vec![
                server.spec("valid", "other.bin"),
                server.spec("valid", "last.bin"),
            ],
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(60)).await;
    manager.set_connection_limit(1);
    finish(&manager, &id).await;
    finish(&manager, &other).await;
    assert!(server.state.peak.load(Ordering::SeqCst) <= 2);
    assert_eq!(
        std::fs::read(temp.path().join("game/other.bin")).unwrap(),
        payload(0, MIB)
    );
}

#[tokio::test]
async fn size_encoding_and_sha512_are_checked_before_commit() {
    let server = Server::start(MIB, 1).await;
    for mode in ["compressed", "valid"] {
        let temp = tempfile::tempdir().unwrap();
        let manager = manager(&temp, 4);
        std::fs::create_dir_all(temp.path().join("game")).unwrap();
        std::fs::write(temp.path().join("game/file.bin"), b"original").unwrap();
        let mut spec = server.spec(mode, "file.bin");
        if mode == "valid" {
            spec.size = Some(MIB as u64 + 1);
        }
        let id = manager
            .enqueue(mode.into(), temp.path().join("game"), vec![spec])
            .await
            .unwrap();
        assert!(manager.wait(&id, &CancellationToken::new()).await.is_err());
        assert_eq!(
            std::fs::read(temp.path().join("game/file.bin")).unwrap(),
            b"original"
        );
        manager.clear(&id).await.unwrap();
    }
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp, 4);
    let mut spec = server.spec("no-validator", "sha512.bin");
    spec.sha1 = None;
    spec.sha512 = Some(hex::encode(sha2::Sha512::digest(payload(0, MIB))));
    let id = manager
        .enqueue("sha512".into(), temp.path().join("game"), vec![spec])
        .await
        .unwrap();
    finish(&manager, &id).await;
    assert_eq!(
        std::fs::read(temp.path().join("game/sha512.bin")).unwrap(),
        payload(0, MIB)
    );
}

#[tokio::test]
async fn changed_source_discards_old_prefixes_and_merge() {
    let server = Server::start(MIB, 8).await;
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp, 1);
    let id = manager
        .enqueue(
            "source change".into(),
            temp.path().join("game"),
            vec![server.spec("valid", "file.bin")],
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    manager.pause(&id).await.unwrap();
    let mut snapshot = manager.snapshot(&id).await.unwrap();
    let part = part(&snapshot, "file.bin");
    std::fs::write(&part, b"incomplete merge").unwrap();
    snapshot.files[0].spec.url = format!("{}/valid/new-source", server.url);
    std::fs::write(
        temp.path().join(format!("state/{id}.json")),
        serde_json::to_vec(&snapshot).unwrap(),
    )
    .unwrap();
    drop(manager);
    let restored = DownloadManager::open(&temp.path().join("state"), 8).unwrap();
    restored.set_connection_limit(4);
    let before = server.state.requests.lock().unwrap().len();
    restored.resume(&id).await.unwrap();
    finish(&restored, &id).await;
    let requests = server.state.requests.lock().unwrap();
    let ranges: Vec<_> = requests[before..]
        .iter()
        .filter_map(|request| request.range)
        .collect();
    assert_eq!(ranges.len(), 5);
    assert!(ranges.contains(&(0, MIB / 4 - 1)));
    assert_eq!(
        std::fs::read(temp.path().join("game/file.bin")).unwrap(),
        payload(0, MIB)
    );
}

#[tokio::test]
async fn later_small_file_finishes_before_large_file_with_one_connection() {
    let large = Server::start(4 * MIB, 20).await;
    let small = Server::start(128 * 1024, 1).await;
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp, 1);
    let first = manager
        .enqueue(
            "large".into(),
            temp.path().join("game"),
            vec![large.spec("valid", "large.bin")],
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while manager.snapshot(&first).await.unwrap().downloaded() < 65536 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let later = manager
        .enqueue(
            "small".into(),
            temp.path().join("game"),
            vec![small.spec("valid", "small.bin")],
        )
        .await
        .unwrap();
    finish(&manager, &later).await;
    assert_eq!(
        manager.snapshot(&first).await.unwrap().status,
        Status::Running
    );
    assert_eq!(
        std::fs::read(temp.path().join("game/small.bin")).unwrap(),
        payload(0, 128 * 1024)
    );
    finish(&manager, &first).await;
}

#[tokio::test]
async fn empty_files_complete_with_known_and_unknown_size() {
    let server = Server::start(0, 1).await;
    for known in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let manager = manager(&temp, 1);
        let mut spec = server.spec("valid", "empty.bin");
        if !known {
            spec.size = None;
        }
        let id = manager
            .enqueue("empty".into(), temp.path().join("game"), vec![spec])
            .await
            .unwrap();
        finish(&manager, &id).await;
        assert_eq!(manager.snapshot(&id).await.unwrap().files[0].total, Some(0));
        assert_eq!(
            std::fs::metadata(temp.path().join("game/empty.bin"))
                .unwrap()
                .len(),
            0
        );
    }
}
