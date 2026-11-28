use super::*;
use terracotta::component;

impl Multiplayer {
    pub fn prepare_terracotta(self: &Arc<Self>, archive: Option<PathBuf>) -> Result<Snapshot> {
        self.begin_terracotta(None, String::new(), archive)
    }
    pub fn terracotta_room(
        self: &Arc<Self>,
        request: terracotta::Request,
        host: bool,
        player: Option<String>,
        version: String,
    ) -> Result<Snapshot> {
        self.begin_terracotta(Some(request.room(host, player)?), version, None)
    }
    fn begin_terracotta(
        self: &Arc<Self>,
        room: Option<terracotta::Room>,
        version: String,
        archive: Option<PathBuf>,
    ) -> Result<Snapshot> {
        let mut state = self.lock();
        ensure!(
            !state.maintenance && state.active.is_none(),
            "请先结束当前会话或本地数据操作"
        );
        let release = component::release()?;
        let directory_lock = component::lock(&self.directory)?;
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        let done = CancellationToken::new();
        let host = room.as_ref().is_some_and(|r| r.host);
        state.snapshot = Snapshot {
            state: if room.is_some() && state.snapshot.terracotta_ready {
                "connecting"
            } else {
                "preparing"
            }
            .into(),
            session_id: Some(id.clone()),
            service: Some("terracotta"),
            role: room
                .as_ref()
                .map(|_| if host { "host" } else { "guest" }.into()),
            name: "陶瓦联机房间".into(),
            game_version: version,
            ..state.snapshot.cleared()
        };
        state.active = Some(Active {
            id: id.clone(),
            cancel: cancel.clone(),
            done: done.clone(),
            invite: None,
            target: None,
            host,
        });
        let snapshot = state.snapshot.clone();
        let manager = self.clone();
        tokio::spawn(async move {
            let prepared = manager
                .terracotta_executable(release, archive, &cancel)
                .await;
            let ready = prepared.is_ok() || release.installed(&manager.directory);
            manager.update(&id, |s| {
                s.terracotta_ready = ready;
                s.component_job_id = None;
            });
            let result = match (prepared, room) {
                _ if cancel.is_cancelled() => Ok(()),
                (Err(e), _) => Err(e),
                (Ok(_), None) => Ok(()),
                (Ok(exe), Some(room)) => {
                    manager.update(&id, |s| {
                        if !cancel.is_cancelled() {
                            s.state = "connecting".into();
                        }
                    });
                    terracotta::run(
                        &manager.directory,
                        &exe,
                        room,
                        &cancel,
                        |v| {
                            let mut state = manager.lock();
                            if let Some(active) = state
                                .active
                                .as_mut()
                                .filter(|a| a.id == id && !a.cancel.is_cancelled())
                            {
                                active.target = v.address;
                                let s = &mut state.snapshot;
                                s.state = if v.ready {
                                    "ready"
                                } else if v.phase == "host-scanning" {
                                    "waiting"
                                } else {
                                    "connecting"
                                }
                                .into();
                                s.terracotta_phase = Some(v.phase);
                                s.world_open = v.ready;
                                s.address = v.address.map(|a| a.to_string());
                                s.invite_code = v.code;
                                s.members = v.members;
                            }
                        },
                        || {
                            cancel.cancel();
                            manager.update(&id, |s| {
                                s.state = "leaving".into();
                                s.world_open = false;
                                s.address = None;
                                s.invite_code = None;
                                s.members.clear();
                            });
                        },
                    )
                    .await
                }
            };
            cancel.cancel();
            drop(directory_lock);
            manager.finish(&id, result);
            done.cancel();
        });
        Ok(snapshot)
    }

    async fn terracotta_executable(
        &self,
        release: &'static component::Release,
        archive: Option<PathBuf>,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        if archive.is_none() {
            let directory = self.directory.clone();
            let installed =
                tokio::task::spawn_blocking(move || release.verified_executable(&directory))
                    .await?;
            if let Some(exe) = installed {
                return Ok(exe);
            }
        }
        let job = {
            let mut state = self.lock();
            ensure!(!cancel.is_cancelled(), "组件准备已取消");
            let job = self.jobs.create(
                JobKind::Other,
                format!("准备联机组件 · Terracotta {}", component::VERSION),
                &["检查陶瓦", "获取陶瓦", "校验并安装陶瓦"],
            );
            state.snapshot.state = "preparing".into();
            state.snapshot.component_job_id = Some(job.snapshot().id);
            if archive.is_none() {
                state.snapshot.terracotta_ready = false;
            }
            job
        };
        let prepared = release
            .acquire(&self.directory, archive, &self.downloads, &job, cancel)
            .await;
        let prepared = components::check_cancel(&job, cancel).and(prepared);
        if job.cancel.is_cancelled() {
            cancel.cancel();
        }
        job.finish(
            &prepared
                .as_ref()
                .map(|_| ())
                .map_err(|e| anyhow::anyhow!("{e}")),
        );
        prepared
    }
}
