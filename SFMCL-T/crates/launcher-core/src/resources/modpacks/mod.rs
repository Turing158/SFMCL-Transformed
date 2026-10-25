mod archive;
mod parser;
#[cfg(test)]
mod tests;

use crate::{
    downloads::{DownloadSpec, Status},
    jobs::{self, Job, JobKind},
    minecraft::{
        installer::{InstallRequest, Installer},
        loaders,
        version_settings::{GameSettingGroups, GameSettings, VersionSettings},
        versions,
    },
    paths::{atomic_write, safe_join, valid_name},
    resources::community::Community,
};
use anyhow::{bail, Context, Result};
use futures_util::future::BoxFuture;
pub use parser::PackInfo;
use parser::{FileSource, Pack};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub type UrlResolver = Arc<dyn Fn(String) -> BoxFuture<'static, Result<String>> + Send + Sync>;

struct Prepared {
    temporary: tempfile::TempDir,
    pack: Pack,
}
#[derive(Default)]
pub struct Modpacks {
    prepared: Mutex<HashMap<String, Prepared>>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub token: String,
    #[serde(flatten)]
    pub info: PackInfo,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackRequest {
    pub root: PathBuf,
    pub name: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub file: Option<DownloadSpec>,
    #[serde(default)]
    pub include_optional: bool,
}

impl Modpacks {
    pub fn inspect(&self, source: &Path) -> Result<Inspection> {
        if !source.is_absolute() {
            bail!("请选择有效的整合包路径");
        }
        let temporary = tempfile::Builder::new()
            .prefix("sfmcl-t-modpack-")
            .tempdir()?;
        let extracted = temporary.path().join("archive");
        archive::extract(source, &extracted, &CancellationToken::new())?;
        let pack = parser::parse(&extracted, &CancellationToken::new())?;
        let token = uuid::Uuid::new_v4().to_string();
        let info = pack.info.clone();
        let mut prepared = self.prepared.lock().unwrap_or_else(|e| e.into_inner());
        if prepared.len() >= 8 {
            bail!("待安装的整合包过多，请关闭其他安装窗口");
        }
        prepared.insert(token.clone(), Prepared { temporary, pack });
        Ok(Inspection { token, info })
    }
    pub fn discard(&self, token: &str) {
        self.prepared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(token);
    }
    pub async fn start(
        self: &Arc<Self>,
        request: ModpackRequest,
        installer: Arc<Installer>,
        community: Arc<Community>,
        resolver: UrlResolver,
    ) -> Result<String> {
        valid_name(&request.name)?;
        if !request.root.is_absolute() {
            bail!("请选择有效的游戏目录");
        }
        if request.token.is_some() == request.file.is_some() {
            bail!("请选择一个本地整合包或在线整合包文件");
        }
        let target = safe_join(&request.root, format!("versions/{}", request.name))?;
        if target.exists() {
            bail!("版本名称已存在，请选择其他名称");
        }
        let lock_path = safe_join(&request.root, format!(".tmcl/locks/{}.lock", request.name))?;
        std::fs::create_dir_all(lock_path.parent().unwrap())?;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        lock.try_lock().context("该版本正在另一个安装任务中")?;
        if let Some(file) = &request.file {
            valid_name(&file.path)?;
        }
        let work_parent = safe_join(&request.root, ".tmcl/modpacks")?;
        std::fs::create_dir_all(&work_parent)?;
        let work = tempfile::Builder::new()
            .prefix("install-")
            .tempdir_in(work_parent)?;
        let prepared = match &request.token {
            Some(token) => Some(
                self.prepared
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(token)
                    .context("整合包预览已失效，请重新选择文件")?,
            ),
            None => None,
        };
        let job = installer.jobs.create(
            JobKind::Modpack,
            format!("安装整合包 {}", request.name),
            &[
                "下载整合包",
                "解析整合包格式",
                "准备版本信息",
                "解析资源与依赖",
                "下载游戏文件",
                "安装加载器",
                "校验启动文件",
                "准备客户端",
                "下载整合包内容",
                "合并覆盖文件",
                "发布整合包实例",
            ],
        );
        let id = job.snapshot().id;
        tokio::spawn(async move {
            let _lock = lock;
            let result = install(
                request,
                prepared,
                installer.clone(),
                community,
                resolver,
                job.clone(),
                work.path(),
            )
            .await;
            // Drain tasks before removing their staging root. Session records
            // and external-cache partials must never recreate a failed install.
            for batch in installer.downloads.snapshots().await {
                if batch.root.starts_with(work.path()) {
                    if !matches!(batch.status, Status::Completed | Status::Cancelled) {
                        let _ = installer.downloads.cancel(&batch.id).await;
                    }
                    let _ = installer.downloads.clear(&batch.id).await;
                }
            }
            job.detach_download();
            job.finish(&result);
        });
        Ok(id)
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work).await?
}
async fn install(
    request: ModpackRequest,
    prepared: Option<Prepared>,
    installer: Arc<Installer>,
    community: Arc<Community>,
    resolver: UrlResolver,
    job: Arc<Job>,
    work: &Path,
) -> Result<()> {
    job.step(0, "准备整合包文件");
    let mut pack = if let Some(prepared) = prepared {
        job.step(1, format!("已识别 {}", prepared.pack.info.format));
        // Keep the inspected archive alive until all overrides have been copied.
        prepared
    } else {
        let mut file = request.file.clone().context("缺少在线整合包文件")?;
        file.url = tokio::select! { result = resolver(file.url) => result?, _ = job.cancel.cancelled() => bail!("整合包安装已取消") };
        jobs::download_session(
            &installer.downloads,
            &job,
            format!("{} · 整合包", request.name),
            work.into(),
            vec![file.clone()],
        )
        .await?;
        job.step(1, "解压并识别包内清单");
        let source = work.join(&file.path);
        let temporary = tempfile::Builder::new()
            .prefix("sfmcl-t-modpack-")
            .tempdir()?;
        let extracted = temporary.path().join("archive");
        let cancel = job.cancel.clone();
        let pack = blocking(move || {
            archive::extract(&source, &extracted, &cancel)?;
            parser::parse(&extracted, &cancel)
        })
        .await?;
        Prepared { temporary, pack }
    };
    archive::check_cancel(&job.cancel)?;
    let stage = work.join("game");
    let instance = safe_join(&stage, format!("versions/{}", request.name))?;
    std::fs::create_dir_all(&instance)?;
    // Seed complete directory exports so offline/custom library files survive.
    if let Some(shared) = &pack.pack.shared_root {
        for folder in ["libraries", "assets"] {
            let source = shared.join(folder);
            if source.is_dir() {
                let target = stage.join(folder);
                let cancel = job.cancel.clone();
                blocking(move || copy_tree(&source, &target, &cancel)).await?;
            }
        }
    }
    let mut profile = if let Some(imported) = &pack.pack.imported {
        let mut profile = imported.clone();
        profile["id"] = json!(request.name);
        profile["jar"] = json!(request.name);
        profile["clientVersion"] = json!(pack.pack.info.minecraft);
        let has_imported_jar = pack.pack.imported_jar.is_some();
        if let Some(jar) = &pack.pack.imported_jar {
            let source = jar.clone();
            let target = instance.join(format!("{}.jar", request.name));
            let cancel = job.cancel.clone();
            blocking(move || archive::copy_file(&source, &target, &cancel)).await?;
        }
        job.step(2, "解析导入客户端与继承关系");
        let mut specs = installer.resolve_files(&stage, &profile, &job).await?;
        if has_imported_jar {
            // The merged download descriptor may belong to an inherited vanilla
            // client; never replace an exported custom/patched client JAR.
            specs.retain(|file| file.path != format!("versions/{0}/{0}.jar", request.name));
            profile
                .as_object_mut()
                .unwrap()
                .get_mut("downloads")
                .and_then(Value::as_object_mut)
                .map(|downloads| downloads.remove("client"));
        }
        jobs::download_session(
            &installer.downloads,
            &job,
            format!("{} · 客户端依赖", request.name),
            stage.clone(),
            specs,
        )
        .await?;
        profile
    } else {
        if let Some(loader) = &mut pack.pack.info.loader {
            let catalog = tokio::select! {
                result = loaders::catalog(&installer.client, &pack.pack.info.minecraft, &loader.kind) => result?,
                _ = job.cancel.cancelled() => bail!("整合包安装已取消"),
            };
            let requested = loader
                .version
                .strip_prefix(&format!("{}-", pack.pack.info.minecraft))
                .unwrap_or(&loader.version);
            *loader = catalog
                .into_iter()
                .find(|item| {
                    item.version == loader.version
                        || item.version == requested
                        || item.metadata["version"].as_str() == Some(requested)
                })
                .context("整合包指定的加载器版本不可用")?;
        }
        let base_request = InstallRequest {
            root: stage.clone(),
            name: request.name.clone(),
            minecraft: pack.pack.info.minecraft.clone(),
            loader: pack.pack.info.loader.clone(),
            optifine: None,
            fabric_api: None,
        };
        loaders::validate_selection(&base_request)?;
        installer
            .install_in_job(&base_request, job.clone(), 2)
            .await?;
        parser::read_json(&instance.join(format!("{}.json", request.name)))?
    };
    if !pack.pack.libraries.is_empty() {
        let mut libs = profile["libraries"].as_array().cloned().unwrap_or_default();
        libs.extend(pack.pack.libraries.clone());
        profile["libraries"] = json!(libs);
        let specs: Vec<_> = versions::libraries(&profile)?
            .into_iter()
            .filter(|l| !l.file.url.is_empty())
            .map(|l| l.file)
            .collect();
        jobs::download_session(
            &installer.downloads,
            &job,
            format!("{} · 附加依赖", request.name),
            stage.clone(),
            specs,
        )
        .await?;
    }
    job.step(8, "解析并下载整合包依赖");
    let mut downloads = vec![];
    let mut mirrors = HashMap::new();
    let mut paths = HashSet::new();
    for file in &pack.pack.files {
        if file.optional && !request.include_optional {
            continue;
        }
        archive::check_cancel(&job.cancel)?;
        let mut spec = match &file.source {
            FileSource::Download {
                spec,
                mirrors: urls,
            } => {
                mirrors.insert(
                    format!("versions/{}/{}", request.name, file.path),
                    urls.clone(),
                );
                spec.clone()
            }
            FileSource::CurseForge { project, file } => tokio::select! {
                result = community.pack_file(*project, *file) => result?,
                _ = job.cancel.cancelled() => bail!("整合包安装已取消"),
            },
        };
        reserved(&spec.path, &request.name)?;
        if !paths.insert(spec.path.to_lowercase()) {
            bail!("整合包依赖存在重复安装路径");
        }
        let resolution = tokio::select! { result = resolver(spec.url.clone()) => result, _ = job.cancel.cancelled() => bail!("整合包安装已取消") };
        match resolution {
            Ok(url) => spec.url = url,
            Err(error) if crate::resources::curseforge::is_download_entry(&spec.url) => {
                job.log(format!(
                    "无法自动获取 {}：{error:#}。可在下载文件详情中补选原始文件。",
                    spec.path
                ));
            }
            Err(error) => return Err(error),
        }
        spec.path = format!("versions/{}/{}", request.name, spec.path);
        downloads.push(spec);
    }
    download_contents(&installer, &job, &stage, &request.name, downloads, &mirrors).await?;
    job.step(9, "合并客户端覆盖文件");
    for source in &pack.pack.contents {
        let source = source.clone();
        let target = instance.clone();
        let imported = pack.pack.imported.is_some();
        let profiles = pack.pack.profile_files.clone();
        let name = request.name.clone();
        let cancel = job.cancel.clone();
        blocking(move || copy_contents(&source, &target, &name, imported, &profiles, &cancel))
            .await?;
    }
    for (path, sha1) in &pack.pack.verified {
        parser::verify_sha1(&safe_join(&instance, path)?, sha1)?;
    }
    let libs = versions::libraries(&profile)?;
    for lib in &libs {
        if !safe_join(&stage, &lib.file.path)?.is_file() {
            bail!("整合包仍缺少依赖：{}", lib.file.path);
        }
    }
    if !instance.join(format!("{}.jar", request.name)).is_file() {
        bail!("整合包缺少客户端 JAR");
    }
    versions::extract_natives(&stage, &request.name, &libs)?;
    let mut settings = installer.settings.get();
    settings.isolation = true;
    installer.materialize_assets(&stage, &profile, &settings)?;
    profile["tmclModpack"] = json!({"format": pack.pack.info.format, "name": pack.pack.info.name, "version": pack.pack.info.version, "isolated": true});
    atomic_write(
        &instance.join(format!("{}.json", request.name)),
        &serde_json::to_vec_pretty(&profile)?,
    )?;
    let independent = VersionSettings {
        use_global: false,
        independent_groups: Some(GameSettingGroups {
            memory: true,
            ..Default::default()
        }),
        settings: GameSettings::from(&settings),
    };
    crate::minecraft::version_settings::save(&stage, &request.name, &independent)?;
    job.step(10, "将整合包加入版本管理");
    // Shared files use atomic replacement. The new instance is published once,
    // by rename, so cancellation/failure never exposes a partial version.
    let mut expected: HashMap<_, _> = libs
        .iter()
        .map(|lib| (lib.file.path.clone(), lib.file.clone()))
        .collect();
    for batch in installer.downloads.snapshots().await {
        if batch.root == stage {
            for file in batch.files {
                if file.spec.path.starts_with("libraries/") || file.spec.path.starts_with("assets/")
                {
                    expected.insert(file.spec.path.clone(), file.spec);
                }
            }
        }
    }
    for folder in ["libraries", "assets"] {
        let source = stage.join(folder);
        let target_root = request.root.clone();
        let cancel = job.cancel.clone();
        let expected = expected.clone();
        blocking(move || publish_shared(&source, &target_root, folder, &expected, &cancel)).await?;
    }
    archive::check_cancel(&job.cancel)?;
    let final_instance = safe_join(&request.root, format!("versions/{}", request.name))?;
    if final_instance.exists() {
        bail!("版本名称已存在，请选择其他名称");
    }
    std::fs::create_dir_all(final_instance.parent().unwrap())?;
    std::fs::rename(&instance, final_instance)?;
    let _ = pack.temporary.path();
    Ok(())
}

async fn download_contents(
    installer: &Installer,
    job: &Job,
    root: &Path,
    name: &str,
    mut files: Vec<DownloadSpec>,
    mirrors: &HashMap<String, Vec<String>>,
) -> Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    loop {
        let id = installer
            .downloads
            .enqueue_with_retention(
                format!("{name} · 整合包内容"),
                root.into(),
                files.clone(),
                crate::downloads::DownloadRetention::Session,
            )
            .await?;
        loop {
            let snapshot = installer.downloads.snapshot(&id).await?;
            job.download(id.clone(), snapshot.status);
            if snapshot.status == Status::Completed {
                return Ok(());
            }
            if snapshot.status == Status::Cancelled {
                bail!("整合包内容下载已取消");
            }
            if snapshot.status == Status::Failed {
                let mut changed = false;
                let mut next = vec![];
                for file in &snapshot.files {
                    if file.status == Status::Completed {
                        continue;
                    }
                    let mut spec = file.spec.clone();
                    if let Some(urls) = mirrors.get(&spec.path) {
                        if let Some(index) = urls.iter().position(|url| url == &spec.url) {
                            if let Some(url) = urls.get(index + 1) {
                                spec.url = url.clone();
                                changed = true;
                            }
                        }
                    }
                    next.push(spec);
                }
                if changed {
                    installer.downloads.cancel(&id).await?;
                    installer.downloads.clear(&id).await?;
                    files = next;
                    break;
                }
            }
            tokio::select! {
                _ = job.cancel.cancelled() => { installer.downloads.cancel(&id).await?; bail!("整合包安装已取消"); },
                _ = tokio::time::sleep(Duration::from_millis(150)) => {},
            }
        }
    }
}

fn reserved(path: &str, name: &str) -> Result<()> {
    let path = archive::relative(path)?.to_lowercase();
    let first = path.split('/').next().unwrap_or("");
    if [
        ".tmcl",
        "versions",
        "libraries",
        "assets",
        "natives",
        "sfmcl",
    ]
    .contains(&first)
        || first.starts_with("launcher_")
        || first.starts_with(".starfall-")
        || path == format!("{name}.json").to_lowercase()
        || path == format!("{name}.jar").to_lowercase()
    {
        bail!("整合包内容不能覆盖客户端版本文件、共享依赖或启动器配置");
    }
    Ok(())
}
fn copy_tree(source: &Path, target: &Path, cancel: &CancellationToken) -> Result<()> {
    for file in archive::files(source, cancel)? {
        archive::copy_file(
            &file,
            &safe_join(target, file.strip_prefix(source)?)?,
            cancel,
        )?;
    }
    Ok(())
}
fn copy_contents(
    source: &Path,
    target: &Path,
    name: &str,
    imported: bool,
    profiles: &HashSet<PathBuf>,
    cancel: &CancellationToken,
) -> Result<()> {
    for file in archive::files(source, cancel)? {
        let path = archive::relative(&file.strip_prefix(source)?.to_string_lossy())?;
        let first = path.split('/').next().unwrap().to_lowercase();
        if imported
            && ([
                "versions",
                "libraries",
                "assets",
                ".tmcl",
                "sfmcl",
                "natives",
            ]
            .contains(&first.as_str())
                || first.starts_with("launcher_")
                || first.starts_with(".starfall-")
                || profiles.contains(&file))
        {
            continue;
        }
        reserved(&path, name)?;
        archive::copy_file(&file, &safe_join(target, &path)?, cancel)?;
    }
    Ok(())
}
fn publish_shared(
    source: &Path,
    root: &Path,
    folder: &str,
    expected: &HashMap<String, DownloadSpec>,
    cancel: &CancellationToken,
) -> Result<()> {
    if !source.is_dir() {
        return Ok(());
    }
    for file in archive::files(source, cancel)? {
        let relative = Path::new(folder).join(file.strip_prefix(source)?);
        let target = safe_join(root, &relative)?;
        let key = relative.to_string_lossy().replace('\\', "/");
        if target.exists()
            && expected
                .get(&key)
                .is_none_or(|spec| spec.sha1.is_none() && spec.sha512.is_none())
        {
            continue;
        }
        std::fs::create_dir_all(target.parent().unwrap())?;
        let partial = target.with_file_name(format!(".{}.part", uuid::Uuid::new_v4()));
        let result = (|| -> Result<()> {
            archive::copy_file(&file, &partial, cancel)?;
            archive::check_cancel(cancel)?;
            std::fs::rename(&partial, &target)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(partial);
        }
        result?;
    }
    Ok(())
}
