use axum::{
    body::{Body, Bytes},
    extract::{Path as RoutePath, State},
    http::{HeaderMap, Response, StatusCode},
    routing::get,
    Router,
};
use sfmcl_t_core::downloads::{
    prepare_cache_directory, DownloadManager, DownloadRetention, DownloadSnapshot, DownloadSpec,
    Status,
};
use sfmcl_t_core::jobs::{self, JobKind, Jobs};
use sha1::{Digest, Sha1};
use std::{
    convert::Infallible,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

struct ServerState {
    payload: Vec<u8>,
    active: AtomicUsize,
    max_active: AtomicUsize,
    requests: AtomicUsize,
    ranges: Mutex<Vec<u64>>,
}
struct Active(Arc<ServerState>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}
async fn serve(
    State(state): State<Arc<ServerState>>,
    RoutePath((mode, _name)): RoutePath<(String, String)>,
    headers: HeaderMap,
) -> Response<Body> {
    let request = state.requests.fetch_add(1, Ordering::SeqCst);
    if mode == "retry" && request == 0 {
        return Response::builder().status(503).body(Body::empty()).unwrap();
    }
    if mode == "missing" {
        return Response::builder().status(404).body(Body::empty()).unwrap();
    }
    let offset = headers
        .get("range")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("bytes="))
        .and_then(|s| s.strip_suffix('-'))
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    state.ranges.lock().unwrap().push(offset as u64);
    let offset = if mode == "ignore" { 0 } else { offset };
    let len = state.payload.len();
    if offset >= len {
        return Response::builder().status(416).body(Body::empty()).unwrap();
    }
    let active = state.active.fetch_add(1, Ordering::SeqCst) + 1;
    state.max_active.fetch_max(active, Ordering::SeqCst);
    let guard = Active(state.clone());
    let corrupt = mode == "corrupt";
    let stream =
        futures_util::stream::unfold((offset, guard), move |(position, guard)| async move {
            if position >= guard.0.payload.len() {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(4)).await;
            let end = (position + 2048).min(guard.0.payload.len());
            let mut bytes = guard.0.payload[position..end].to_vec();
            if corrupt {
                bytes[0] ^= 1;
            }
            Some((Ok::<_, Infallible>(Bytes::from(bytes)), (end, guard)))
        });
    let mut response = Response::builder()
        .status(if offset > 0 {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header("Content-Length", len - offset)
        .header("ETag", "\"fixture-v1\"");
    if offset > 0 {
        response = response.header(
            "Content-Range",
            format!(
                "bytes {}-{}/{len}",
                if mode == "wrong" { offset + 1 } else { offset },
                len - 1
            ),
        );
    }
    response.body(Body::from_stream(stream)).unwrap()
}
struct TestServer {
    url: String,
    state: Arc<ServerState>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl TestServer {
    async fn start() -> Self {
        let state = Arc::new(ServerState {
            payload: (0..262144).map(|i| (i % 251) as u8).collect(),
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
            requests: AtomicUsize::new(0),
            ranges: Mutex::new(vec![]),
        });
        let router = Router::new()
            .route("/{mode}/{name}", get(serve))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self { url, state, task }
    }
    fn spec(&self, mode: &str, name: &str) -> DownloadSpec {
        DownloadSpec {
            url: format!("{}/{mode}/{name}", self.url),
            path: name.into(),
            size: Some(self.state.payload.len() as u64),
            sha1: Some(hex::encode(Sha1::digest(&self.state.payload))),
            sha512: None,
        }
    }
}
async fn complete(manager: &DownloadManager, id: &str) {
    tokio::time::timeout(
        Duration::from_secs(15),
        manager.wait(id, &CancellationToken::new()),
    )
    .await
    .unwrap()
    .unwrap();
}
fn cached_part(snapshot: &DownloadSnapshot, name: &str) -> std::path::PathBuf {
    snapshot.cache_dir.as_ref().unwrap().join(format!(
        "tmcl-downloads/{}/{}.part",
        snapshot.id,
        hex::encode(Sha1::digest(name.as_bytes()))
    ))
}
async fn partial(manager: &DownloadManager, id: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if manager.snapshot(id).await.unwrap().downloaded() >= 8192 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cancelling_a_workflow_reports_its_type_and_drains_its_download() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&temp.path().join("state"), 1).unwrap();
    let jobs = Jobs::default();
    for (index, (kind, session, expected)) in [
        (JobKind::Launch, true, "启动已取消"),
        (JobKind::Install, false, "安装已取消"),
        (JobKind::Repair, false, "修复已取消"),
        (JobKind::Login, true, "登录已取消"),
        (JobKind::LoginRefresh, true, "登录刷新已取消"),
        (JobKind::Other, false, "任务已取消"),
    ]
    .into_iter()
    .enumerate()
    {
        // Identical titles ensure cancellation wording comes from the task type.
        let job = jobs.create(kind, "同名任务".into(), &["下载文件"]);
        let transfer = async {
            let title = format!("files-{index}");
            let files = vec![server.spec("normal", &format!("{index}.jar"))];
            if session {
                jobs::download_session(&manager, &job, title, temp.path().into(), files).await
            } else {
                jobs::download(&manager, &job, title, temp.path().into(), files).await
            }
        };
        let cancel = async {
            let id = loop {
                if let Some(id) = job.snapshot().download_id {
                    break id;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            };
            partial(&manager, &id).await;
            job.cancel.cancel();
            id
        };
        let (result, id) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(transfer, cancel)
        })
        .await
        .unwrap();
        job.finish(&result);
        assert_eq!(result.unwrap_err().to_string(), expected);
        let snapshot = job.snapshot();
        assert_eq!(snapshot.status, Status::Cancelled);
        assert_eq!(snapshot.steps[0].status, Status::Cancelled);
        assert_eq!(snapshot.error.as_deref(), Some(expected));
        let download = manager.snapshot(&id).await.unwrap();
        assert_eq!(download.status, Status::Cancelled);
        assert_eq!(download.active_workers, 0);
    }
}

#[tokio::test]
async fn cancelling_metadata_requests_reports_the_owning_workflow() {
    let server = TestServer::start().await;
    let jobs = Jobs::default();
    for (kind, expected) in [
        (JobKind::Launch, "启动已取消"),
        (JobKind::Install, "安装已取消"),
        (JobKind::Repair, "修复已取消"),
    ] {
        let job = jobs.create(kind, "读取元数据".into(), &["读取文件"]);
        job.cancel.cancel();
        let result = sfmcl_t_core::minecraft::installer::get_bytes(
            &reqwest::Client::new(),
            &server.spec("normal", "metadata.json").url,
            Some(&job),
        )
        .await;
        job.finish(&result.map(|_| ()));
        assert_eq!(job.snapshot().error.as_deref(), Some(expected));
    }
}

#[tokio::test]
async fn resource_download_saves_to_selected_folder_without_game_installation() {
    let server = TestServer::start().await;
    let state = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&state.path().join("downloads"), 2).unwrap();
    let (root, spec) = sfmcl_t_core::resources::download::folder_destination(
        destination.path(),
        server.spec("normal", "resource.jar"),
    )
    .unwrap();
    let id = manager
        .enqueue("Resource".into(), root, vec![spec])
        .await
        .unwrap();
    complete(&manager, &id).await;
    assert_eq!(
        std::fs::read(destination.path().join("resource.jar")).unwrap(),
        server.state.payload
    );
    assert_eq!(std::fs::read_dir(destination.path()).unwrap().count(), 1);
    drop(manager);
    let reopened = DownloadManager::open(&state.path().join("downloads"), 2).unwrap();
    let snapshot = reopened.snapshot(&id).await.unwrap();
    assert_eq!(snapshot.status, Status::Completed);
    assert_eq!(snapshot.root, destination.path().canonicalize().unwrap());
}

#[tokio::test]
async fn session_workflows_do_not_restore_but_keep_downloaded_files() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let state = temp.path().join("state");
    let manager = DownloadManager::open(&state, 2).unwrap();
    let jobs = sfmcl_t_core::jobs::Jobs::default();
    let mut session_ids = vec![];
    for (title, file) in [
        ("资源索引", "assets/indexes/test.json"),
        ("1.21.4 · 启动检查", "versions/test/test.jar"),
    ] {
        let job = jobs.create(JobKind::Launch, title.into(), &["检查文件"]);
        let mut spec = server.spec("normal", "payload.bin");
        spec.path = file.into();
        tokio::time::timeout(
            Duration::from_secs(15),
            sfmcl_t_core::jobs::download_session(
                &manager,
                &job,
                title.into(),
                temp.path().into(),
                vec![spec],
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let id = job.snapshot().download_id.unwrap();
        let snapshot = manager.snapshot(&id).await.unwrap();
        assert_eq!(snapshot.retention, DownloadRetention::Session);
        assert_eq!(snapshot.status, Status::Completed);
        session_ids.push(id);
    }
    // Explicit retention, rather than the display title, governs new downloads.
    let persistent = manager
        .enqueue(
            "资源索引".into(),
            temp.path().into(),
            vec![server.spec("normal", "user-resource.jar")],
        )
        .await
        .unwrap();
    complete(&manager, &persistent).await;
    assert_eq!(manager.snapshots().await.len(), 3);
    drop(manager);

    let restored = DownloadManager::open(&state, 2).unwrap();
    assert_eq!(restored.snapshots().await.len(), 1);
    assert_eq!(
        restored.snapshot(&persistent).await.unwrap().status,
        Status::Completed
    );
    for id in session_ids {
        assert!(restored.snapshot(&id).await.is_err());
        assert!(!state.join(format!("{id}.json")).exists());
    }
    for file in [
        "assets/indexes/test.json",
        "versions/test/test.jar",
        "user-resource.jar",
    ] {
        assert_eq!(
            std::fs::read(temp.path().join(file)).unwrap(),
            server.state.payload
        );
    }
}

#[tokio::test]
async fn interrupted_session_records_clean_up_owned_partials_after_restart() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let state = temp.path().join("state");
    let manager = DownloadManager::open(&state, 1).unwrap();
    let target = temp.path().join("checks.jar");
    std::fs::write(&target, b"installed game file").unwrap();
    let id = manager
        .enqueue_with_retention(
            "1.21.4 · 启动检查".into(),
            temp.path().into(),
            vec![server.spec("normal", "checks.jar")],
            DownloadRetention::Session,
        )
        .await
        .unwrap();
    partial(&manager, &id).await;
    manager.pause_all().await.unwrap();
    let part = cached_part(&manager.snapshot(&id).await.unwrap(), "checks.jar");
    let meta = part.with_extension("part.json");
    assert!(part.exists());
    assert!(meta.exists());
    drop(manager);
    let stage = temp.path().join(format!(
        ".tmcl-{id}-{}.installing",
        hex::encode(Sha1::digest(b"checks.jar"))
    ));
    std::fs::write(&stage, b"interrupted staged copy").unwrap();
    let restored = DownloadManager::open(&state, 1).unwrap();
    assert!(restored.snapshots().await.is_empty());
    for path in [part, meta, stage, state.join(format!("{id}.json"))] {
        assert!(!path.exists(), "{} was not cleaned up", path.display());
    }
    assert_eq!(std::fs::read(target).unwrap(), b"installed game file");
}

#[tokio::test]
async fn legacy_check_records_are_discarded_in_every_status() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let state = temp.path().join("state");
    let manager = DownloadManager::open(&state, 1).unwrap();
    let persistent = manager
        .enqueue(
            "ordinary download".into(),
            temp.path().into(),
            vec![server.spec("normal", "game.jar")],
        )
        .await
        .unwrap();
    complete(&manager, &persistent).await;
    let mut legacy = serde_json::to_value(manager.snapshot(&persistent).await.unwrap()).unwrap();
    legacy.as_object_mut().unwrap().remove("retention");
    drop(manager);
    std::fs::write(
        state.join(format!("{persistent}.json")),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    let mut discarded = vec![];
    for title in ["资源索引", "1.21.4 · 启动检查"] {
        for status in [
            "queued",
            "running",
            "pausing",
            "paused",
            "completed",
            "failed",
            "cancelled",
        ] {
            let id = uuid::Uuid::new_v4().to_string();
            let mut record = legacy.clone();
            record["id"] = id.clone().into();
            record["title"] = title.into();
            record["status"] = status.into();
            let path = state.join(format!("{id}.json"));
            std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
            discarded.push(path);
        }
    }
    let restored = DownloadManager::open(&state, 1).unwrap();
    assert_eq!(restored.snapshots().await.len(), 1);
    assert_eq!(
        restored.snapshot(&persistent).await.unwrap().status,
        Status::Completed
    );
    assert!(discarded.iter().all(|path| !path.exists()));
    assert_eq!(
        std::fs::read(temp.path().join("game.jar")).unwrap(),
        server.state.payload
    );
}

#[tokio::test]
async fn bounded_parallel_files_and_hashes() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&temp.path().join("state"), 2).unwrap();
    let specs = (0..5)
        .map(|i| server.spec("normal", &format!("file-{i}.jar")))
        .collect();
    let id = manager
        .enqueue("parallel".into(), temp.path().into(), specs)
        .await
        .unwrap();
    complete(&manager, &id).await;
    assert_eq!(manager.snapshot(&id).await.unwrap().completed(), 5);
    assert_eq!(server.state.max_active.load(Ordering::SeqCst), 2);
    for i in 0..5 {
        assert_eq!(
            std::fs::read(temp.path().join(format!("file-{i}.jar"))).unwrap(),
            server.state.payload
        );
    }
}
#[tokio::test]
async fn pause_drains_and_resume_uses_range_without_corruption() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&temp.path().join("state"), 3).unwrap();
    let id = manager
        .enqueue(
            "pause".into(),
            temp.path().into(),
            (0..3)
                .map(|i| server.spec("normal", &format!("{i}.jar")))
                .collect(),
        )
        .await
        .unwrap();
    partial(&manager, &id).await;
    manager.pause(&id).await.unwrap();
    let paused = manager.snapshot(&id).await.unwrap();
    assert_eq!(paused.status, Status::Paused);
    assert_eq!(paused.active_workers, 0);
    let paths: Vec<_> = (0..3)
        .map(|i| cached_part(&paused, &format!("{i}.jar")))
        .collect();
    let before: Vec<_> = paths
        .iter()
        .map(|p| std::fs::metadata(p).unwrap().len())
        .collect();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let after: Vec<_> = paths
        .iter()
        .map(|p| std::fs::metadata(p).unwrap().len())
        .collect();
    assert_eq!(
        before, after,
        "pause returned while a file was still writing"
    );
    manager.resume(&id).await.unwrap();
    complete(&manager, &id).await;
    assert!(server
        .state
        .ranges
        .lock()
        .unwrap()
        .iter()
        .any(|offset| *offset > 0));
    assert_eq!(
        std::fs::read(temp.path().join("0.jar")).unwrap(),
        server.state.payload
    );
}
#[tokio::test]
async fn server_ignoring_range_restarts_safely() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&temp.path().join("state"), 1).unwrap();
    let id = manager
        .enqueue(
            "ignore range".into(),
            temp.path().into(),
            vec![server.spec("ignore", "a.jar")],
        )
        .await
        .unwrap();
    partial(&manager, &id).await;
    manager.pause(&id).await.unwrap();
    manager.resume(&id).await.unwrap();
    complete(&manager, &id).await;
    assert_eq!(
        std::fs::read(temp.path().join("a.jar")).unwrap(),
        server.state.payload
    );
}
#[tokio::test]
async fn resumes_persisted_task_after_restart() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let state = temp.path().join("state");
    let manager = DownloadManager::open(&state, 1).unwrap();
    let id = manager
        .enqueue(
            "restart".into(),
            temp.path().into(),
            vec![server.spec("normal", "a.jar")],
        )
        .await
        .unwrap();
    partial(&manager, &id).await;
    manager.pause_all().await.unwrap();
    drop(manager);
    let manager = DownloadManager::open(&state, 1).unwrap();
    assert_eq!(manager.snapshot(&id).await.unwrap().status, Status::Paused);
    manager.resume(&id).await.unwrap();
    complete(&manager, &id).await;
    assert!(server
        .state
        .ranges
        .lock()
        .unwrap()
        .iter()
        .any(|offset| *offset > 0));
}
#[tokio::test]
async fn transient_failure_retries_and_corruption_never_commits() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&temp.path().join("state"), 1).unwrap();
    let id = manager
        .enqueue(
            "retry".into(),
            temp.path().into(),
            vec![server.spec("retry", "a.jar")],
        )
        .await
        .unwrap();
    complete(&manager, &id).await;
    assert_eq!(manager.snapshot(&id).await.unwrap().files[0].attempts, 2);
    let id = manager
        .enqueue(
            "bad hash".into(),
            temp.path().into(),
            vec![server.spec("corrupt", "bad.jar")],
        )
        .await
        .unwrap();
    assert!(tokio::time::timeout(
        Duration::from_secs(15),
        manager.wait(&id, &CancellationToken::new())
    )
    .await
    .unwrap()
    .is_err());
    assert!(!temp.path().join("bad.jar").exists());
    assert!(manager.snapshot(&id).await.unwrap().files[0]
        .error
        .as_ref()
        .unwrap()
        .contains("SHA-1"));
}
#[tokio::test]
async fn cancellation_and_clear_leave_finished_files_intact() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&temp.path().join("state"), 1).unwrap();
    let id = manager
        .enqueue(
            "cancel".into(),
            temp.path().into(),
            vec![server.spec("normal", "a.jar")],
        )
        .await
        .unwrap();
    partial(&manager, &id).await;
    assert!(manager.clear(&id).await.is_err());
    manager.cancel(&id).await.unwrap();
    manager.clear(&id).await.unwrap();
    assert!(!temp.path().join("a.jar").exists());
    assert!(manager.snapshots().await.is_empty());
    let id = manager
        .enqueue(
            "finish".into(),
            temp.path().into(),
            vec![server.spec("normal", "a.jar")],
        )
        .await
        .unwrap();
    complete(&manager, &id).await;
    manager.clear(&id).await.unwrap();
    assert_eq!(
        std::fs::read(temp.path().join("a.jar")).unwrap(),
        server.state.payload
    );
}
#[tokio::test]
async fn rejects_duplicate_target_and_escape_before_network_io() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&temp.path().join("state"), 1).unwrap();
    let spec = server.spec("normal", "a.jar");
    assert!(manager
        .enqueue(
            "duplicates".into(),
            temp.path().into(),
            vec![spec.clone(), spec.clone()]
        )
        .await
        .is_err());
    assert!(manager
        .enqueue(
            "escape".into(),
            temp.path().into(),
            vec![server.spec("normal", "../outside")]
        )
        .await
        .is_err());
    let id = manager
        .enqueue("first".into(), temp.path().into(), vec![spec.clone()])
        .await
        .unwrap();
    assert!(manager
        .enqueue("second".into(), temp.path().into(), vec![spec])
        .await
        .is_err());
    manager.cancel(&id).await.unwrap();
}
#[tokio::test]
async fn concurrent_pause_resume_calls_do_not_spawn_duplicate_writers() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&temp.path().join("state"), 1).unwrap();
    let id = manager
        .enqueue(
            "race".into(),
            temp.path().into(),
            vec![server.spec("normal", "a.jar")],
        )
        .await
        .unwrap();
    partial(&manager, &id).await;
    let (a, b) = tokio::join!(manager.pause(&id), manager.pause(&id));
    a.unwrap();
    b.unwrap();
    let (a, b) = tokio::join!(manager.resume(&id), manager.resume(&id));
    a.unwrap();
    b.unwrap();
    complete(&manager, &id).await;
    assert_eq!(
        std::fs::read(temp.path().join("a.jar")).unwrap(),
        server.state.payload
    );
}

#[tokio::test]
async fn invalid_content_range_cannot_append_or_commit() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&temp.path().join("state"), 1).unwrap();
    let id = manager
        .enqueue(
            "invalid range".into(),
            temp.path().into(),
            vec![server.spec("wrong", "a.jar")],
        )
        .await
        .unwrap();
    partial(&manager, &id).await;
    manager.pause(&id).await.unwrap();
    let path = cached_part(&manager.snapshot(&id).await.unwrap(), "a.jar");
    let before = std::fs::read(&path).unwrap();
    manager.resume(&id).await.unwrap();
    assert!(manager.wait(&id, &CancellationToken::new()).await.is_err());
    assert!(!temp.path().join("a.jar").exists());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn retry_failed_does_not_redownload_successful_files() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&temp.path().join("state"), 2).unwrap();
    let id = manager
        .enqueue(
            "partial failure".into(),
            temp.path().into(),
            vec![
                server.spec("normal", "ok.jar"),
                server.spec("missing", "missing.jar"),
            ],
        )
        .await
        .unwrap();
    assert!(manager.wait(&id, &CancellationToken::new()).await.is_err());
    let previous = manager.snapshot(&id).await.unwrap();
    manager.resume(&id).await.unwrap();
    assert!(manager.wait(&id, &CancellationToken::new()).await.is_err());
    let after = manager.snapshot(&id).await.unwrap();
    assert_eq!(after.files[0].attempts, previous.files[0].attempts);
    assert_eq!(after.files[0].status, Status::Completed);
    assert!(after.files[1].attempts > previous.files[1].attempts);
}

#[tokio::test]
async fn custom_cache_survives_directory_change_restart_and_cross_directory_commit() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    // On Windows CI/dev machines the system temp and checkout can be different drives.
    let target = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
    let state = temp.path().join("records");
    let first_cache = temp.path().join("下载缓存 A");
    let next_cache = temp.path().join("下载缓存 B");
    let manager = DownloadManager::open(&state, 1).unwrap();
    manager.set_cache_directory(&first_cache).unwrap();
    std::fs::write(target.path().join("a.jar"), b"old target").unwrap();
    let id = manager
        .enqueue(
            "cached".into(),
            target.path().into(),
            vec![server.spec("normal", "a.jar")],
        )
        .await
        .unwrap();
    partial(&manager, &id).await;
    manager.pause(&id).await.unwrap();
    let before = manager.snapshot(&id).await.unwrap();
    let part = cached_part(&before, "a.jar");
    assert!(part.is_file());
    assert_eq!(
        std::fs::read(target.path().join("a.jar")).unwrap(),
        b"old target"
    );
    manager.set_cache_directory(&next_cache).unwrap();
    assert_eq!(
        manager.snapshot(&id).await.unwrap().cache_dir,
        Some(first_cache.clone())
    );
    let next = manager
        .enqueue(
            "next cache".into(),
            target.path().into(),
            vec![server.spec("normal", "b.jar")],
        )
        .await
        .unwrap();
    partial(&manager, &next).await;
    manager.pause(&next).await.unwrap();
    assert_eq!(
        manager.snapshot(&next).await.unwrap().cache_dir,
        Some(next_cache.clone())
    );
    drop(manager);
    let manager = DownloadManager::open(&state, 1).unwrap();
    manager.set_cache_directory(&next_cache).unwrap();
    assert_eq!(
        manager.snapshot(&id).await.unwrap().cache_dir,
        Some(first_cache)
    );
    manager.resume(&id).await.unwrap();
    complete(&manager, &id).await;
    assert_eq!(
        std::fs::read(target.path().join("a.jar")).unwrap(),
        server.state.payload
    );
    assert!(!part.exists());
    assert!(!part.with_extension("part.json").exists());
    assert!(server.state.ranges.lock().unwrap().iter().any(|n| *n > 0));
    manager.resume(&next).await.unwrap();
    complete(&manager, &next).await;
    assert_eq!(
        std::fs::read(target.path().join("b.jar")).unwrap(),
        server.state.payload
    );
    assert!(std::fs::read_dir(target.path()).unwrap().all(|e| !e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".installing")));
}

#[tokio::test]
async fn legacy_records_resume_partials_beside_target() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let state = temp.path().join("records");
    let manager = DownloadManager::open(&state, 1).unwrap();
    let id = manager
        .enqueue(
            "legacy".into(),
            temp.path().into(),
            vec![server.spec("normal", "legacy.jar")],
        )
        .await
        .unwrap();
    partial(&manager, &id).await;
    manager.pause(&id).await.unwrap();
    let part = cached_part(&manager.snapshot(&id).await.unwrap(), "legacy.jar");
    let legacy = temp.path().join(format!("legacy.jar.tmcl-{id}.part"));
    std::fs::rename(&part, &legacy).unwrap();
    std::fs::rename(
        part.with_extension("part.json"),
        legacy.with_extension("part.json"),
    )
    .unwrap();
    drop(manager);
    let record_path = state.join(format!("{id}.json"));
    let mut record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&record_path).unwrap()).unwrap();
    record.as_object_mut().unwrap().remove("cacheDir");
    std::fs::write(record_path, serde_json::to_vec(&record).unwrap()).unwrap();
    let manager = DownloadManager::open(&state, 1).unwrap();
    assert!(manager.snapshot(&id).await.unwrap().cache_dir.is_none());
    manager.resume(&id).await.unwrap();
    complete(&manager, &id).await;
    assert!(!legacy.exists());
    assert_eq!(
        std::fs::read(temp.path().join("legacy.jar")).unwrap(),
        server.state.payload
    );
    assert!(server.state.ranges.lock().unwrap().iter().any(|n| *n > 0));
}

#[tokio::test]
async fn clear_only_removes_owned_cache_files_and_unavailable_cache_rejects_new_tasks() {
    let server = TestServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let cache = temp.path().join("custom");
    prepare_cache_directory(&cache).unwrap();
    assert_eq!(
        std::fs::read_dir(cache.join("tmcl-downloads"))
            .unwrap()
            .count(),
        0
    );
    std::fs::write(cache.join("user-file.txt"), b"keep").unwrap();
    let manager = DownloadManager::open(&temp.path().join("records"), 1).unwrap();
    manager.set_cache_directory(&cache).unwrap();
    let id = manager
        .enqueue(
            "clear".into(),
            temp.path().into(),
            vec![server.spec("normal", "a.jar")],
        )
        .await
        .unwrap();
    partial(&manager, &id).await;
    manager.cancel(&id).await.unwrap();
    let part = cached_part(&manager.snapshot(&id).await.unwrap(), "a.jar");
    let sibling = part.parent().unwrap().join("user-file.txt");
    std::fs::write(&sibling, b"also keep").unwrap();
    manager.clear(&id).await.unwrap();
    assert!(!part.exists());
    assert!(!part.with_extension("part.json").exists());
    assert_eq!(std::fs::read(sibling).unwrap(), b"also keep");
    assert_eq!(std::fs::read(cache.join("user-file.txt")).unwrap(), b"keep");
    let unavailable = temp.path().join("not-a-directory");
    std::fs::write(&unavailable, b"keep this too").unwrap();
    assert!(prepare_cache_directory(&unavailable).is_err());
    assert!(prepare_cache_directory(std::path::Path::new("relative")).is_err());
    manager.set_cache_directory(&unavailable).unwrap();
    assert!(manager
        .enqueue(
            "unavailable".into(),
            temp.path().into(),
            vec![server.spec("normal", "b.jar")]
        )
        .await
        .is_err());
    assert!(manager.snapshots().await.is_empty());
    assert_eq!(std::fs::read(unavailable).unwrap(), b"keep this too");
}
