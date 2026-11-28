use crate::downloads::{now, DownloadRetention, Status, Step};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
pub enum JobKind {
    Install,
    Modpack,
    ModpackExport,
    ModpackUpdate,
    Launch,
    Repair,
    Login,
    LoginRefresh,
    Other,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchContext {
    pub version_id: String,
    pub game_version: String,
    pub directory: String,
    pub player_name: String,
    #[serde(default)]
    pub offline_lan: bool,
    pub running: bool,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_update_path: Option<std::path::PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub datapack_world: Option<std::path::PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch: Option<LaunchContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crash_report: Option<crate::minecraft::crash::CrashReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_runs: Option<crate::minecraft::commands::CommandRuns>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_exit: Option<crate::minecraft::commands::GameExit>,
}
pub struct Job {
    kind: JobKind,
    snapshot: Mutex<JobSnapshot>,
    pub cancel: CancellationToken,
    pub command_cancel: CancellationToken,
}
impl Job {
    pub(crate) fn set_mod_update_path(&self, path: std::path::PathBuf) {
        self.update(|snapshot| snapshot.mod_update_path = Some(path));
    }
    pub(crate) fn set_datapack_world(&self, path: std::path::PathBuf) {
        self.update(|snapshot| snapshot.datapack_world = Some(path));
    }
    pub fn initialize_commands(&self, pre_launch: bool, post_exit: bool) {
        use crate::minecraft::commands::{CommandRun, CommandRuns};
        self.update(|snapshot| {
            snapshot.command_runs = Some(CommandRuns {
                pre_launch: CommandRun::pending(pre_launch),
                post_exit: CommandRun::pending(post_exit),
            })
        });
    }
    pub fn set_command_run(
        &self,
        phase: crate::minecraft::commands::CommandPhase,
        run: crate::minecraft::commands::CommandRun,
    ) {
        if !matches!(self.kind, JobKind::Launch) {
            return;
        }
        use crate::minecraft::commands::{CommandPhase, CommandRun, CommandRuns};
        self.update(|snapshot| {
            let runs = snapshot.command_runs.get_or_insert_with(|| CommandRuns {
                pre_launch: CommandRun::pending(false),
                post_exit: CommandRun::pending(false),
            });
            match phase {
                CommandPhase::PreLaunch => runs.pre_launch = run,
                CommandPhase::PostExit => runs.post_exit = run,
            }
        });
    }
    pub fn set_game_exit(&self, exit: crate::minecraft::commands::GameExit) {
        if !matches!(self.kind, JobKind::Launch) {
            return;
        }
        self.update(|snapshot| snapshot.game_exit = Some(exit));
    }
    pub fn cancel_requested(&self) {
        use crate::minecraft::commands::CommandStatus;
        let snapshot = self.snapshot();
        if snapshot
            .command_runs
            .as_ref()
            .is_some_and(|runs| runs.post_exit.status == CommandStatus::Running)
        {
            self.command_cancel.cancel();
        } else {
            self.cancel.cancel();
        }
    }
    pub fn set_crash_report(&self, report: crate::minecraft::crash::CrashReport) {
        self.update(|snapshot| snapshot.crash_report = Some(report));
    }
    pub fn cancellation_message(&self) -> &'static str {
        match self.kind {
            JobKind::Install | JobKind::Modpack => "安装已取消",
            JobKind::ModpackExport => "整合包导出已取消",
            JobKind::ModpackUpdate => "整合包更新已取消",
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
    pub(crate) fn sync_launch(&self, snapshot: JobSnapshot) {
        if matches!(self.kind, JobKind::Launch) && snapshot.id == self.snapshot().id {
            if snapshot.status == Status::Cancelled {
                self.cancel.cancel();
            }
            self.update(|current| *current = snapshot);
        }
    }
    fn update(&self, change: impl FnOnce(&mut JobSnapshot)) {
        change(&mut self.snapshot.lock().unwrap_or_else(|e| e.into_inner()));
    }
    pub fn set_launch_context(&self, context: LaunchContext) {
        if matches!(self.kind, JobKind::Launch) {
            self.update(|snapshot| snapshot.launch = Some(context));
        }
    }
    pub fn set_launch_running(&self, running: bool) {
        self.update(|snapshot| {
            if let Some(launch) = &mut snapshot.launch {
                launch.running = running;
            }
        });
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
        self.update(|s| {
            use crate::minecraft::commands::CommandStatus;
            if let Some(runs) = &mut s.command_runs {
                for run in [&mut runs.pre_launch, &mut runs.post_exit] {
                    if run.status == CommandStatus::Pending {
                        run.status = CommandStatus::Skipped;
                    }
                }
            }
            match result {
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
            }
            if let Some(runs) = &s.command_runs {
                if let Some(exit) = &s.game_exit {
                    if exit.reason != "normal" {
                        if let Some(step) = s.steps.iter_mut().find(|step| step.name == "游戏运行")
                        {
                            step.status = if exit.reason == "cancelled" {
                                Status::Cancelled
                            } else {
                                Status::Failed
                            };
                            step.detail = s.error.clone().unwrap_or_default();
                        }
                    }
                }
                for (name, run) in [
                    ("启动前命令", &runs.pre_launch),
                    ("退出后命令", &runs.post_exit),
                ] {
                    if let Some(step) = s.steps.iter_mut().find(|step| step.name == name) {
                        if matches!(
                            run.status,
                            CommandStatus::Completed | CommandStatus::Skipped
                        ) {
                            step.status = Status::Completed;
                            step.detail = if run.status == CommandStatus::Skipped {
                                "已跳过"
                            } else {
                                "命令执行完成"
                            }
                            .into();
                        }
                        if matches!(run.status, CommandStatus::Failed | CommandStatus::Cancelled) {
                            step.status = if run.status == CommandStatus::Cancelled {
                                Status::Cancelled
                            } else {
                                Status::Failed
                            };
                            step.detail = run.error.clone().unwrap_or_default();
                        }
                    }
                }
            }
        });
    }
}
#[derive(Default)]
pub struct Jobs {
    jobs: Mutex<Vec<Arc<Job>>>,
}
impl Jobs {
    pub fn get(&self, id: &str) -> anyhow::Result<Arc<Job>> {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|job| job.snapshot().id == id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("任务不存在"))
    }
    pub(crate) fn restore_launch(&self, snapshot: JobSnapshot) -> Arc<Job> {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(job) = jobs.iter().find(|job| job.snapshot().id == snapshot.id) {
            return job.clone();
        }
        let job = Arc::new(Job {
            kind: JobKind::Launch,
            cancel: CancellationToken::new(),
            command_cancel: CancellationToken::new(),
            snapshot: Mutex::new(snapshot),
        });
        jobs.push(job.clone());
        job
    }
    pub fn create(&self, kind: JobKind, title: String, steps: &[&str]) -> Arc<Job> {
        let job = Arc::new(Job {
            kind,
            cancel: CancellationToken::new(),
            command_cancel: CancellationToken::new(),
            snapshot: Mutex::new(JobSnapshot {
                id: uuid::Uuid::new_v4().to_string(),
                title,
                status: Status::Running,
                current_step: 0,
                download_id: None,
                error: None,
                log: vec![],
                created_at: now(),
                mod_update_path: None,
                datapack_world: None,
                launch: None,
                crash_report: None,
                command_runs: None,
                game_exit: None,
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
    pub fn running_launches(&self) -> Vec<JobSnapshot> {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .rev()
            .filter(|job| matches!(job.kind, JobKind::Launch) && !job.cancel.is_cancelled())
            .map(|job| job.snapshot())
            .filter(|snapshot| {
                snapshot.status == Status::Running
                    && snapshot
                        .launch
                        .as_ref()
                        .is_some_and(|launch| launch.running)
            })
            .collect()
    }
    pub fn cancel(&self, id: &str) -> anyhow::Result<()> {
        let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        let job = jobs
            .iter()
            .find(|j| j.snapshot().id == id)
            .ok_or_else(|| anyhow::anyhow!("任务不存在"))?;
        job.cancel_requested();
        Ok(())
    }
    pub fn cancel_all(&self) {
        for job in self.jobs.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            job.cancel.cancel();
            job.command_cancel.cancel();
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
        if matches!(job.kind, JobKind::Modpack | JobKind::ModpackUpdate) {
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
