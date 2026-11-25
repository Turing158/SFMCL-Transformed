use super::{
    arguments::{build, Identity},
    installer::Installer,
    java,
    process::LaunchEvents,
    version_settings, versions,
};
use crate::{
    jobs::{self, Job, JobKind, LaunchContext},
    paths::safe_join,
};
use anyhow::{bail, Context, Result};
use std::sync::Arc;

pub struct LaunchIdentity {
    pub name: String,
    pub uuid: String,
    pub access_token: String,
    pub online: bool,
    pub auth_server: Option<String>,
}

struct LaunchOptions {
    events: Option<LaunchEvents>,
    target: Option<crate::multiplayer::LaunchTarget>,
}

impl Installer {
    pub async fn launch(self: &Arc<Self>, id: String, player: LaunchIdentity) -> Result<String> {
        self.launch_with_events(id, player, None).await
    }
    pub async fn launch_with_events(
        self: &Arc<Self>,
        id: String,
        player: LaunchIdentity,
        events: Option<LaunchEvents>,
    ) -> Result<String> {
        self.launch_with_target(id, player, events, None).await
    }
    pub async fn launch_with_target(
        self: &Arc<Self>,
        id: String,
        player: LaunchIdentity,
        events: Option<LaunchEvents>,
        target: Option<crate::multiplayer::LaunchTarget>,
    ) -> Result<String> {
        if player.name.is_empty() || player.uuid.is_empty() {
            bail!("请先选择角色");
        }
        if player.online && player.access_token.is_empty() {
            bail!("账号登录已失效，请刷新登录");
        }
        let settings = self.settings.get();
        let root = settings.active_game_root()?;
        let mut settings = version_settings::resolve(&root, &id, &settings)?;
        if let Some(target) = &target {
            target.apply(&mut settings)?;
        }
        let game = versions::game_directory(&root, &id, settings.isolation)?;
        crate::resources::modpacks::update::ensure_ready(&root, &id)?;
        let _install_guard = crate::resources::install::launch_guard(&game)?;
        let lock_path = safe_join(&root, format!(".tmcl/locks/launch-{id}.lock"))?;
        std::fs::create_dir_all(lock_path.parent().unwrap())?;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        // Each launch retains a shared guard until its process exits. Other
        // launches can coexist; version deletion still needs an exclusive lock.
        lock.try_lock_shared()
            .context("此版本正在被独占操作，请稍后启动")?;
        let job = self.jobs.create(
            JobKind::Launch,
            format!("启动 {id}"),
            &[
                "检查游戏与 Java",
                "检查资源索引",
                "补全游戏文件",
                "准备运行环境",
                "启动前命令",
                "游戏运行",
                "退出后命令",
            ],
        );
        let job_id = job.snapshot().id;
        job.initialize_commands(
            settings.pre_launch_command.enabled,
            settings.post_exit_command.enabled,
        );
        job.set_launch_context(LaunchContext {
            version_id: id.clone(),
            game_version: id.clone(),
            directory: settings.active_dir.clone(),
            player_name: player.name.clone(),
            offline_lan: settings.offline_lan,
            running: false,
        });
        let installer = self.clone();
        tokio::spawn(async move {
            let _lock = lock;
            let secrets = vec![player.access_token.clone()];
            let result = installer
                .launch_inner(
                    &root,
                    &id,
                    player,
                    settings,
                    job.clone(),
                    LaunchOptions { events, target },
                )
                .await;
            if let Err(error) = &result {
                if error
                    .downcast_ref::<super::commands::CommandFailure>()
                    .is_none()
                {
                    super::crash::startup_failure(
                        installer.settings.directory(),
                        &job,
                        &format!("{error:#}"),
                        &secrets,
                    );
                }
            }
            job.finish(&result);
        });
        Ok(job_id)
    }
    async fn launch_inner(
        &self,
        root: &std::path::Path,
        id: &str,
        player: LaunchIdentity,
        settings: crate::config::Settings,
        job: Arc<Job>,
        options: LaunchOptions,
    ) -> Result<()> {
        job.step(0, "解析版本与兼容 Java");
        let version = versions::resolve(root, id)?;
        if settings.offline_lan {
            super::offline_lan::validate_version(&version)?;
        }
        job.set_launch_context(LaunchContext {
            version_id: id.into(),
            game_version: version["inheritsFrom"]
                .as_str()
                .or(version["clientVersion"].as_str())
                .or(version["id"].as_str())
                .unwrap_or(id)
                .into(),
            directory: settings.active_dir.clone(),
            player_name: player.name.clone(),
            offline_lan: settings.offline_lan,
            running: false,
        });
        // Reject an unsupported or missing direct-entry target before downloads begin.
        super::quick_play::arguments(
            &version,
            &settings,
            &versions::game_directory(root, id, settings.isolation)?,
        )?;
        let java = java::select(
            &settings.java_path,
            &settings.java_paths,
            versions::required_java(&version),
        )
        .await?;
        let memory = java::memory_mb(settings.auto_memory, settings.memory_mb);
        if java.architecture == "x86" && memory > 1536 {
            bail!("32 位 Java 不支持所选内存，请选择 64 位 Java");
        }
        job.log(format!(
            "Java {} · {} · 最大内存 {memory} MB",
            java.version, java.architecture
        ));
        job.step(1, "读取资产索引");
        let files = self.resolve_files(root, &version, &job).await?;
        job.step(2, "校验并补全缺失或损坏的文件");
        jobs::download_session(
            &self.downloads,
            &job,
            format!("{id} · 启动检查"),
            root.into(),
            files,
        )
        .await?;
        job.step(3, "提取 native 并生成启动参数");
        let injector = if let Some(server) = &player.auth_server {
            job.log("准备第三方验证组件 authlib-injector".into());
            Some(super::authlib_injector::prepare(root, server, &self.client, &job.cancel).await?)
        } else {
            None
        };
        versions::extract_natives(root, id, &versions::libraries(&version)?)?;
        self.materialize_assets(root, &version, &settings)?;
        let identity = Identity {
            name: &player.name,
            uuid: &player.uuid,
            access_token: &player.access_token,
            online: player.online,
            yggdrasil: player.auth_server.is_some(),
        };
        let mut args = build(root, id, &version, &settings, &identity, memory)?;
        if settings.offline_lan {
            let argument =
                super::offline_lan::prepare(self, root, &version, &java.path, &job).await?;
            args.insert(0, argument);
        }
        if let Some(argument) = injector {
            // JVM agents must precede the main class; each argument is passed
            // directly to Command (never through a shell).
            args.insert(0, argument);
        }
        let directory = versions::game_directory(root, id, settings.isolation)?;
        std::fs::create_dir_all(&directory)?;
        if job.cancel.is_cancelled() {
            bail!(job.cancellation_message());
        }
        if let Some(target) = &options.target {
            target.validate().await?;
        }
        job.step(4, "执行启动前命令");
        super::commands::execute(
            &settings.pre_launch_command,
            super::commands::CommandPhase::PreLaunch,
            &directory,
            &java.path,
            job.clone(),
            &[player.access_token.clone()],
            &job.cancel,
        )
        .await?;
        if job.cancel.is_cancelled() {
            bail!(job.cancellation_message());
        }
        if let Some(target) = &options.target {
            target.validate().await?;
        }
        job.step(5, "Minecraft 正在运行，可在此查看日志或结束游戏");
        #[cfg(windows)]
        super::detached::run_game(
            self.settings.directory(),
            &java.path,
            &args,
            &directory,
            job,
            &[player.access_token],
            &settings,
            options.events,
        )
        .await?;
        #[cfg(not(windows))]
        super::process::run_java_diagnosed(
            &java.path,
            &args,
            &directory,
            job,
            &[player.access_token],
            &settings,
            options.events,
            Some(self.settings.directory()),
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::{ConfigStore, GameDirectory},
        downloads::{DownloadManager, Status},
        jobs::Jobs,
    };
    use std::{fs::OpenOptions, time::Duration};

    #[tokio::test]
    async fn same_version_launches_have_independent_jobs_and_share_deletion_guard() {
        let temp = tempfile::tempdir().unwrap();
        let settings = Arc::new(ConfigStore::open(&temp.path().join("config")).unwrap());
        let game = temp.path().join("game");
        settings
            .update(|settings| {
                settings.active_dir = game.to_string_lossy().into_owned();
                settings.game_dirs = vec![GameDirectory {
                    name: "test".into(),
                    path: settings.active_dir.clone(),
                }];
            })
            .unwrap();
        let root = settings.get().active_game_root().unwrap();
        let version = root.join("versions/test");
        std::fs::create_dir_all(&version).unwrap();
        std::fs::write(version.join("test.json"), b"invalid version JSON").unwrap();
        let installer = Arc::new(Installer {
            settings,
            downloads: DownloadManager::open(&temp.path().join("downloads"), 2).unwrap(),
            jobs: Arc::new(Jobs::default()),
            client: reqwest::Client::new(),
        });
        let player = || LaunchIdentity {
            name: "Alex".into(),
            uuid: "test-player".into(),
            access_token: String::new(),
            online: false,
            auth_server: None,
        };
        // This single-thread runtime hasn't polled either workflow yet, so
        // both jobs retain their guards while we try the deletion lock.
        let first = installer.launch("test".into(), player()).await.unwrap();
        let second = installer.launch("test".into(), player()).await.unwrap();
        assert_ne!(first, second);
        assert_eq!(installer.jobs.snapshots().len(), 2);
        let deletion = OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join(".tmcl/locks/launch-test.lock"))
            .unwrap();
        assert!(deletion.try_lock().is_err());
        installer.jobs.cancel(&first).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if installer
                    .jobs
                    .snapshots()
                    .iter()
                    .all(|job| job.status.terminal())
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // The corrupt test version fails preflight and releases both guards.
        let completed = installer.jobs.snapshots();
        assert_eq!(
            completed.iter().find(|job| job.id == first).unwrap().status,
            Status::Cancelled
        );
        assert_eq!(
            completed
                .iter()
                .find(|job| job.id == second)
                .unwrap()
                .status,
            Status::Failed
        );
        deletion.try_lock().unwrap();
        assert!(installer.launch("test".into(), player()).await.is_err());
        assert_eq!(installer.jobs.snapshots().len(), 2);
    }
}
