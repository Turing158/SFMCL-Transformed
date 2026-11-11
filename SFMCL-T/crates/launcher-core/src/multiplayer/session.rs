use super::{
    components,
    engine::{self, Engine, Member},
    invitation::{self, Invitation},
    minecraft, tunnel,
};
use crate::{
    downloads::DownloadManager,
    jobs::{JobKind, Jobs},
};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub state: String,
    pub session_id: Option<String>,
    pub component_ready: bool,
    pub component_version: &'static str,
    pub component_job_id: Option<String>,
    pub role: Option<String>,
    pub name: String,
    pub game_version: String,
    pub address: Option<String>,
    pub world_open: bool,
    pub members: Vec<Member>,
    pub error: Option<String>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            session_id: None,
            component_ready: false,
            component_version: components::VERSION,
            component_job_id: None,
            role: None,
            name: String::new(),
            game_version: String::new(),
            address: None,
            world_open: false,
            members: vec![],
            error: None,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRequest {
    pub name: String,
    pub port: u16,
    // Accepted for older integrations; the UI creates a local tunnel by default.
    #[serde(default)]
    pub server: String,
    #[serde(default)]
    pub launch_id: Option<String>,
}

struct Active {
    id: String,
    cancel: CancellationToken,
    done: CancellationToken,
    invite: Option<Invitation>,
    target: Option<SocketAddr>,
    host: bool,
}
struct State {
    snapshot: Snapshot,
    active: Option<Active>,
    maintenance: bool,
}
struct PreparedComponents {
    easytier: components::Binaries,
    cloudflared: Option<PathBuf>,
}
pub struct Multiplayer {
    directory: PathBuf,
    downloads: Arc<DownloadManager>,
    jobs: Arc<Jobs>,
    state: Mutex<State>,
}

/// A session-derived one-shot launch target. It is never persisted in settings.
#[derive(Clone)]
pub struct LaunchTarget {
    pub address: SocketAddr,
    pub cancel: CancellationToken,
}
impl LaunchTarget {
    pub fn apply(&self, settings: &mut crate::config::Settings) -> Result<()> {
        ensure!(
            !self.cancel.is_cancelled() && self.address.ip().is_loopback(),
            "联机会话已失效"
        );
        settings.server_enabled = true;
        settings.server_host = self.address.ip().to_string();
        settings.server_port = self.address.port();
        settings.quick_play_enabled = false;
        Ok(())
    }
    pub async fn validate(&self) -> Result<()> {
        ensure!(!self.cancel.is_cancelled(), "联机会话已结束，请重新加入");
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => anyhow::bail!("联机会话已结束，请重新加入"),
            result = minecraft::ping(self.address) => { result.context("房主世界暂不可用")?; }
        }
        Ok(())
    }
}

impl Multiplayer {
    pub fn new(directory: PathBuf, downloads: Arc<DownloadManager>, jobs: Arc<Jobs>) -> Arc<Self> {
        Arc::new(Self {
            directory,
            downloads,
            jobs,
            state: Mutex::new(State {
                snapshot: Snapshot::default(),
                active: None,
                maintenance: false,
            }),
        })
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|err| err.into_inner())
    }
    pub fn snapshot(&self) -> Snapshot {
        self.lock().snapshot.clone()
    }
    pub fn active(&self) -> bool {
        self.lock().active.is_some()
    }
    pub fn begin_maintenance(&self) -> Result<()> {
        let mut state = self.lock();
        ensure!(state.active.is_none(), "请先结束联机，再操作本地数据");
        state.maintenance = true;
        Ok(())
    }
    pub fn end_maintenance(&self) {
        self.lock().maintenance = false;
    }
    fn update(&self, id: &str, update: impl FnOnce(&mut Snapshot)) {
        let mut state = self.lock();
        if state.active.as_ref().is_some_and(|active| active.id == id) {
            update(&mut state.snapshot);
        }
    }
    fn begin(
        self: &Arc<Self>,
        invite: Option<Invitation>,
        host: bool,
        name: String,
        archive: Option<PathBuf>,
    ) -> Result<Snapshot> {
        let mut state = self.lock();
        ensure!(!state.maintenance, "本地数据操作进行中");
        ensure!(state.active.is_none(), "请先离开当前房间或取消组件准备");
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        let done = CancellationToken::new();
        let previous_ready = state.snapshot.component_ready;
        let job = self.jobs.create(
            JobKind::Other,
            if host && invite.as_ref().is_some_and(Invitation::uses_tunnel) {
                format!(
                    "准备联机组件 · EasyTier {} / Cloudflare Tunnel",
                    components::VERSION
                )
            } else {
                format!("准备联机组件 · EasyTier {}", components::VERSION)
            },
            &["检查组件", "获取组件", "校验并安装"],
        );
        state.snapshot = Snapshot {
            state: "preparing".into(),
            session_id: Some(id.clone()),
            component_ready: previous_ready,
            component_job_id: Some(job.snapshot().id),
            role: invite
                .as_ref()
                .map(|_| if host { "host" } else { "guest" }.into()),
            name: invite
                .as_ref()
                .map(|value| value.name.clone())
                .unwrap_or_default(),
            game_version: invite
                .as_ref()
                .map(|value| value.game_version.clone())
                .unwrap_or_default(),
            ..Default::default()
        };
        state.active = Some(Active {
            id: id.clone(),
            cancel: cancel.clone(),
            done: done.clone(),
            invite: invite.clone(),
            target: None,
            host,
        });
        let snapshot = state.snapshot.clone();
        let manager = self.clone();
        tokio::spawn(async move {
            // Preparation handles cancellation itself so download workers stop
            // before its owned temporary directory is released.
            let mut prepared = async {
                let files = components::prepare(
                    &manager.directory,
                    archive,
                    &manager.downloads,
                    &job,
                    &cancel,
                )
                .await?;
                manager.update(&id, |snapshot| snapshot.component_ready = true);
                let cloudflared = if host && invite.as_ref().is_some_and(Invitation::uses_tunnel) {
                    Some(
                        tunnel::prepare(&manager.directory, &manager.downloads, &job, &cancel)
                            .await?,
                    )
                } else {
                    None
                };
                Ok::<_, anyhow::Error>(PreparedComponents {
                    easytier: files,
                    cloudflared,
                })
            }
            .await;
            if cancel.is_cancelled() || job.cancel.is_cancelled() {
                job.cancel.cancel();
                prepared = Err(anyhow::anyhow!("组件准备已取消"));
            }
            job.finish(
                &prepared
                    .as_ref()
                    .map(|_| ())
                    .map_err(|error| anyhow::anyhow!("{error:#}")),
            );
            let outcome = match prepared {
                Ok(files) => {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => Ok(()),
                        result = manager.run(&id,invite,host,name,files,&cancel) => result,
                    }
                }
                Err(_) if job.cancel.is_cancelled() => Ok(()),
                Err(error) => Err(error),
            };
            cancel.cancel();
            let mut state = manager.lock();
            if state.active.as_ref().is_some_and(|active| active.id == id) {
                state.active = None;
                let ready = state.snapshot.component_ready;
                state.snapshot = Snapshot {
                    component_ready: ready,
                    ..Default::default()
                };
                if let Err(error) = outcome {
                    state.snapshot.state = "failed".into();
                    state.snapshot.error = Some(error.to_string());
                }
            }
            done.cancel();
        });
        Ok(snapshot)
    }
    pub fn prepare(self: &Arc<Self>, archive: Option<PathBuf>) -> Result<Snapshot> {
        self.begin(None, false, String::new(), archive)
    }
    pub fn create(
        self: &Arc<Self>,
        request: CreateRequest,
        game_version: String,
        player: String,
    ) -> Result<Snapshot> {
        ensure!(invitation::text_field(&player, 48), "请先选择角色");
        let invite = if request.server.trim().is_empty() {
            Invitation::for_tunnel(request.name, request.port, game_version)?
        } else {
            Invitation::new(request.name, request.port, request.server, game_version)?
        };
        self.begin(Some(invite), true, player, None)
    }
    pub fn join(self: &Arc<Self>, value: &str, player: String) -> Result<Snapshot> {
        ensure!(invitation::text_field(&player, 48), "请先选择角色");
        self.begin(Some(Invitation::decode(value)?), false, player, None)
    }
    pub fn invitation(&self, id: &str) -> Result<String> {
        let state = self.lock();
        ensure!(
            state.snapshot.state == "ready" && state.snapshot.world_open,
            "世界尚未开放或房间未连接"
        );
        let active = state
            .active
            .as_ref()
            .filter(|active| active.id == id && active.host)
            .context("当前房间已失效")?;
        active.invite.as_ref().context("房间未创建")?.encode()
    }
    pub fn launch_target(&self, id: &str) -> Result<LaunchTarget> {
        let state = self.lock();
        ensure!(
            state.snapshot.state == "ready" && state.snapshot.world_open,
            "房主世界暂不可用"
        );
        let active = state
            .active
            .as_ref()
            .filter(|active| active.id == id && !active.host && !active.cancel.is_cancelled())
            .context("当前联机会话已失效")?;
        Ok(LaunchTarget {
            address: active.target.context("连接地址尚未就绪")?,
            cancel: active.cancel.clone(),
        })
    }
    pub async fn leave(&self, id: Option<&str>) -> Result<()> {
        let done = {
            let mut state = self.lock();
            let Some(active) = state.active.as_ref() else {
                return Ok(());
            };
            if id.is_some_and(|id| id != active.id) {
                return Ok(());
            }
            active.cancel.cancel();
            let done = active.done.clone();
            state.snapshot.state = "leaving".into();
            state.snapshot.world_open = false;
            done
        };
        tokio::time::timeout(Duration::from_secs(30), done.cancelled())
            .await
            .context("联机仍在退出，请稍后重试")?;
        Ok(())
    }
    pub async fn shutdown(&self) -> Result<()> {
        // Prevent a new room from starting while the app awaits download pauses.
        self.lock().maintenance = true;
        let result = self.leave(None).await;
        if result.is_err() {
            self.end_maintenance();
        }
        result
    }
    async fn run(
        &self,
        id: &str,
        invite: Option<Invitation>,
        host: bool,
        name: String,
        components: PreparedComponents,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let Some(mut invite) = invite else {
            return Ok(());
        };
        let target = SocketAddr::from((
            Ipv4Addr::LOCALHOST,
            if host {
                invite.port
            } else {
                engine::free_port()?
            },
        ));
        if host {
            minecraft::ping(target)
                .await
                .context("未检测到 Minecraft 世界，请先对局域网开放")?;
        }
        let listener = if host && invite.uses_tunnel() {
            Some(engine::free_port()?)
        } else {
            None
        };
        let config = if let Some(listener) = listener {
            engine::host_tunnel_config(&invite, &name, listener)?
        } else {
            engine::config(&invite, host, &name, target.port())?
        };
        let engine = Engine::start(components.easytier, &config)?;
        self.update(id, |snapshot| {
            snapshot.state = "connecting".into();
        });
        let tunnel = if let Some(listener) = listener {
            let tunnel = tunnel::Tunnel::start(
                &components.cloudflared.context("隧道组件尚未准备")?,
                &self.directory,
                listener,
                cancel,
            )
            .await?;
            invite.publish(tunnel.endpoint.clone())?;
            let mut state = self.lock();
            if let Some(active) = state.active.as_mut().filter(|active| active.id == id) {
                active.invite = Some(invite.clone());
            }
            Some(tunnel)
        } else {
            None
        };
        let started = Instant::now();
        let mut was_ready = false;
        let mut misses = 0u8;
        let result = async {
            loop {
                ensure!(engine.running(), "联机组件意外退出，请重新创建或加入房间");
                if let Some(tunnel) = &tunnel { ensure!(tunnel.running(), "联机入口已退出，请重新创建房间"); }
                let tunnel_connected = if let Some(tunnel) = &tunnel { tunnel.healthy().await } else { false };
                let peers = engine.members(&invite).await;
                let world = minecraft::ping(target).await.is_ok();
                if let Ok((members, connected)) = peers {
                    let connected = if host { if tunnel.is_some() { tunnel_connected } else { connected } } else { members.iter().any(|member| member.ip == invite.host_ip() && !member.local) };
                    let ready = connected && world;
                    if ready { misses = 0; was_ready = true; } else { misses = misses.saturating_add(1); }
                    let mut state = self.lock();
                    if let Some(active) = state.active.as_mut().filter(|active| active.id == id) { active.target = Some(target); }
                    state.snapshot.members = members;
                    state.snapshot.world_open = ready || (was_ready && misses < 2);
                    state.snapshot.state = if state.snapshot.world_open { "ready" } else if was_ready { "waiting" } else { "connecting" }.into();
                    state.snapshot.address = Some(target.to_string());
                    state.snapshot.error = if !connected && was_ready {Some("网络已断开，正在重连".into())} else if !world && was_ready {Some("世界已关闭，等待房主重新开放".into())} else {None};
                } else {
                    misses = misses.saturating_add(1);
                    if misses >= 2 { self.update(id,|snapshot| { snapshot.state = "connecting".into(); snapshot.world_open = false; snapshot.error = Some("正在重新读取网络状态".into()); }); }
                }
                ensure!(was_ready || started.elapsed() < Duration::from_secs(45), "连接超时，请检查网络、房主世界及邀请码");
                tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(2)) => {} }
            }
            Ok(())
        }.await;
        let tunnel_stopped = tunnel
            .as_ref()
            .map(|tunnel| tunnel.stop())
            .unwrap_or(Ok(()));
        let engine_stopped = engine.stop();
        result.and(tunnel_stopped).and(engine_stopped)
    }
}
