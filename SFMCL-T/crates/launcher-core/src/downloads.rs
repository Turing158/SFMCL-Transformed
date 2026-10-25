use crate::paths::{atomic_write, safe_join};
use anyhow::{anyhow, bail, Context, Result};
use futures_util::{stream, StreamExt};
use reqwest::{header, Client, StatusCode};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use sha2::Sha512;
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Mutex as AsyncMutex, Semaphore},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSpec {
    pub url: String,
    /// Path relative to the selected game root, never an arbitrary absolute path.
    pub path: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub sha512: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Queued,
    Running,
    Pausing,
    Paused,
    Completed,
    Failed,
    Cancelled,
}
impl Status {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSnapshot {
    pub spec: DownloadSpec,
    pub status: Status,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub attempts: u32,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub name: String,
    pub status: Status,
    pub detail: String,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadRetention {
    #[default]
    Persistent,
    Session,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSnapshot {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub retention: DownloadRetention,
    pub root: PathBuf,
    /// Captured at enqueue time. Old records keep their adjacent partial files.
    #[serde(default)]
    pub cache_dir: Option<PathBuf>,
    pub status: Status,
    pub files: Vec<FileSnapshot>,
    pub steps: Vec<Step>,
    pub bytes_per_second: u64,
    pub active_workers: usize,
    pub error: Option<String>,
    pub created_at: u64,
}
impl DownloadSnapshot {
    pub fn downloaded(&self) -> u64 {
        self.files.iter().map(|f| f.downloaded).sum()
    }
    pub fn completed(&self) -> usize {
        self.files
            .iter()
            .filter(|f| f.status == Status::Completed)
            .count()
    }
}

struct Batch {
    snapshot: Mutex<DownloadSnapshot>,
    operation: AsyncMutex<()>,
    cancellation: Mutex<CancellationToken>,
    task: AsyncMutex<Option<JoinHandle<()>>>,
    speed: Mutex<(Instant, u64)>,
    state_path: PathBuf,
}
impl Batch {
    fn new(snapshot: DownloadSnapshot, state_path: PathBuf) -> Self {
        let bytes = snapshot.downloaded();
        Self {
            snapshot: Mutex::new(snapshot),
            operation: AsyncMutex::new(()),
            cancellation: Mutex::new(CancellationToken::new()),
            task: AsyncMutex::new(None),
            speed: Mutex::new((Instant::now(), bytes)),
            state_path,
        }
    }
    fn change(&self, f: impl FnOnce(&mut DownloadSnapshot)) {
        f(&mut self.snapshot.lock().unwrap_or_else(|e| e.into_inner()));
    }
    fn snapshot(&self) -> DownloadSnapshot {
        self.snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    fn persist(&self) -> Result<()> {
        atomic_write(&self.state_path, &serde_json::to_vec(&self.snapshot())?)
    }
}

pub struct DownloadManager {
    client: Client,
    directory: PathBuf,
    cache_directory: Mutex<PathBuf>,
    batches: AsyncMutex<HashMap<String, Arc<Batch>>>,
    admission: AsyncMutex<()>,
    permits: Arc<Semaphore>,
    concurrency: usize,
}
impl DownloadManager {
    pub fn open(directory: &Path, concurrency: usize) -> Result<Arc<Self>> {
        std::fs::create_dir_all(directory)?;
        let mut batches = HashMap::new();
        for entry in std::fs::read_dir(directory)? {
            let path = entry?.path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let record: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)
                .with_context(|| format!("下载记录损坏：{}", path.display()))?;
            let legacy = record.get("retention").is_none();
            let mut snapshot: DownloadSnapshot = serde_json::from_value(record)
                .with_context(|| format!("下载记录损坏：{}", path.display()))?;
            if !snapshot.root.is_absolute() {
                bail!("下载记录中的根目录无效");
            }
            if snapshot
                .cache_dir
                .as_ref()
                .is_some_and(|p| !p.is_absolute())
            {
                bail!("下载记录中的缓存目录无效");
            }
            for file in &snapshot.files {
                safe_join(&snapshot.root, &file.spec.path)?;
                temporary_paths(
                    &snapshot.root,
                    snapshot.cache_dir.as_deref(),
                    &snapshot.id,
                    &file.spec,
                )?;
            }
            // Session records are only kept on disk to clean up interrupted
            // transfers after an exit or crash; they never enter restored history.
            if snapshot.retention == DownloadRetention::Session
                || (legacy
                    && (snapshot.title == "资源索引" || snapshot.title.ends_with(" · 启动检查")))
            {
                // A locked temporary file must not block startup. Keep its
                // record for another cleanup attempt, without restoring it.
                if clear_temporary_files(&snapshot).is_ok() {
                    let _ = std::fs::remove_file(path);
                }
                continue;
            }
            if !snapshot.status.terminal() {
                snapshot.status = Status::Paused;
                for file in &mut snapshot.files {
                    if file.status != Status::Completed {
                        file.status = Status::Paused;
                    }
                }
            }
            snapshot.active_workers = 0;
            snapshot.bytes_per_second = 0;
            let id = snapshot.id.clone();
            batches.insert(id, Arc::new(Batch::new(snapshot, path)));
        }
        let concurrency = concurrency.clamp(1, 32);
        Ok(Arc::new(Self {
            client: crate::http_client()?,
            directory: directory.into(),
            cache_directory: Mutex::new(std::path::absolute(directory)?.join("cache")),
            batches: AsyncMutex::new(batches),
            admission: AsyncMutex::new(()),
            permits: Arc::new(Semaphore::new(concurrency)),
            concurrency,
        }))
    }
    /// Applies only to new batches; changing this never relocates active partials.
    pub fn set_cache_directory(&self, directory: &Path) -> Result<()> {
        if !directory.is_absolute() {
            bail!("下载缓存文件夹必须是绝对路径");
        }
        *self
            .cache_directory
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = directory.into();
        Ok(())
    }
    async fn batch(&self, id: &str) -> Result<Arc<Batch>> {
        self.batches
            .lock()
            .await
            .get(id)
            .cloned()
            .context("下载任务不存在")
    }
    pub async fn snapshots(&self) -> Vec<DownloadSnapshot> {
        let mut result: Vec<_> = self
            .batches
            .lock()
            .await
            .values()
            .map(|b| {
                let mut snapshot = b.snapshot();
                let mut speed = b.speed.lock().unwrap_or_else(|e| e.into_inner());
                let elapsed = speed.0.elapsed().as_secs_f64();
                if elapsed >= 0.15 {
                    snapshot.bytes_per_second = if snapshot.status == Status::Running {
                        (snapshot.downloaded().saturating_sub(speed.1) as f64 / elapsed) as u64
                    } else {
                        0
                    };
                    *speed = (Instant::now(), snapshot.downloaded());
                    b.change(|s| s.bytes_per_second = snapshot.bytes_per_second);
                }
                snapshot
            })
            .collect();
        result.sort_by_key(|s| std::cmp::Reverse(s.created_at));
        result
    }
    pub async fn snapshot(&self, id: &str) -> Result<DownloadSnapshot> {
        Ok(self.batch(id).await?.snapshot())
    }
    pub async fn enqueue(
        self: &Arc<Self>,
        title: String,
        root: PathBuf,
        specs: Vec<DownloadSpec>,
    ) -> Result<String> {
        self.enqueue_with_retention(title, root, specs, DownloadRetention::Persistent)
            .await
    }
    pub async fn enqueue_with_retention(
        self: &Arc<Self>,
        title: String,
        root: PathBuf,
        specs: Vec<DownloadSpec>,
        retention: DownloadRetention,
    ) -> Result<String> {
        let _admission = self.admission.lock().await;
        if !root.is_absolute() {
            bail!("下载根目录必须是绝对路径");
        }
        let mut unique = HashSet::new();
        let mut files = Vec::new();
        for spec in specs {
            let target = safe_join(&root, &spec.path)?;
            let url = reqwest::Url::parse(&spec.url)?;
            if !["https", "http"].contains(&url.scheme()) {
                bail!("只支持 HTTP/HTTPS 下载");
            }
            for (hash, length) in [(&spec.sha1, 40), (&spec.sha512, 128)] {
                if let Some(hash) = hash {
                    if hash.len() != length || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                        bail!("文件哈希无效：{}", spec.path);
                    }
                }
            }
            let key = target.to_string_lossy().to_lowercase();
            if !unique.insert(key) {
                bail!("同一批次存在重复的目标：{}", spec.path);
            }
            files.push(FileSnapshot {
                total: spec.size,
                spec,
                status: Status::Queued,
                downloaded: 0,
                attempts: 0,
                error: None,
            });
        }
        for batch in self.batches.lock().await.values() {
            let s = batch.snapshot();
            if !matches!(s.status, Status::Completed | Status::Cancelled) {
                for file in &s.files {
                    let target = safe_join(&s.root, &file.spec.path)?
                        .to_string_lossy()
                        .to_lowercase();
                    if unique.contains(&target) {
                        bail!("文件已在另一个下载任务中：{}", file.spec.path);
                    }
                }
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let cache_dir = self
            .cache_directory
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        prepare_cache_directory(&cache_dir)?;
        let snapshot = DownloadSnapshot {
            id: id.clone(),
            title,
            retention,
            root,
            cache_dir: Some(cache_dir),
            files,
            status: Status::Queued,
            bytes_per_second: 0,
            active_workers: 0,
            error: None,
            created_at: now(),
            steps: vec![
                Step {
                    name: "下载文件".into(),
                    status: Status::Queued,
                    detail: String::new(),
                },
                Step {
                    name: "完整性校验".into(),
                    status: Status::Queued,
                    detail: String::new(),
                },
            ],
        };
        let batch = Arc::new(Batch::new(
            snapshot,
            self.directory.join(format!("{id}.json")),
        ));
        batch.persist()?;
        self.batches.lock().await.insert(id.clone(), batch);
        self.resume(&id).await?;
        Ok(id)
    }
    pub async fn resume(self: &Arc<Self>, id: &str) -> Result<()> {
        let batch = self.batch(id).await?;
        let _op = batch.operation.lock().await;
        let status = batch.snapshot().status;
        if matches!(status, Status::Running | Status::Pausing) {
            return Ok(());
        }
        if status == Status::Completed {
            return Ok(());
        }
        if status == Status::Cancelled {
            bail!("已取消的任务不能继续，请重新添加");
        }
        if let Some(task) = batch.task.lock().await.take() {
            task.await?;
        }
        let cancel = CancellationToken::new();
        *batch.cancellation.lock().unwrap_or_else(|e| e.into_inner()) = cancel.clone();
        batch.change(|s| {
            s.status = Status::Running;
            s.error = None;
            s.steps[0].status = Status::Running;
            s.steps[1].status = Status::Queued;
            for f in &mut s.files {
                if f.status != Status::Completed {
                    f.status = Status::Queued;
                    f.error = None;
                }
            }
        });
        batch.persist()?;
        let manager = self.clone();
        let worker_batch = batch.clone();
        *batch.task.lock().await = Some(tokio::spawn(async move {
            manager.run(worker_batch, cancel).await;
        }));
        Ok(())
    }
    /// The returned future completes only after every worker has stopped writing.
    pub async fn pause(&self, id: &str) -> Result<()> {
        self.stop(id, false).await
    }
    pub async fn cancel(&self, id: &str) -> Result<()> {
        self.stop(id, true).await
    }
    /// Supply a user-selected original file for a blocked pack download. Verify
    /// the recorded size/hash before committing it and resuming its workflow.
    pub async fn supply_file(self: &Arc<Self>, id: &str, path: &str, source: &Path) -> Result<()> {
        let batch = self.batch(id).await?;
        {
            let _operation = batch.operation.lock().await;
            let snapshot = batch.snapshot();
            if !matches!(snapshot.status, Status::Failed | Status::Paused) {
                bail!("请先暂停下载或等待文件下载失败");
            }
            let index = snapshot
                .files
                .iter()
                .position(|file| file.spec.path == path)
                .context("下载任务中没有此文件")?;
            let spec = &snapshot.files[index].spec;
            if spec.sha1.is_none() && spec.sha512.is_none() {
                bail!("此文件缺少用于确认原始版本的哈希");
            }
            if let Some(task) = batch.task.lock().await.take() {
                task.await?;
            }
            let token = CancellationToken::new();
            let staged = staging_path(&snapshot.root, id, spec)?;
            tokio::fs::create_dir_all(staged.parent().context("下载目标无父目录")?).await?;
            let result = async {
                tokio::fs::copy(source, &staged).await?;
                verify_file(&staged, spec, &token)
                    .await
                    .context("所选文件与整合包要求的版本不符")?;
                tokio::fs::rename(&staged, safe_join(&snapshot.root, path)?).await?;
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if result.is_err() {
                let _ = tokio::fs::remove_file(&staged).await;
            }
            result?;
            batch.change(|snapshot| {
                let file = &mut snapshot.files[index];
                file.status = Status::Completed;
                file.downloaded = spec
                    .size
                    .unwrap_or_else(|| std::fs::metadata(source).map(|m| m.len()).unwrap_or(0));
                file.total = Some(file.downloaded);
                file.error = None;
            });
            batch.persist()?;
        }
        self.resume(id).await
    }
    async fn stop(&self, id: &str, cancelled: bool) -> Result<()> {
        let batch = self.batch(id).await?;
        let _op = batch.operation.lock().await;
        let status = batch.snapshot().status;
        if matches!(status, Status::Completed | Status::Cancelled)
            || (status == Status::Failed && !cancelled)
        {
            return Ok(());
        }
        batch.change(|s| s.status = Status::Pausing);
        batch
            .cancellation
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cancel();
        if let Some(task) = batch.task.lock().await.take() {
            task.await?;
        }
        batch.change(|s| {
            s.status = if s.files.iter().all(|f| f.status == Status::Completed) {
                Status::Completed
            } else if cancelled {
                Status::Cancelled
            } else {
                Status::Paused
            };
            s.active_workers = 0;
            s.bytes_per_second = 0;
            s.steps[0].status = s.status;
            for f in &mut s.files {
                if !f.status.terminal() {
                    f.status = s.status;
                }
            }
        });
        batch.persist()
    }
    pub async fn clear(&self, id: &str) -> Result<()> {
        let _admission = self.admission.lock().await;
        let batch = self.batch(id).await?;
        let _op = batch.operation.lock().await;
        let status = batch
            .snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .status;
        if !status.terminal() {
            bail!("请先取消任务再清理记录");
        }
        if let Some(task) = batch.task.lock().await.take() {
            task.await?;
        }
        let cleanup = batch.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            clear_temporary_files(&cleanup.snapshot())?;
            std::fs::remove_file(&cleanup.state_path)?;
            Ok(())
        })
        .await??;
        self.batches.lock().await.remove(id);
        Ok(())
    }
    pub async fn pause_all(&self) -> Result<()> {
        let ids: Vec<_> = self.batches.lock().await.keys().cloned().collect();
        for id in ids {
            if self.snapshot(&id).await?.status == Status::Running {
                self.pause(&id).await?;
            }
        }
        Ok(())
    }
    pub async fn wait(&self, id: &str, cancel: &CancellationToken) -> Result<DownloadSnapshot> {
        loop {
            let s = self.snapshot(id).await?;
            if s.status == Status::Completed {
                return Ok(s);
            }
            if s.status == Status::Failed {
                bail!(
                    "{} 个文件下载失败，可在下载中心重试",
                    s.files
                        .iter()
                        .filter(|f| f.status == Status::Failed)
                        .count()
                );
            }
            if s.status == Status::Cancelled {
                bail!("下载已取消");
            }
            tokio::select! { _ = cancel.cancelled() => { self.cancel(id).await?; bail!("操作已取消"); }, _ = tokio::time::sleep(Duration::from_millis(100)) => {} }
        }
    }
    async fn run(self: Arc<Self>, batch: Arc<Batch>, cancel: CancellationToken) {
        let initial = batch.snapshot();
        let pending: Vec<_> = initial
            .files
            .into_iter()
            .enumerate()
            .filter(|(_, f)| f.status != Status::Completed)
            .map(|(i, file)| (i, file.spec))
            .collect();
        stream::iter(pending).for_each_concurrent(self.concurrency, |(index, spec)| {
            let manager = self.clone(); let batch = batch.clone(); let cancel = cancel.clone();
            let root = initial.root.clone(); let batch_id = initial.id.clone(); let cache_dir = initial.cache_dir.clone();
            async move {
                let permit = tokio::select! { biased; _ = cancel.cancelled() => return, p = manager.permits.acquire() => p };
                let Ok(_permit) = permit else { return; };
                if cancel.is_cancelled() { return; }
                batch.change(|s| { s.active_workers += 1; s.files[index].status = Status::Running; });
                let mut outcome = Err(anyhow!("下载未执行"));
                for attempt in 0..3 {
                    if cancel.is_cancelled() { break; }
                    batch.change(|s| { s.files[index].attempts += 1; });
                    outcome = transfer(&manager.client, &root, cache_dir.as_deref(), &batch_id, &spec, &cancel, |bytes, total| {
                        batch.change(|s| { s.files[index].downloaded = bytes; s.files[index].total = total; });
                    }).await;
                    if outcome.is_ok() || cancel.is_cancelled() { break; }
                    if attempt < 2 {
                        tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(Duration::from_millis(300 * (1 << attempt))) => {} }
                    }
                }
                batch.change(|s| {
                    s.active_workers -= 1;
                    let f = &mut s.files[index];
                    // A commit that won the cancellation race stays completed.
                    match outcome {
                        Ok(()) => { f.status = Status::Completed; f.error = None; },
                        Err(_) if cancel.is_cancelled() => { f.status = Status::Paused; },
                        Err(error) => { f.status = Status::Failed; f.error = Some(format!("{error:#}")); },
                    }
                });
            }
        }).await;
        batch.change(|s| {
            s.active_workers = 0;
            s.bytes_per_second = 0;
            if s.status == Status::Running {
                s.status = if s.files.iter().all(|f| f.status == Status::Completed) {
                    Status::Completed
                } else {
                    Status::Failed
                };
                s.steps[0].status = s.status;
                s.steps[1].status = s.status;
                s.steps[1].detail = format!("已校验 {} / {} 个文件", s.completed(), s.files.len());
            }
        });
        if let Err(error) = batch.persist() {
            batch.change(|s| {
                s.status = Status::Failed;
                s.error = Some(format!("无法保存下载状态：{error}"));
            });
        }
        if let Some(cache) = &initial.cache_dir {
            if let Ok(directory) = safe_join(cache, format!("tmcl-downloads/{}", initial.id)) {
                // remove_dir only succeeds when every owned file has been cleaned up.
                let _ = tokio::fs::remove_dir(directory).await;
            }
        }
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn clear_temporary_files(snapshot: &DownloadSnapshot) -> Result<()> {
    // Inspect each directory once. Completed asset batches contain thousands of
    // files but usually no leftovers, so per-file filesystem probes are costly.
    let mut directories: HashMap<(PathBuf, PathBuf), HashSet<OsString>> = HashMap::new();
    for f in &snapshot.files {
        let part = temporary_relative_path(snapshot.cache_dir.is_some(), &snapshot.id, &f.spec);
        let cache_root = snapshot.cache_dir.as_deref().unwrap_or(&snapshot.root);
        for (root, path) in [
            (cache_root, part.clone()),
            (cache_root, part.with_extension("part.json")),
            (
                snapshot.root.as_path(),
                staging_relative_path(&snapshot.id, &f.spec),
            ),
        ] {
            directories
                .entry((
                    root.to_path_buf(),
                    path.parent().context("无效临时文件目录")?.to_path_buf(),
                ))
                .or_default()
                .insert(path.file_name().context("无效临时文件名称")?.to_os_string());
        }
    }
    for ((root, relative), names) in directories {
        let directory = if relative.as_os_str().is_empty() {
            root.clone()
        } else {
            safe_join(&root, &relative)?
        };
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let name = entry?.file_name();
            if names.contains(&name) {
                // Delete only exact owned names, validating links before removal.
                // Finished files and unrelated contents in the cache are retained.
                let path = safe_join(&root, relative.join(name))?;
                match std::fs::remove_file(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
    }
    if let Some(cache) = &snapshot.cache_dir {
        let directory = safe_join(cache, format!("tmcl-downloads/{}", snapshot.id))?;
        let _ = std::fs::remove_dir(directory);
    }
    Ok(())
}
/// Probe a private namespace without modifying any existing cache/user files.
pub fn prepare_cache_directory(directory: &Path) -> Result<()> {
    if !directory.is_absolute() {
        bail!("下载缓存文件夹必须是绝对路径");
    }
    let owned = safe_join(directory, "tmcl-downloads")?;
    let probe = safe_join(&owned, format!(".probe-{}", uuid::Uuid::new_v4()))?;
    let mut created = false;
    let result = (|| -> Result<()> {
        std::fs::create_dir_all(&owned)?;
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)?;
        created = true;
        file.sync_all()?;
        drop(file);
        Ok(())
    })();
    let cleanup = if created {
        std::fs::remove_file(&probe)
    } else {
        Ok(())
    };
    result.with_context(|| format!("无法写入下载缓存文件夹：{}", directory.display()))?;
    cleanup.context("无法清理缓存目录测试文件")?;
    Ok(())
}
fn temporary_paths(
    root: &Path,
    cache: Option<&Path>,
    id: &str,
    spec: &DownloadSpec,
) -> Result<(PathBuf, PathBuf)> {
    let base = cache.unwrap_or(root);
    let relative = temporary_relative_path(cache.is_some(), id, spec);
    Ok((
        safe_join(base, &relative)?,
        safe_join(base, relative.with_extension("part.json"))?,
    ))
}
fn temporary_relative_path(cached: bool, id: &str, spec: &DownloadSpec) -> PathBuf {
    if cached {
        PathBuf::from(format!(
            "tmcl-downloads/{id}/{}.part",
            hex::encode(Sha1::digest(spec.path.as_bytes()))
        ))
    } else {
        PathBuf::from(format!("{}.tmcl-{id}.part", spec.path))
    }
}
fn staging_path(root: &Path, id: &str, spec: &DownloadSpec) -> Result<PathBuf> {
    safe_join(root, staging_relative_path(id, spec))
}
fn staging_relative_path(id: &str, spec: &DownloadSpec) -> PathBuf {
    Path::new(&spec.path).with_file_name(format!(
        ".tmcl-{id}-{}.installing",
        hex::encode(Sha1::digest(spec.path.as_bytes()))
    ))
}

async fn commit_file(
    root: &Path,
    id: &str,
    spec: &DownloadSpec,
    part: &Path,
    cached: bool,
    cancel: &CancellationToken,
) -> Result<()> {
    cancel_check(cancel)?;
    let target = safe_join(root, &spec.path)?;
    if !cached {
        tokio::fs::rename(part, target)
            .await
            .context("无法提交已下载文件")?;
        return Ok(());
    }
    // The cache may be on another volume. Stage beside the destination so the
    // final rename is atomic, and retain the verified cache until it succeeds.
    let staging = staging_path(root, id, spec)?;
    let result = async {
        let mut input = tokio::fs::File::open(part).await?;
        let mut output = tokio::fs::File::create(&staging).await?;
        let mut buffer = vec![0; 64 * 1024];
        loop {
            cancel_check(cancel)?;
            let count = input.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count]).await?;
        }
        output.flush().await?;
        output.sync_all().await?;
        drop(output);
        cancel_check(cancel)?;
        safe_join(root, &spec.path)?;
        staging_path(root, id, spec)?;
        tokio::fs::rename(&staging, &target)
            .await
            .context("无法提交已下载文件")?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&staging).await;
    } else {
        let _ = tokio::fs::remove_file(part).await;
    }
    result
}
#[derive(Serialize, Deserialize)]
struct PartialMetadata {
    url: String,
    validator: Option<String>,
}

async fn transfer(
    client: &Client,
    root: &Path,
    cache: Option<&Path>,
    id: &str,
    spec: &DownloadSpec,
    cancel: &CancellationToken,
    progress: impl Fn(u64, Option<u64>),
) -> Result<()> {
    let target = safe_join(root, &spec.path)?;
    // Validate launcher-owned temporary paths as well as the final target.
    let (part, meta) = temporary_paths(root, cache, id, spec)?;
    let expected_hash = spec.sha1.is_some() || spec.sha512.is_some();
    if expected_hash && target.is_file() && verify_file(&target, spec, cancel).await.is_ok() {
        let len = tokio::fs::metadata(&target).await?.len();
        progress(len, Some(len));
        let _ = tokio::fs::remove_file(&part).await;
        let _ = tokio::fs::remove_file(&meta).await;
        return Ok(());
    }
    tokio::fs::create_dir_all(target.parent().context("无效下载目录")?).await?;
    tokio::fs::create_dir_all(part.parent().context("无效缓存目录")?).await?;
    let previous: Option<PartialMetadata> = tokio::fs::read(&meta)
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let mut offset = tokio::fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if previous
        .as_ref()
        .is_none_or(|p| p.url != spec.url || (!expected_hash && p.validator.is_none()))
    {
        offset = 0;
    }
    if let Some(size) = spec.size {
        if offset > size {
            offset = 0;
        }
        if offset == size && expected_hash && verify_file(&part, spec, cancel).await.is_ok() {
            commit_file(root, id, spec, &part, cache.is_some(), cancel).await?;
            let _ = tokio::fs::remove_file(&meta).await;
            progress(size, Some(size));
            return Ok(());
        }
    }
    let mut request = client
        .get(&spec.url)
        .header(header::ACCEPT_ENCODING, "identity");
    if offset > 0 {
        request = request.header(header::RANGE, format!("bytes={offset}-"));
        if let Some(validator) = previous.as_ref().and_then(|p| p.validator.as_ref()) {
            request = request.header(header::IF_RANGE, validator);
        }
    }
    let response = tokio::select! { biased; _ = cancel.cancelled() => bail!("已暂停"), r = request.send() => r? };
    if response.status() == StatusCode::RANGE_NOT_SATISFIABLE && offset > 0 {
        tokio::fs::remove_file(&part).await?;
        let _ = tokio::fs::remove_file(&meta).await;
        bail!("服务器拒绝断点，将重新下载");
    }
    let response = response.error_for_status()?;
    let total = if response.status() == StatusCode::PARTIAL_CONTENT {
        let header = response
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|h| h.to_str().ok())
            .context("断点响应缺少 Content-Range")?;
        let (start, end, total) = parse_content_range(header)?;
        if start != offset || end < start || end >= total {
            bail!("服务器返回了错误的断点范围");
        }
        if let Some(size) = spec.size {
            if total != size {
                bail!("服务器文件长度与清单不一致");
            }
        }
        Some(total)
    } else if response.status() == StatusCode::OK {
        offset = 0; // A server may ignore Range or invalidate If-Range.
        response.content_length().or(spec.size)
    } else {
        bail!("不支持的下载 HTTP 状态：{}", response.status());
    };
    if let (Some(expected), Some(actual)) = (spec.size, total) {
        if expected != actual {
            bail!("文件长度不符：预期 {expected}，实际 {actual}");
        }
    }
    let validator = response
        .headers()
        .get(header::ETAG)
        .filter(|v| !v.as_bytes().starts_with(b"W/"))
        .or_else(|| response.headers().get(header::LAST_MODIFIED))
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned);
    atomic_write(
        &meta,
        &serde_json::to_vec(&PartialMetadata {
            url: spec.url.clone(),
            validator,
        })?,
    )?;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .append(offset > 0)
        .open(&part)
        .await?;
    let mut received = offset;
    progress(received, total);
    let mut body = response.bytes_stream();
    loop {
        let chunk = tokio::select! { biased; _ = cancel.cancelled() => { file.flush().await?; bail!("已暂停"); }, item = body.next() => item };
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk?;
        // Do not cancel write_all halfway through: its partial writes are not
        // cancellation-safe. Pause waits for this bounded chunk to flush.
        file.write_all(&chunk).await?;
        received += chunk.len() as u64;
        progress(received, total);
        if total.is_some_and(|t| received > t) {
            bail!("响应数据超过预期长度");
        }
    }
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    if total.is_some_and(|t| t != received) {
        bail!("下载流提前结束");
    }
    if let Err(error) = verify_file(&part, spec, cancel).await {
        if !cancel.is_cancelled() {
            let _ = tokio::fs::remove_file(&part).await;
            let _ = tokio::fs::remove_file(&meta).await;
        }
        return Err(error);
    }
    commit_file(root, id, spec, &part, cache.is_some(), cancel).await?;
    let _ = tokio::fs::remove_file(&meta).await;
    progress(received, Some(received));
    Ok(())
}
fn cancel_check(token: &CancellationToken) -> Result<()> {
    if token.is_cancelled() {
        bail!("操作已暂停或取消");
    }
    Ok(())
}
fn parse_content_range(value: &str) -> Result<(u64, u64, u64)> {
    let (range, size) = value
        .strip_prefix("bytes ")
        .context("无效 Content-Range")?
        .split_once('/')
        .context("无效 Content-Range")?;
    let (start, end) = range.split_once('-').context("无效 Content-Range")?;
    Ok((start.parse()?, end.parse()?, size.parse()?))
}
pub async fn verify_file(
    path: &Path,
    spec: &DownloadSpec,
    cancel: &CancellationToken,
) -> Result<()> {
    let mut file = tokio::fs::File::open(path).await?;
    let size = file.metadata().await?.len();
    if spec.size.is_some_and(|expected| expected != size) {
        bail!("文件长度校验失败");
    }
    if spec.sha1.is_none() && spec.sha512.is_none() {
        return Ok(());
    }
    let mut sha1 = Sha1::new();
    let mut sha512 = Sha512::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        cancel_check(cancel)?;
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        if spec.sha1.is_some() {
            sha1.update(&buffer[..count]);
        }
        if spec.sha512.is_some() {
            sha512.update(&buffer[..count]);
        }
    }
    if spec
        .sha1
        .as_ref()
        .is_some_and(|expected| !expected.eq_ignore_ascii_case(&hex::encode(sha1.finalize())))
    {
        bail!("SHA-1 校验失败，已丢弃损坏文件");
    }
    if spec
        .sha512
        .as_ref()
        .is_some_and(|expected| !expected.eq_ignore_ascii_case(&hex::encode(sha512.finalize())))
    {
        bail!("SHA-512 校验失败，已丢弃损坏文件");
    }
    Ok(())
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    fn completed_snapshot(root: &Path, cached: bool, count: usize) -> DownloadSnapshot {
        DownloadSnapshot {
            id: uuid::Uuid::new_v4().to_string(),
            title: "completed assets".into(),
            retention: DownloadRetention::Persistent,
            root: root.to_path_buf(),
            cache_dir: cached.then(|| root.join("cache")),
            status: Status::Completed,
            files: (0..count)
                .map(|i| FileSnapshot {
                    spec: DownloadSpec {
                        url: "https://example.invalid/asset".into(),
                        path: format!("assets/objects/{:02x}/{i:040x}", i % 256),
                        size: Some(8),
                        sha1: None,
                        sha512: None,
                    },
                    status: Status::Completed,
                    downloaded: 8,
                    total: Some(8),
                    attempts: 1,
                    error: None,
                })
                .collect(),
            steps: vec![],
            bytes_per_second: 0,
            active_workers: 0,
            error: None,
            created_at: now(),
        }
    }

    #[tokio::test]
    async fn clear_large_completed_batch_cleans_leftovers_and_keeps_unrelated_files() {
        for cached in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let state = temp.path().join("records");
            let manager = DownloadManager::open(&state, 1).unwrap();
            let snapshot = completed_snapshot(temp.path(), cached, 20_000);
            let id = snapshot.id.clone();
            let record = state.join(format!("{id}.json"));
            let mut owned = vec![];
            let mut retained = vec![];
            for index in [0, 19_999] {
                let spec = &snapshot.files[index].spec;
                let target = safe_join(&snapshot.root, &spec.path).unwrap();
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::write(&target, b"finished").unwrap();
                retained.push(target);
                let (part, meta) =
                    temporary_paths(&snapshot.root, snapshot.cache_dir.as_deref(), &id, spec)
                        .unwrap();
                std::fs::create_dir_all(part.parent().unwrap()).unwrap();
                let stage = staging_path(&snapshot.root, &id, spec).unwrap();
                for path in [&part, &meta, &stage] {
                    std::fs::write(path, b"leftover").unwrap();
                    owned.push(path.clone());
                }
                // Similar names from another task and user files must survive.
                for path in [
                    part.with_file_name("unrelated.part"),
                    stage.with_file_name(".tmcl-other.installing"),
                ] {
                    std::fs::write(&path, b"finished").unwrap();
                    retained.push(path);
                }
            }
            let batch = Arc::new(Batch::new(snapshot, record.clone()));
            batch.persist().unwrap();
            manager.batches.lock().await.insert(id.clone(), batch);
            let start = Instant::now();
            manager.clear(&id).await.unwrap();
            eprintln!(
                "clear 20,000 completed files (cached={cached}): {:?}",
                start.elapsed()
            );
            assert!(manager.snapshots().await.is_empty());
            assert!(!record.exists());
            for path in owned {
                assert!(!path.exists(), "leftover: {}", path.display());
            }
            for path in retained {
                assert_eq!(std::fs::read(path).unwrap(), b"finished");
            }
        }
    }

    #[tokio::test]
    async fn failed_cleanup_keeps_record_for_retry() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("records");
        let manager = DownloadManager::open(&state, 1).unwrap();
        let snapshot = completed_snapshot(temp.path(), true, 1);
        let id = snapshot.id.clone();
        let record = state.join(format!("{id}.json"));
        let (part, _) = temporary_paths(
            &snapshot.root,
            snapshot.cache_dir.as_deref(),
            &id,
            &snapshot.files[0].spec,
        )
        .unwrap();
        // A directory occupying a temporary filename must never be deleted recursively.
        std::fs::create_dir_all(&part).unwrap();
        let batch = Arc::new(Batch::new(snapshot, record.clone()));
        batch.persist().unwrap();
        manager.batches.lock().await.insert(id.clone(), batch);
        assert!(manager.clear(&id).await.is_err());
        assert!(record.exists());
        assert_eq!(manager.snapshots().await.len(), 1);
        assert!(part.is_dir());
        std::fs::remove_dir(&part).unwrap();
        manager.clear(&id).await.unwrap();
        assert!(!record.exists());
        assert!(manager.snapshots().await.is_empty());
    }

    #[tokio::test]
    async fn cancelling_staged_copy_preserves_target_and_verified_cache() {
        let directory = tempfile::tempdir().unwrap();
        let part = directory.path().join("cached.part");
        std::fs::write(&part, vec![7; 8 * 1024 * 1024]).unwrap();
        let spec = DownloadSpec {
            url: "https://example.test/file".into(),
            path: "game.jar".into(),
            size: None,
            sha1: None,
            sha512: None,
        };
        let target = directory.path().join(&spec.path);
        std::fs::write(&target, b"original").unwrap();
        let stage = staging_path(directory.path(), "test", &spec).unwrap();
        let cancel = CancellationToken::new();
        let copy = commit_file(directory.path(), "test", &spec, &part, true, &cancel);
        let interrupt = async {
            tokio::time::timeout(Duration::from_secs(3), async {
                while !stage.exists() {
                    tokio::task::yield_now().await;
                }
                cancel.cancel();
            })
            .await
            .unwrap();
        };
        let (result, ()) = tokio::join!(copy, interrupt);
        assert!(result.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        assert_eq!(std::fs::metadata(&part).unwrap().len(), 8 * 1024 * 1024);
        assert!(!stage.exists());
        commit_file(
            directory.path(),
            "test",
            &spec,
            &part,
            true,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), vec![7; 8 * 1024 * 1024]);
        assert!(!part.exists());
    }
}
