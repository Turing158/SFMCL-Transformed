mod resolver;
#[cfg(test)]
mod tests;
mod transaction;

use crate::{
    downloads::{DownloadManager, DownloadSpec, Status},
    jobs::{self, JobKind, Jobs},
    paths::safe_join,
    resources::{
        community::{Community, ResourceKind},
        local,
        modpacks::UrlResolver,
    },
};
use anyhow::{bail, Context, Result};
use futures_util::future::BoxFuture;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub root: PathBuf,
    pub version_id: String,
    pub game: PathBuf,
    pub game_version: String,
    pub loader: String,
    // Resolved version JSON and settings bind a preview to the environment it inspected.
    pub environment: String,
}

impl Target {
    pub fn resolve(root: PathBuf, id: &str, settings: &crate::config::Settings) -> Result<Self> {
        let profile = crate::minecraft::versions::resolve(&root, id)?;
        let resolved = crate::minecraft::version_settings::resolve(&root, id, settings)?;
        let game = local::version_root(&root, id, resolved.isolation)?;
        let game_version = profile["inheritsFrom"]
            .as_str()
            .or(profile["clientVersion"].as_str())
            .or(profile["id"].as_str())
            .context("无法确定 Minecraft 版本")?
            .to_owned();
        let loader = crate::minecraft::versions::loader(&profile).to_owned();
        let environment = serde_json::to_string(&serde_json::json!([profile, resolved.isolation]))?;
        Ok(Self {
            root,
            version_id: id.into(),
            game,
            game_version,
            loader,
            environment,
        })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Dependency {
    pub project: Option<String>,
    pub version: Option<String>,
    pub filename: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct Candidate {
    pub id: String,
    pub project: String,
    pub name: String,
    pub version: String,
    pub date: String,
    pub stable: bool,
    pub client_supported: bool,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub file: DownloadSpec,
    pub required: Vec<Dependency>,
    pub incompatible: Vec<Dependency>,
}

#[derive(Clone)]
pub(crate) struct ProjectMeta {
    pub name: String,
    pub kind: ResourceKind,
}

pub(crate) trait Catalog: Sync {
    fn project<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<ProjectMeta>>;
    fn version<'a>(
        &'a self,
        project: Option<&'a str>,
        id: &'a str,
    ) -> BoxFuture<'a, Result<Candidate>>;
    fn versions<'a>(&'a self, project: &'a str) -> BoxFuture<'a, Result<Vec<Candidate>>>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LocalFile {
    pub path: String,
    pub sha1: String,
    pub fingerprint: u32,
    pub disabled: bool,
    pub mod_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Inventory {
    pub files: Vec<LocalFile>,
}

impl Inventory {
    pub fn read(game: &Path) -> Result<Self> {
        let mut files = vec![];
        for kind in ["mod", "resourcepack", "shader"] {
            for resource in local::scan(game, kind)? {
                if resource.entry_type != local::LocalResourceEntryType::File {
                    continue;
                }
                let path = Path::new(&resource.path);
                let relative = path
                    .strip_prefix(game)?
                    .to_string_lossy()
                    .replace('\\', "/");
                let path = safe_join(game, &relative)?;
                let (sha1, fingerprint) = super::community::install_metadata::identity(&path)
                    .with_context(|| format!("无法检查本地文件 {relative}"))?;
                let mod_ids = resource.details["modIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|id| id.as_str().map(str::to_owned))
                    .collect();
                files.push(LocalFile {
                    path: relative,
                    sha1,
                    fingerprint,
                    disabled: resource.disabled,
                    mod_ids,
                });
                if files.len() > 2048 {
                    bail!("本地资源文件过多，请先整理后再安装");
                }
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(Self { files })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub project_id: String,
    pub version_id: String,
    pub name: String,
    pub version: String,
    pub kind: ResourceKind,
    pub status: String,
    pub path: String,
    pub main: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub token: Option<String>,
    pub items: Vec<PlanItem>,
    pub issues: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct Selection {
    pub candidate: Candidate,
    pub item: PlanItem,
    pub existing: Option<LocalFile>,
}

struct Prepared {
    target: Target,
    inventory: Inventory,
    selections: Vec<Selection>,
    created: Instant,
}

#[derive(Default)]
pub struct ModInstaller {
    prepared: Mutex<HashMap<String, Prepared>>,
}

/// Serialize launch admission with installation admission for the actual game directory.
pub fn launch_guard(game: &Path) -> Result<std::fs::File> {
    transaction::lock(game).context("模组及前置正在安装，请等待安装结束后启动游戏")
}

fn launch_uses_game(snapshot: &crate::jobs::JobSnapshot, game: &Path) -> bool {
    let Some(launch) = &snapshot.launch else {
        return false;
    };
    let active = launch.running
        || matches!(
            snapshot.status,
            Status::Running | Status::Queued | Status::Paused | Status::Pausing
        )
        || (snapshot.status == Status::Failed
            && snapshot.error.is_none()
            && snapshot.download_id.is_some());
    let root = crate::paths::minecraft_root(Path::new(&launch.directory));
    active && (game == root || game == root.join("versions").join(&launch.version_id))
}

impl ModInstaller {
    pub async fn preview(
        &self,
        community: &Community,
        source: &str,
        project: &str,
        version: &str,
        target: Target,
    ) -> Result<InstallPlan> {
        let game = target.game.clone();
        let inventory = tokio::task::spawn_blocking(move || Inventory::read(&game)).await??;
        let catalog = community.install_catalog(source, &target)?;
        let result = tokio::time::timeout(Duration::from_secs(90), async {
            let installed = community
                .installed_versions(source, &inventory)
                .await
                .context("无法确认本地资源身份，请重试依赖检查")?;
            let unknown = inventory
                .files
                .iter()
                .filter(|file| {
                    file.path.starts_with("mods/") && !installed.contains_key(&file.path)
                })
                .map(|file| file.path.clone())
                .collect::<Vec<_>>();
            let selections =
                resolver::resolve(&catalog, &target, &inventory, installed, project, version)
                    .await?;
            Ok::<_, anyhow::Error>((selections, unknown))
        })
        .await;
        drop(catalog);
        let (selections, unknown) = match result {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                return Ok(InstallPlan {
                    token: None,
                    items: vec![],
                    issues: vec![format!("{error:#}")],
                    warnings: vec![],
                })
            }
            Err(_) => {
                return Ok(InstallPlan {
                    token: None,
                    items: vec![],
                    issues: vec!["解析前置依赖超时，请重试".into()],
                    warnings: vec![],
                })
            }
        };
        let token = uuid::Uuid::new_v4().to_string();
        let items = selections
            .iter()
            .map(|selection| selection.item.clone())
            .collect();
        let mut prepared = self.prepared.lock().unwrap_or_else(|e| e.into_inner());
        prepared.retain(|_, value| value.created.elapsed() < Duration::from_secs(600));
        if prepared.len() >= 32 {
            prepared.clear();
        }
        prepared.insert(
            token.clone(),
            Prepared {
                target,
                inventory,
                selections,
                created: Instant::now(),
            },
        );
        Ok(InstallPlan {
            token: Some(token),
            items,
            issues: vec![],
            warnings: if unknown.is_empty() {
                vec![]
            } else {
                vec![format!("{} 个本地模组未匹配到当前平台，身份暂无法确认；写入前会检查模组 ID，发生冲突时停止安装。", unknown.len())]
            },
        })
    }

    pub fn discard(&self, token: &str) {
        self.prepared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(token);
    }

    pub async fn start(
        &self,
        token: &str,
        target: Target,
        enable_paths: Vec<String>,
        downloads: Arc<DownloadManager>,
        jobs: Arc<Jobs>,
        settings: Arc<crate::config::ConfigStore>,
        resolver: UrlResolver,
    ) -> Result<String> {
        let prepared = self
            .prepared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(token)
            .context("安装清单已失效，请重新检查前置依赖")?;
        if prepared.created.elapsed() > Duration::from_secs(600) || prepared.target != target {
            bail!("游戏环境已变化，请重新检查前置依赖");
        }
        for selection in &prepared.selections {
            if selection.item.status == "disabled" && !enable_paths.contains(&selection.item.path) {
                bail!("请先选择启用已有前置：{}", selection.item.name);
            }
        }
        if enable_paths.iter().any(|path| {
            !prepared
                .selections
                .iter()
                .any(|s| s.item.status == "disabled" && &s.item.path == path)
        }) {
            bail!("启用列表包含安装清单之外的文件");
        }
        let lock = transaction::lock(&target.game)?;
        let game = target.game.clone();
        let inventory = tokio::task::spawn_blocking(move || Inventory::read(&game)).await??;
        if inventory != prepared.inventory {
            bail!("本地模组或资源已变化，请重新检查前置依赖");
        }
        let parent = safe_join(&target.game, ".tmcl/mod-install")?;
        std::fs::create_dir_all(&parent)?;
        let work = tempfile::Builder::new()
            .prefix("install-")
            .tempdir_in(parent)?;
        let title = prepared
            .selections
            .iter()
            .find(|s| s.item.main)
            .map(|s| s.item.name.as_str())
            .unwrap_or("模组");
        let job = jobs.create(
            JobKind::Install,
            format!("安装模组 {title} 及前置"),
            &[
                "准备安装文件",
                "下载模组与前置",
                "等待游戏退出",
                "校验并安装",
            ],
        );
        let id = job.snapshot().id;
        tokio::spawn(async move {
            let _lock = lock;
            let result = async {
                let mut files = vec![];
                for selection in &prepared.selections {
                    if selection.existing.is_some() { continue; }
                    let mut spec = selection.candidate.file.clone();
                    spec.path = selection.item.path.clone();
                    spec.url = tokio::select! { value = resolver(spec.url) => value?, _ = job.cancel.cancelled() => bail!("安装已取消") };
                    files.push(spec);
                }
                job.step(1, format!("下载 {} 个文件，复用 {} 个已有文件", files.len(), prepared.selections.len() - files.len()));
                jobs::download_session(&downloads, &job, job.snapshot().title, work.path().into(), files).await?;
                job.step(2, "游戏运行期间暂缓写入资源目录");
                while jobs.snapshots().iter().any(|snapshot| launch_uses_game(snapshot, &target.game)) {
                    tokio::select! { _ = job.cancel.cancelled() => bail!("安装已取消"), _ = tokio::time::sleep(Duration::from_millis(500)) => {} }
                }
                job.step(3, "复查本地文件并安装整组资源");
                if Target::resolve(target.root.clone(), &target.version_id, &settings.get())? != target {
                    bail!("游戏环境在下载期间发生变化，请重新检查前置依赖");
                }
                let stage = work.path().to_owned();
                let cancel = job.cancel.clone();
                tokio::task::spawn_blocking(move || transaction::commit(&target, &prepared.inventory, &prepared.selections, &stage, &cancel)).await??;
                Ok(())
            }.await;
            // Await all workers before deleting a session's staging directory.
            for batch in downloads.snapshots().await {
                if batch.root == work.path() {
                    if !matches!(batch.status, Status::Completed | Status::Cancelled) {
                        let _ = downloads.cancel(&batch.id).await;
                    }
                    let _ = downloads.clear(&batch.id).await;
                }
            }
            job.detach_download();
            job.finish(&result);
            if result.is_err() && work.path().join("recovery.json").is_file() {
                // Preserve the journal and remaining sources if rollback hit an occupied file.
                let _ = work.keep();
            }
        });
        Ok(id)
    }
}
