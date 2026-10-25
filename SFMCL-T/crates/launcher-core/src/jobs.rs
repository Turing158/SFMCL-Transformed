use crate::downloads::{now, DownloadRetention, Status, Step};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
pub enum JobKind {
    Install,
    Modpack,
    Launch,
    Repair,
    Login,
    LoginRefresh,
    Other,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub id: String,
    pub title: String,
    pub status: Status,
    pub steps: Vec<Step>,
    pub current_step: usize,
    pub download_id: Option<String>,
    pub error: Option<String>,
    pub log: Vec<String>,
    pub created_at: u64,
}
pub struct Job {
    kind: JobKind,
    snapshot: Mutex<JobSnapshot>,
    pub cancel: CancellationToken,
}
impl Job {
    pub fn cancellation_message(&self) -> &'static str {
        match self.kind {
            JobKind::Install | JobKind::Modpack => "安装已取消",
            JobKind::Launch => "启动已取消",
            JobKind::Repair => "修复已取消",
            JobKind::Login => "登录已取消",
            JobKind::LoginRefresh => "登录刷新已取消",
            JobKind::Other => "任务已取消",
        }
    }
    pub fn snapshot(&self) -> JobSnapshot {
        self.snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    fn update(&self, change: impl FnOnce(&mut JobSnapshot)) {
        change(&mut self.snapshot.lock().unwrap_or_else(|e| e.into_inner()));
    }
    pub fn step(&self, index: usize, detail: impl Into<String>) {
        self.update(|s| {
            for previous in s.steps.iter_mut().take(index) {
                previous.status = Status::Completed;
            }
            s.current_step = index;
            if let Some(step) = s.steps.get_mut(index) {
                step.status = Status::Running;
                step.detail = detail.into();
            }
            s.status = Status::Running;
            s.download_id = None;
        });
    }
    pub fn download(&self, id: String, status: Status) {
        self.update(|s| {
            s.download_id = Some(id);
            s.status = if status == Status::Completed {
                Status::Running
            } else {
                status
            };
            s.steps[s.current_step].status = s.status;
        });
    }
    pub fn log(&self, line: String) {
        self.update(|s| {
            if s.log.len() >= 300 {
                s.log.remove(0);
            }
            s.log.push(line);
        });
    }
    pub fn detach_download(&self) {
        self.update(|snapshot| snapshot.download_id = None);
    }
    pub fn finish(&self, result: &anyhow::Result<()>) {
        self.update(|s| match result {
            Ok(()) => {
                s.status = Status::Completed;
                for step in &mut s.steps {
                    step.status = Status::Completed;
                }
            }
            Err(error) => {
                s.status = if self.cancel.is_cancelled() {
                    Status::Cancelled
                } else {
                    Status::Failed
                };
                s.error = Some(format!("{error:#}"));
                s.steps[s.current_step].status = s.status;
            }
        });
    }
}
#[derive(Default)]
pub struct Jobs {
    jobs: Mutex<Vec<Arc<Job>>>,
}
impl Jobs {
    pub fn create(&self, kind: JobKind, title: String, steps: &[&str]) -> Arc<Job> {
        let job = Arc::new(Job {
            kind,
            cancel: CancellationToken::new(),
            snapshot: Mutex::new(JobSnapshot {
                id: uuid::Uuid::new_v4().to_string(),
                title,
                status: Status::Running,
                current_step: 0,
                download_id: None,
                error: None,
                log: vec![],
                created_at: now(),
                steps: steps
                    .iter()
                    .map(|name| Step {
                        name: (*name).into(),
                        status: Status::Queued,
                        detail: String::new(),
                    })
                    .collect(),
            }),
        });
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(job.clone());
        job
    }
    pub fn snapshots(&self) -> Vec<JobSnapshot> {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .rev()
            .map(|j| j.snapshot())
            .collect()
    }
    pub fn cancel(&self, id: &str) -> anyhow::Result<()> {
        let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        let job = jobs
            .iter()
            .find(|j| j.snapshot().id == id)
            .ok_or_else(|| anyhow::anyhow!("任务不存在"))?;
        job.cancel.cancel();
        Ok(())
    }
    pub fn cancel_all(&self) {
        for job in self.jobs.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            job.cancel.cancel();
        }
    }
}

/// Failed file batches remain attached to their owning workflow. Retrying in
/// the download center continues the same workflow instead of losing it.
pub async fn download(
    manager: &Arc<crate::downloads::DownloadManager>,
    job: &Job,
    title: String,
    root: std::path::PathBuf,
    files: Vec<crate::downloads::DownloadSpec>,
) -> anyhow::Result<()> {
    download_with_retention(
        manager,
        job,
        title,
        root,
        files,
        if matches!(job.kind, JobKind::Modpack) {
            DownloadRetention::Session
        } else {
            DownloadRetention::Persistent
        },
    )
    .await
}

/// Checks remain visible and retryable during this run, but are not restored.
pub async fn download_session(
    manager: &Arc<crate::downloads::DownloadManager>,
    job: &Job,
    title: String,
    root: std::path::PathBuf,
    files: Vec<crate::downloads::DownloadSpec>,
) -> anyhow::Result<()> {
    download_with_retention(manager, job, title, root, files, DownloadRetention::Session).await
}

async fn download_with_retention(
    manager: &Arc<crate::downloads::DownloadManager>,
    job: &Job,
    title: String,
    root: std::path::PathBuf,
    files: Vec<crate::downloads::DownloadSpec>,
    retention: DownloadRetention,
) -> anyhow::Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    let existing = manager.snapshots().await.into_iter().find(|s| {
        s.root == root
            && s.title == title
            && s.retention == retention
            && matches!(s.status, Status::Paused | Status::Failed)
            && s.files.iter().map(|f| &f.spec).eq(files.iter())
    });
    let id = if let Some(existing) = existing {
        manager.resume(&existing.id).await?;
        existing.id
    } else {
        manager
            .enqueue_with_retention(title, root, files, retention)
            .await?
    };
    loop {
        let snapshot = manager.snapshot(&id).await?;
        job.download(id.clone(), snapshot.status);
        if snapshot.status == Status::Completed {
            return Ok(());
        }
        if snapshot.status == Status::Cancelled {
            anyhow::bail!("下载已取消");
        }
        tokio::select! {
            _ = job.cancel.cancelled() => { manager.cancel(&id).await?; anyhow::bail!(job.cancellation_message()); },
            _ = tokio::time::sleep(std::time::Duration::from_millis(150)) => {}
        }
    }
}
