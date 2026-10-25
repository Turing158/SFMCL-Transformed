use super::{
    arguments::{build, Identity},
    installer::Installer,
    java,
    process::run_java_with_title,
    version_settings, versions,
};
use crate::{
    jobs::{self, Job, JobKind},
    paths::safe_join,
};
use anyhow::{bail, Context, Result};
use std::sync::Arc;

pub struct LaunchIdentity {
    pub name: String,
    pub uuid: String,
    pub access_token: String,
    pub online: bool,
}

impl Installer {
    pub async fn launch(self: &Arc<Self>, id: String, player: LaunchIdentity) -> Result<String> {
        if player.name.is_empty() || player.uuid.is_empty() {
            bail!("请先选择角色");
        }
        if player.online && player.access_token.is_empty() {
            bail!("微软登录已失效，请刷新登录");
        }
        let settings = self.settings.get();
        let root = settings.active_game_root()?;
        let settings = version_settings::resolve(&root, &id, &settings)?;
        let lock_path = safe_join(&root, format!(".tmcl/locks/launch-{id}.lock"))?;
        std::fs::create_dir_all(lock_path.parent().unwrap())?;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        lock.try_lock().context("此版本已在启动或运行中")?;
        let job = self.jobs.create(
            JobKind::Launch,
            format!("启动 {id}"),
            &[
                "检查游戏与 Java",
                "检查资源索引",
                "补全游戏文件",
                "准备运行环境",
                "游戏运行",
            ],
        );
        let job_id = job.snapshot().id;
        let installer = self.clone();
        tokio::spawn(async move {
            let _lock = lock;
            let result = installer
                .launch_inner(&root, &id, player, settings, job.clone())
                .await;
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
    ) -> Result<()> {
        job.step(0, "解析版本与兼容 Java");
        let version = versions::resolve(root, id)?;
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
        versions::extract_natives(root, id, &versions::libraries(&version)?)?;
        self.materialize_assets(root, &version, &settings)?;
        let identity = Identity {
            name: &player.name,
            uuid: &player.uuid,
            access_token: &player.access_token,
            online: player.online,
        };
        let args = build(root, id, &version, &settings, &identity, memory)?;
        let directory = versions::game_directory(root, id, settings.isolation)?;
        std::fs::create_dir_all(&directory)?;
        if job.cancel.is_cancelled() {
            bail!(job.cancellation_message());
        }
        job.step(4, "Minecraft 正在运行，可在此查看日志或结束游戏");
        run_java_with_title(
            &java.path,
            &args,
            &directory,
            job,
            &[player.access_token],
            &settings.window_title,
        )
        .await?;
        Ok(())
    }
}
