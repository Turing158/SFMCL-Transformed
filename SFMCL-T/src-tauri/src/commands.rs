use anyhow::{bail, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri_plugin_opener::OpenerExt;
#[cfg(test)]
#[path = "context_menu_tests.rs"]
mod context_menu_tests;
#[cfg(test)]
#[path = "version_list_tests.rs"]
mod version_list_tests;
use sfmcl_t_core::{
    accounts::Accounts,
    config::{ConfigStore, Settings},
    downloads::{prepare_cache_directory, DownloadManager, Status},
    jobs::{JobKind, Jobs},
    minecraft::{
        installer::{InstallRequest, Installer},
        java, loaders, version_settings, versions,
    },
    paths::{atomic_write, minecraft_root, safe_join},
    resources::{
        community::Community,
        local,
        modpacks::{ModpackRequest, Modpacks, UrlResolver},
    },
    vault::Vault,
};

pub struct Runtime {
    pub settings: Arc<ConfigStore>,
    pub accounts: Arc<Accounts>,
    pub downloads: Arc<DownloadManager>,
    pub jobs: Arc<Jobs>,
    pub installer: Arc<Installer>,
    pub community: Arc<Community>,
    pub modpacks: Arc<Modpacks>,
    pub official_notices: sfmcl_t_core::notices::OfficialNotices,
    pub home_content: sfmcl_t_core::home_content::HomeContentStore,
    pub directory: PathBuf,
}
fn version_entries(settings: &Settings, payload: &Value) -> Result<Vec<Value>> {
    let directory = match payload.get("directory") {
        Some(value) => value.as_str().context("游戏目录无效")?,
        None => &settings.active_dir,
    };
    let root = if payload.get("directory").is_some() {
        settings.registered_game_root(Path::new(directory))?
    } else {
        settings.active_game_root()?
    };
    let mut entries = vec![];
    for version in versions::scan(&root)? {
        let mut entry = serde_json::to_value(&version)?;
        entry["directory"] = json!(directory);
        match version_settings::load(&root, &version.id, settings) {
            Ok(value) => {
                entry["independentSettings"] = json!(value.has_independent_settings());
                entry["isolation"] = json!(value.resolve(settings).isolation);
            }
            Err(error) => entry["error"] = json!(format!("{error:#}")),
        }
        entries.push(entry);
    }
    Ok(entries)
}
fn favorite_entries(settings: &Settings) -> Result<Vec<Value>> {
    versions::favorites(settings)
        .into_iter()
        .map(|favorite| {
            let root = settings.registered_game_root(Path::new(&favorite.directory))?;
            let mut entry = serde_json::to_value(&favorite)?;
            match version_settings::load(&root, &favorite.version.id, settings) {
                Ok(value) => {
                    entry["independentSettings"] = json!(value.has_independent_settings());
                    entry["isolation"] = json!(value.resolve(settings).isolation);
                }
                Err(error) => {
                    entry["error"] = json!(format!("{error:#}"));
                }
            }
            Ok(entry)
        })
        .collect()
}
impl Runtime {
    pub fn new(directory: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&directory)?;
        let settings = Arc::new(ConfigStore::open(&directory)?);
        let vault = Arc::new(Vault::open(&directory)?);
        let downloads = DownloadManager::open(
            &directory.join("downloads"),
            settings.get().download_concurrency,
        )?;
        downloads.set_cache_directory(&settings.get().download_cache_directory(&directory))?;
        downloads
            .sources()
            .set_mode(settings.get().minecraft_download_source);
        let jobs = Arc::new(Jobs::default());
        let accounts = Accounts::open(&directory, vault.clone(), settings.clone(), jobs.clone())?;
        let installer = Arc::new(Installer {
            downloads: downloads.clone(),
            jobs: jobs.clone(),
            client: sfmcl_t_core::http_client()?,
            settings: settings.clone(),
        });
        let community = Arc::new(Community::new(vault)?.with_sources(downloads.sources()));
        let official_notices = sfmcl_t_core::notices::OfficialNotices::new(
            directory.clone(),
            installer.client.clone(),
        );
        Ok(Self {
            settings,
            accounts,
            downloads,
            jobs,
            installer,
            community,
            modpacks: Arc::new(Modpacks::default()),
            official_notices,
            home_content: Default::default(),
            directory,
        })
    }
    fn root(&self) -> Result<PathBuf> {
        self.settings.get().active_game_root()
    }
    fn target_root(&self, payload: &Value) -> Result<PathBuf> {
        match payload.get("directory") {
            Some(directory) => self
                .settings
                .get()
                .registered_game_root(Path::new(directory.as_str().context("游戏目录无效")?)),
            None => self.root(),
        }
    }
    fn game_root(&self) -> Result<PathBuf> {
        let s = self.settings.get();
        if s.active_version.is_empty() {
            bail!("请先在版本管理中选择游戏版本");
        }
        version_settings::game_directory(&self.root()?, &s.active_version, &s)
    }
    fn resource_root(&self, payload: &Value) -> Result<PathBuf> {
        match payload.get("versionId") {
            Some(value) => {
                let root = self.target_root(payload)?;
                let id = value.as_str().context("游戏版本无效")?;
                let settings = version_settings::resolve(&root, id, &self.settings.get())?;
                local::version_root(&root, id, settings.isolation)
            }
            None => self.game_root(),
        }
    }
    fn allowed_path(&self, path: &Path) -> Result<()> {
        if !path.is_absolute() {
            bail!("需要绝对路径");
        }
        let s = self.settings.get();
        let mut roots: Vec<PathBuf> = s
            .game_dirs
            .into_iter()
            .map(|d| minecraft_root(Path::new(&d.path)))
            .collect();
        roots.push(self.directory.clone());
        if roots
            .iter()
            .any(|r| path == r || path.strip_prefix(r).is_ok_and(|p| safe_join(r, p).is_ok()))
        {
            return Ok(());
        }
        if path == Path::new(&s.background)
            || path == Path::new(&s.player3d_background)
            || self
                .accounts
                .list()
                .iter()
                .any(|p| Path::new(&p.skin) == path)
        {
            return Ok(());
        }
        bail!("路径不在已选择的游戏或配置目录内")
    }
}
fn text<'a>(payload: &'a Value, key: &str) -> Result<&'a str> {
    payload[key]
        .as_str()
        .with_context(|| format!("缺少参数 {key}"))
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    Ok(serde_json::from_value(value)?)
}

#[tauri::command]
pub async fn request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Runtime>>,
    operation: String,
    payload: Value,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("此窗口不能操作启动器".into());
    }
    dispatch(app, state.inner().clone(), &operation, payload)
        .await
        .map_err(|e| format!("{e:#}"))
}
async fn dispatch(app: tauri::AppHandle, r: Arc<Runtime>, op: &str, p: Value) -> Result<Value> {
    use tauri::Manager;
    if app
        .try_state::<crate::local_data::DataManager>()
        .is_some_and(|manager| manager.executing())
    {
        bail!("本地数据操作已开始，启动器即将自动重新打开");
    }
    match op {
        "bootstrap" => Ok(
            json!({"settings":r.settings.get(),"players":r.accounts.list(),"dataDir":r.directory,"defaultDownloadCacheDir":r.directory.join("downloads").join("cache"),"backgroundPath":sfmcl_t_core::notices::background(&r.directory,&r.settings.get()),"version":env!("CARGO_PKG_VERSION"),"localDataResult":app.try_state::<crate::local_data::DataManager>().and_then(|manager| manager.result.clone())}),
        ),
        "local-data.prepare" => {
            let kind = serde_json::from_value::<sfmcl_t_core::local_data::OperationKind>(
                p["kind"].clone(),
            )?;
            crate::local_data::prepare(&app, &r, kind, PathBuf::from(text(&p, "path")?)).await
        }
        "local-data.execute" => crate::local_data::execute(app, r, text(&p, "id")?).await,
        "local-data.recovery.open" => {
            let manager = app.state::<crate::local_data::DataManager>();
            let path = manager
                .result
                .as_ref()
                .and_then(|result| result.recovery_path.as_ref())
                .context("没有可打开的原数据副本")?;
            if !path.is_dir() {
                bail!("原数据副本已被移动或删除");
            }
            app.opener()
                .open_path(path.to_string_lossy(), None::<&str>)?;
            Ok(json!(true))
        }
        "home.content.get" => Ok(json!(r.home_content.load(&r.directory)?)),
        "home.content.save" => Ok(json!(r
            .home_content
            .save(&r.directory, serde_json::from_value(p.clone())?)?)),
        "notices.list" => Ok(json!(r.official_notices.list()?)),
        "notices.refresh" => Ok(json!(
            r.official_notices
                .refresh(p["force"].as_bool().unwrap_or(false))
                .await
        )),
        "notices.hidden" => Ok(json!(r.official_notices.hidden()?)),
        "notices.delete" => Ok(json!(r.official_notices.delete(text(&p, "id")?)?)),
        "notices.visibility" => Ok(json!(r.official_notices.set_hidden(
            text(&p, "id")?,
            p["hidden"].as_bool().context("缺少公告显示状态")?
        )?)),
        "notices.create" => Ok(json!(r
            .official_notices
            .create(text(&p, "title")?, text(&p, "content")?)?)),
        "settings.save" => {
            let mut settings = decode::<Settings>(p)?;
            settings.download_cache_dir = settings.download_cache_dir.trim().into();
            settings.validate()?;
            let cache = settings.download_cache_directory(&r.directory);
            if settings.download_cache_dir != r.settings.get().download_cache_dir {
                prepare_cache_directory(&cache)?;
            }
            r.settings.save(settings)?;
            r.downloads
                .sources()
                .set_mode(r.settings.get().minecraft_download_source);
            r.downloads.set_cache_directory(&cache)?;
            Ok(json!(r.settings.get()))
        }
        "settings.import" => {
            let path = PathBuf::from(text(&p, "path")?);
            let data = std::fs::read(&path)?;
            if data.len() > 8 * 1024 * 1024 {
                bail!("配置文件过大");
            }
            let value: Value = serde_json::from_slice(&data)?;
            let base = path
                .parent()
                .and_then(Path::parent)
                .unwrap_or(Path::new("."));
            let settings = sfmcl_t_core::config::import_legacy(&value, base);
            settings.validate()?;
            let count = r.accounts.import_legacy(&value)?;
            let cache = settings.download_cache_directory(&r.directory);
            r.settings.save(settings)?;
            r.downloads
                .sources()
                .set_mode(r.settings.get().minecraft_download_source);
            r.downloads.set_cache_directory(&cache)?;
            Ok(json!({"players":count}))
        }
        "system.memory" => {
            let available_mb = tokio::task::spawn_blocking(java::available_memory_mb).await?;
            Ok(json!({"availableMb":available_mb}))
        }
        "system.monitors" => Ok(
            json!({"supported":cfg!(windows),"monitors":sfmcl_t_core::minecraft::window::monitors()}),
        ),
        "game.launch-options" => {
            let settings = r.settings.get();
            let id = p["versionId"].as_str().unwrap_or(&settings.active_version);
            if id.is_empty() {
                return Ok(json!({"supportsQuickPlay":null,"worlds":[],"directory":""}));
            }
            let root = r.target_root(&p)?;
            let effective = version_settings::resolve(&root, id, &settings)?;
            let directory = versions::game_directory(
                &root,
                id,
                p["isolation"].as_bool().unwrap_or(effective.isolation),
            )?;
            let version = versions::resolve(&root, id)?;
            let supports = sfmcl_t_core::minecraft::quick_play::supports(&version);
            let scan_directory = directory.clone();
            let worlds = tokio::task::spawn_blocking(move || {
                sfmcl_t_core::minecraft::quick_play::worlds(&scan_directory)
            })
            .await??;
            Ok(json!({"supportsQuickPlay":supports,"worlds":worlds,"directory":directory}))
        }
        "java.discover" => {
            let mut paths = r.settings.get().java_paths;
            if let Some(extra) = p.get("paths") {
                paths.extend(decode::<Vec<String>>(extra.clone())?);
            }
            Ok(json!(java::discover(&paths).await))
        }
        "java.list" => {
            let paths = match p.get("paths") {
                Some(paths) => decode::<Vec<String>>(paths.clone())?,
                None => r.settings.get().java_paths,
            };
            Ok(json!(java::inspect(&paths).await))
        }
        "java.paths.save" => {
            let paths = decode::<Vec<String>>(p["paths"].clone())?;
            let root = p.get("versionId").map(|_| r.target_root(&p)).transpose()?;
            let version = match root.as_deref() {
                Some(root) => Some((root, text(&p, "versionId")?)),
                None => None,
            };
            Ok(json!(java::save_paths(
                &r.settings,
                version,
                paths,
                p["removedPath"].as_str()
            )?))
        }
        "java.probe" => Ok(json!(java::probe(text(&p, "path")?).await?)),
        "players.list" => Ok(json!(r.accounts.list())),
        "players.reorder" => Ok(json!(r
            .accounts
            .reorder(&decode::<Vec<String>>(p["ids"].clone())?)?)),
        "players.add" => Ok(json!(r.accounts.add_offline(text(&p, "name")?)?)),
        "players.select" => {
            r.accounts.select(text(&p, "id")?)?;
            Ok(json!(true))
        }
        "players.remove" => {
            r.accounts.remove(text(&p, "id")?)?;
            Ok(json!(true))
        }
        "players.rename" => Ok(json!(
            r.accounts
                .update_name(text(&p, "id")?, text(&p, "name")?)
                .await?
        )),
        "players.skin" => Ok(json!(
            r.accounts
                .update_skin(
                    text(&p, "id")?,
                    p["path"].as_str().filter(|s| !s.is_empty()).map(Path::new),
                    p["slim"].as_bool().unwrap_or(false)
                )
                .await?
        )),
        "players.skin.preview" => {
            let bytes =
                sfmcl_t_core::accounts::read_skin_file(Path::new(text(&p, "path")?)).await?;
            Ok(json!(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )))
        }
        "players.capes" => Ok(json!(
            r.accounts
                .capes(text(&p, "id")?, p["refresh"].as_bool().unwrap_or(false))
                .await?
        )),
        "players.cape" => Ok(json!(
            r.accounts
                .set_cape(
                    text(&p, "id")?,
                    p["capeId"].as_str().filter(|s| !s.is_empty())
                )
                .await?
        )),
        "players.namechange" => Ok(json!(r.accounts.name_change(text(&p, "id")?).await?)),
        "players.login" => Ok(json!(r.accounts.begin_login().await?)),
        "players.yggdrasil.oauth.begin" => Ok(json!(r.accounts.begin_littleskin().await?)),
        "players.yggdrasil.oauth.wait" => Ok(json!(
            r.accounts.wait_littleskin(text(&p, "sessionId")?).await?
        )),
        "players.yggdrasil.login" => Ok(json!(
            r.accounts
                .begin_yggdrasil(
                    text(&p, "server")?,
                    text(&p, "username")?,
                    text(&p, "password")?
                )
                .await?
        )),
        "players.yggdrasil.select" => Ok(json!(
            r.accounts
                .complete_yggdrasil(text(&p, "sessionId")?, text(&p, "profileId")?)
                .await?
        )),
        "players.yggdrasil.cancel" => {
            r.accounts.cancel_yggdrasil(text(&p, "sessionId")?);
            Ok(json!(true))
        }
        "players.refresh" => Ok(json!(r.accounts.refresh(text(&p, "id")?).await?)),
        "versions.list" => {
            let settings = r.settings.get();
            Ok(json!(
                tokio::task::spawn_blocking(move || version_entries(&settings, &p)).await??
            ))
        }
        "versions.settings.get" => Ok(json!(version_settings::load(
            &r.target_root(&p)?,
            text(&p, "id")?,
            &r.settings.get()
        )?)),
        "versions.favorites" => {
            let settings = r.settings.get();
            Ok(json!(
                tokio::task::spawn_blocking(move || favorite_entries(&settings)).await??
            ))
        }
        "versions.settings.save" => {
            let value = decode::<version_settings::VersionSettings>(p["config"].clone())?;
            version_settings::save(&r.target_root(&p)?, text(&p, "id")?, &value)?;
            Ok(json!(value))
        }
        "versions.detail" => versions::resolve(&r.target_root(&p)?, text(&p, "id")?),
        "versions.select" => {
            let id = text(&p, "id")?;
            let settings = r.settings.get();
            let directory = p["directory"].as_str().unwrap_or(&settings.active_dir);
            let root = settings.registered_game_root(Path::new(directory))?;
            versions::resolve(&root, id)?;
            r.settings.update(|s| {
                s.active_dir = directory.into();
                s.active_version = id.into();
            })?;
            Ok(json!(true))
        }
        "versions.favorite" => {
            let favorite = p["favorite"].as_bool().context("缺少收藏状态")?;
            versions::set_favorite(&r.target_root(&p)?, text(&p, "id")?, favorite)?;
            Ok(json!(true))
        }
        "versions.rename" => {
            let id = text(&p, "id")?;
            let new_id = text(&p, "name")?;
            let root = r.target_root(&p)?;
            versions::rename(&root, id, new_id)?;
            r.settings.update(|s| {
                if s.active_version == id && minecraft_root(Path::new(&s.active_dir)) == root {
                    s.active_version = new_id.into();
                }
            })?;
            Ok(json!(true))
        }
        "versions.icon" => {
            let id = text(&p, "id")?;
            let target = safe_join(&r.target_root(&p)?, format!("versions/{id}/icon.png"))?;
            if let Some(path) = p["path"].as_str() {
                let bytes = std::fs::read(path)?;
                if bytes.len() > 8 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG") {
                    bail!("请选择不超过 8 MB 的 PNG 图标");
                }
                atomic_write(&target, &bytes)?;
            } else if target.exists() {
                std::fs::remove_file(target)?;
            }
            Ok(json!(true))
        }
        "versions.delete" => {
            let root = r.target_root(&p)?;
            let id = text(&p, "id")?;
            for entry in versions::scan(&root)? {
                if entry.id != id {
                    let v = versions::resolve(&root, &entry.id)?;
                    if v["inheritsFrom"].as_str() == Some(id) || v["jar"].as_str() == Some(id) {
                        bail!("版本 {} 依赖此版本，无法删除", entry.id);
                    }
                }
            }
            let target = safe_join(&root, format!("versions/{id}"))?;
            if !target.is_dir() {
                bail!("版本不存在");
            }
            let lockpath = safe_join(&root, format!(".tmcl/locks/launch-{id}.lock"))?;
            if lockpath.exists() {
                let lock = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(lockpath)?;
                lock.try_lock().context("游戏正在运行，无法删除")?;
                std::fs::remove_dir_all(&target)?;
            } else {
                std::fs::remove_dir_all(&target)?;
            }
            r.settings.update(|s| {
                if s.active_version == id && minecraft_root(Path::new(&s.active_dir)) == root {
                    s.active_version.clear();
                }
            })?;
            Ok(json!(true))
        }
        "versions.repair" => {
            let root = r.target_root(&p)?;
            let id = text(&p, "id")?.to_owned();
            let job = r.jobs.create(
                JobKind::Repair,
                format!("修复 {id}"),
                &["解析版本", "解析资源", "补全文件", "提取 native"],
            );
            let job_id = job.snapshot().id;
            let installer = r.installer.clone();
            tokio::spawn(async move {
                let result = installer.repair(&root, &id, job.clone()).await;
                job.finish(&result);
            });
            Ok(json!(job_id))
        }
        "manifest" => r.installer.manifest().await,
        "loaders" => Ok(json!(
            loaders::catalog_with_sources(
                &r.installer.client,
                &r.installer.sources(),
                text(&p, "minecraft")?,
                text(&p, "kind")?
            )
            .await?
        )),
        "install" => {
            let mut request: InstallRequest = decode(p)?;
            request.root = r.settings.get().registered_game_root(&request.root)?;
            Ok(json!(r.installer.start(request).await?))
        }
        "launch" => {
            let s = r.settings.get();
            if p["id"].as_str().is_some_and(|id| id != s.active_version)
                || p["directory"]
                    .as_str()
                    .is_some_and(|directory| directory != s.active_dir)
            {
                bail!("游戏目录或版本已切换，请重新选择收藏版本");
            }
            let player = r.accounts.launch_identity(&s.active_player).await?;
            let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
            let id = r
                .installer
                .launch_with_events(s.active_version, player, Some(events))
                .await?;
            let event_id = id.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = receiver.recv().await {
                    let event_app = app.clone();
                    let event_id = event_id.clone();
                    if let Err(error) = app.run_on_main_thread(move || {
                        if let Err(error) =
                            crate::launch_window::event(&event_app, &event_id, event)
                        {
                            eprintln!("Cannot apply launcher launch behavior: {error}");
                        }
                    }) {
                        eprintln!("Cannot schedule launcher launch behavior: {error}");
                    }
                }
            });
            Ok(json!(id))
        }
        "tasks" => {
            let snapshots = r.downloads.snapshots().await;
            let summaries:Vec<_>=snapshots.into_iter().map(|s|{
                let total:u64=s.files.iter().map(|f|f.total.unwrap_or(0)).sum();let unknown=s.files.iter().any(|f|f.total.is_none());let downloaded=s.downloaded();let completed=s.completed();let failed=s.files.iter().filter(|f|f.status==Status::Failed).count();
                json!({"id":s.id,"title":s.title,"status":s.status,"downloaded":downloaded,"total":total,"unknownSize":unknown,"completed":completed,"failed":failed,"fileCount":s.files.len(),"speed":s.bytes_per_second,"workers":s.active_workers,"steps":s.steps,"error":s.error})
            }).collect();
            Ok(json!({"downloads":summaries,"jobs":r.jobs.snapshots()}))
        }
        "downloads.files" => {
            let s = r.downloads.snapshot(text(&p, "id")?).await?;
            let offset = p["offset"].as_u64().unwrap_or(0) as usize;
            let mut files = s.files;
            files.sort_by_key(|f| match f.status {
                Status::Failed => 0,
                Status::Running => 1,
                _ => 2,
            });
            Ok(json!(files
                .into_iter()
                .skip(offset)
                .take(100)
                .collect::<Vec<_>>()))
        }
        "downloads.control" => {
            let id = text(&p, "id")?;
            match text(&p, "action")? {
                "pause" => r.downloads.pause(id).await?,
                "resume" | "retry" => r.downloads.resume(id).await?,
                "cancel" => r.downloads.cancel(id).await?,
                "clear" => r.downloads.clear(id).await?,
                _ => bail!("未知下载操作"),
            };
            Ok(json!(true))
        }
        "jobs.cancel" => {
            r.jobs.cancel(text(&p, "id")?)?;
            Ok(json!(true))
        }
        "resources.local" => {
            let root = r.resource_root(&p)?;
            let kind = text(&p, "kind")?.to_owned();
            Ok(json!(
                tokio::task::spawn_blocking(move || local::scan(&root, &kind)).await??
            ))
        }
        "resources.localSize" => {
            let root = r.resource_root(&p)?;
            let kind = text(&p, "kind")?.to_owned();
            let path = PathBuf::from(text(&p, "path")?);
            let relative = path.strip_prefix(&root)?.to_string_lossy().into_owned();
            Ok(json!(
                tokio::task::spawn_blocking(move || local::directory_size(&root, &relative, &kind))
                    .await??
            ))
        }
        "resources.localProject" => {
            let root = r.resource_root(&p)?;
            let path = PathBuf::from(text(&p, "path")?);
            Ok(json!(
                r.community
                    .local_project(text(&p, "source")?, &root, &path)
                    .await?
            ))
        }
        "resources.toggle" => {
            let root = r.resource_root(&p)?;
            let path = PathBuf::from(text(&p, "path")?);
            Ok(json!(local::toggle_mod(
                &root,
                &path.strip_prefix(&root)?.to_string_lossy(),
                p["disabled"].as_bool().unwrap_or(false)
            )?))
        }
        "resources.deletePack" => {
            let root = r.resource_root(&p)?;
            let path = PathBuf::from(text(&p, "path")?);
            local::delete_pack(&root, &path.strip_prefix(&root)?.to_string_lossy())?;
            Ok(json!(true))
        }
        "resources.search" => Ok(json!(r.community.search(&decode(p)?).await?)),
        "resources.detail" => Ok(json!(
            r.community
                .detail(text(&p, "source")?, text(&p, "id")?)
                .await?
        )),
        "resources.files" => Ok(json!(
            r.community
                .files(
                    text(&p, "source")?,
                    text(&p, "id")?,
                    p["gameVersion"].as_str().unwrap_or(""),
                    p["loader"].as_str().unwrap_or("")
                )
                .await?
        )),
        "resources.categories" => {
            r.community
                .categories(text(&p, "source")?, text(&p, "kind")?)
                .await
        }
        "modpacks.inspect" => {
            let path = PathBuf::from(text(&p, "path")?);
            let modpacks = r.modpacks.clone();
            Ok(json!(
                tokio::task::spawn_blocking(move || modpacks.inspect(&path)).await??
            ))
        }
        "modpacks.discard" => {
            r.modpacks.discard(text(&p, "token")?);
            Ok(json!(true))
        }
        "modpacks.supplyFile" => {
            let id = text(&p, "id")?;
            if !r.jobs.snapshots().iter().any(|job| {
                job.download_id.as_deref() == Some(id)
                    && job.title.starts_with("安装整合包 ")
                    && !matches!(job.status, Status::Completed | Status::Cancelled)
            }) {
                bail!("此下载不属于正在安装的整合包");
            }
            let snapshot = r.downloads.snapshot(id).await?;
            if snapshot.retention != sfmcl_t_core::downloads::DownloadRetention::Session {
                bail!("此下载不支持补选整合包文件");
            }
            r.downloads
                .supply_file(id, text(&p, "path")?, Path::new(text(&p, "source")?))
                .await?;
            Ok(json!(true))
        }
        "modpacks.install" => {
            let mut request: ModpackRequest = decode(p)?;
            request.root = r.settings.get().registered_game_root(&request.root)?;
            let community = r.community.clone();
            let resolver: UrlResolver = Arc::new(move |url| {
                let app = app.clone();
                let community = community.clone();
                Box::pin(async move {
                    crate::curseforge_download::resolve_with_sources(&app, &url, &community).await
                })
            });
            Ok(json!(
                r.modpacks
                    .start(request, r.installer.clone(), r.community.clone(), resolver)
                    .await?
            ))
        }
        "resources.download" => {
            let kind = text(&p, "kind")?;
            let folder = sfmcl_t_core::resources::download::installation_folder(kind)?;
            let mut spec: sfmcl_t_core::downloads::DownloadSpec = decode(p["file"].clone())?;
            sfmcl_t_core::paths::valid_name(&spec.path)?;
            let root = if let Some(directory) = p.get("directory") {
                if p.get("versionId").is_some() {
                    bail!("请选择一种下载方式");
                }
                let (root, file) = sfmcl_t_core::resources::download::folder_destination(
                    Path::new(directory.as_str().context("下载文件夹无效")?),
                    spec,
                )?;
                spec = file;
                root
            } else {
                let folder = folder.context("此资源需要下载到文件夹；整合包请选择新建实例安装")?;
                let root = r.root()?;
                let game = r.resource_root(&p)?;
                spec.path = game
                    .join(folder)
                    .join(&spec.path)
                    .strip_prefix(&root)?
                    .to_string_lossy()
                    .into_owned();
                root
            };
            spec.url =
                crate::curseforge_download::resolve_with_sources(&app, &spec.url, &r.community)
                    .await?;
            Ok(json!(
                r.downloads
                    .enqueue(
                        p["title"].as_str().unwrap_or("资源下载").into(),
                        root,
                        vec![spec]
                    )
                    .await?
            ))
        }
        "image" => {
            let source = text(&p, "path")?;
            let bytes = if source.to_ascii_lowercase().starts_with("http://")
                || source.to_ascii_lowercase().starts_with("https://")
            {
                r.accounts.texture_image(source).await?
            } else {
                let path = PathBuf::from(source);
                r.allowed_path(&path)?;
                if std::fs::metadata(&path)?.len() > 8 * 1024 * 1024 {
                    bail!("图片超过 8 MB");
                }
                std::fs::read(&path)?
            };
            let mime = if bytes.starts_with(b"\x89PNG") {
                "image/png"
            } else if bytes.starts_with(&[0xff, 0xd8]) {
                "image/jpeg"
            } else {
                bail!("不支持的图片格式");
            };
            Ok(json!(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )))
        }
        "downloads.cache.open" => {
            let requested = text(&p, "path")?.trim();
            let path = if requested.is_empty() {
                r.directory.join("downloads").join("cache")
            } else {
                PathBuf::from(requested)
            };
            if !path.is_absolute() {
                bail!("下载缓存文件夹必须是绝对路径");
            }
            // Open the directory currently shown in settings, including unsaved
            // selections. Creating it also rejects paths pointing to a file.
            std::fs::create_dir_all(&path).context("无法打开下载缓存文件夹")?;
            app.opener()
                .open_path(path.to_string_lossy(), None::<&str>)?;
            Ok(json!(true))
        }
        "path.open" => {
            let path = PathBuf::from(text(&p, "path")?);
            r.allowed_path(&path)?;
            if p["reveal"].as_bool().unwrap_or(false) {
                if !path.is_file() {
                    bail!("资源文件不存在，请刷新本地资源列表");
                }
                app.opener().reveal_item_in_dir(&path)?;
            } else {
                if !path.exists() {
                    std::fs::create_dir_all(&path)?;
                }
                app.opener()
                    .open_path(path.to_string_lossy(), None::<&str>)?;
            }
            Ok(json!(true))
        }
        "updates" => Ok(json!(
            sfmcl_t_core::updates::check(&r.installer.client, env!("CARGO_PKG_VERSION")).await?
        )),
        _ => bail!("未知命令：{op}"),
    }
}
