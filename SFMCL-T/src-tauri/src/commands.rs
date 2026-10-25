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
        let jobs = Arc::new(Jobs::default());
        let accounts = Accounts::open(&directory, vault.clone(), settings.clone(), jobs.clone())?;
        let installer = Arc::new(Installer {
            downloads: downloads.clone(),
            jobs: jobs.clone(),
            client: sfmcl_t_core::http_client()?,
            settings: settings.clone(),
        });
        Ok(Self {
            settings,
            accounts,
            downloads,
            jobs,
            installer,
            community: Arc::new(Community::new(vault)?),
            modpacks: Arc::new(Modpacks::default()),
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
    match op{
        "bootstrap"=>Ok(json!({"settings":r.settings.get(),"players":r.accounts.list(),"dataDir":r.directory,"defaultDownloadCacheDir":r.directory.join("downloads").join("cache"),"backgroundPath":sfmcl_t_core::notices::background(&r.directory,&r.settings.get()),"version":env!("CARGO_PKG_VERSION")})),
        "notices.list"=>Ok(json!(sfmcl_t_core::notices::load(&r.directory)?)),
        "settings.save"=>{
            let mut settings = decode::<Settings>(p)?;
            settings.download_cache_dir = settings.download_cache_dir.trim().into();
            settings.validate()?;
            let cache = settings.download_cache_directory(&r.directory);
            if settings.download_cache_dir != r.settings.get().download_cache_dir {
                prepare_cache_directory(&cache)?;
            }
            r.settings.save(settings)?;
            r.downloads.set_cache_directory(&cache)?;
            Ok(json!(r.settings.get()))
        },
        "settings.import"=>{
            let path=PathBuf::from(text(&p,"path")?);let data=std::fs::read(&path)?;if data.len()>8*1024*1024{bail!("配置文件过大");}
            let value:Value=serde_json::from_slice(&data)?;
            let base=path.parent().and_then(Path::parent).unwrap_or(Path::new("."));
            let settings=sfmcl_t_core::config::import_legacy(&value,base);settings.validate()?;
            let count=r.accounts.import_legacy(&value)?;
            let cache=settings.download_cache_directory(&r.directory);
            r.settings.save(settings)?;r.downloads.set_cache_directory(&cache)?;Ok(json!({"players":count}))
        },
        "system.memory"=>{
            let available_mb=tokio::task::spawn_blocking(java::available_memory_mb).await?;
            Ok(json!({"availableMb":available_mb}))
        },
        "java.discover"=>{
            let mut paths=r.settings.get().java_paths;
            if let Some(extra)=p.get("paths"){paths.extend(decode::<Vec<String>>(extra.clone())?);}
            Ok(json!(java::discover(&paths).await))
        },
        "java.list"=>{
            let paths=match p.get("paths"){Some(paths)=>decode::<Vec<String>>(paths.clone())?,None=>r.settings.get().java_paths};
            Ok(json!(java::inspect(&paths).await))
        },
        "java.paths.save"=>{
            let paths=decode::<Vec<String>>(p["paths"].clone())?;
            let root=p.get("versionId").map(|_|r.target_root(&p)).transpose()?;
            let version=match root.as_deref(){Some(root)=>Some((root,text(&p,"versionId")?)),None=>None};
            Ok(json!(java::save_paths(&r.settings,version,paths,p["removedPath"].as_str())?))
        },
        "java.probe"=>Ok(json!(java::probe(text(&p,"path")?).await?)),
        "players.list"=>Ok(json!(r.accounts.list())),
        "players.add"=>Ok(json!(r.accounts.add_offline(text(&p,"name")?)?)),
        "players.select"=>{r.accounts.select(text(&p,"id")?)?;Ok(json!(true))},
        "players.remove"=>{r.accounts.remove(text(&p,"id")?)?;Ok(json!(true))},
        "players.rename"=>Ok(json!(r.accounts.rename(text(&p,"id")?,text(&p,"name")?)?)),
        "players.skin"=>Ok(json!(r.accounts.skin(text(&p,"id")?,p["path"].as_str().filter(|s|!s.is_empty()).map(Path::new),p["slim"].as_bool().unwrap_or(false))?)),
        "players.login"=>Ok(json!(r.accounts.begin_login().await?)),
        "players.refresh"=>Ok(json!(r.accounts.refresh(text(&p,"id")?).await?)),
        "versions.list"=>{
            let settings=r.settings.get();
            Ok(json!(tokio::task::spawn_blocking(move|| version_entries(&settings,&p)).await??))
        },
        "versions.settings.get"=>Ok(json!(version_settings::load(&r.target_root(&p)?,text(&p,"id")?,&r.settings.get())?)),
        "versions.favorites"=>{
            let settings=r.settings.get();
            Ok(json!(tokio::task::spawn_blocking(move|| favorite_entries(&settings)).await??))
        },
        "versions.settings.save"=>{
            let value=decode::<version_settings::VersionSettings>(p["config"].clone())?;
            version_settings::save(&r.target_root(&p)?,text(&p,"id")?,&value)?;Ok(json!(value))
        },
        "versions.detail"=>versions::resolve(&r.target_root(&p)?,text(&p,"id")?),
        "versions.select"=>{
            let id=text(&p,"id")?;let settings=r.settings.get();
            let directory=p["directory"].as_str().unwrap_or(&settings.active_dir);
            let root=settings.registered_game_root(Path::new(directory))?;
            versions::resolve(&root,id)?;
            r.settings.update(|s|{s.active_dir=directory.into();s.active_version=id.into();})?;
            Ok(json!(true))
        },
        "versions.favorite"=>{let favorite=p["favorite"].as_bool().context("缺少收藏状态")?;versions::set_favorite(&r.target_root(&p)?,text(&p,"id")?,favorite)?;Ok(json!(true))},
        "versions.rename"=>{let id=text(&p,"id")?;let new_id=text(&p,"name")?;let root=r.target_root(&p)?;versions::rename(&root,id,new_id)?;r.settings.update(|s|{if s.active_version==id&&minecraft_root(Path::new(&s.active_dir))==root{s.active_version=new_id.into();}})?;Ok(json!(true))},
        "versions.icon"=>{let id=text(&p,"id")?;let target=safe_join(&r.target_root(&p)?,format!("versions/{id}/icon.png"))?;
            if let Some(path)=p["path"].as_str(){let bytes=std::fs::read(path)?;if bytes.len()>8*1024*1024||!bytes.starts_with(b"\x89PNG"){bail!("请选择不超过 8 MB 的 PNG 图标");}atomic_write(&target,&bytes)?;}else if target.exists(){std::fs::remove_file(target)?;}Ok(json!(true))},
        "versions.delete"=>{
            let root=r.target_root(&p)?;let id=text(&p,"id")?;
            for entry in versions::scan(&root)?{if entry.id!=id{let v=versions::resolve(&root,&entry.id)?;if v["inheritsFrom"].as_str()==Some(id)||v["jar"].as_str()==Some(id){bail!("版本 {} 依赖此版本，无法删除",entry.id);}}}
            let target=safe_join(&root,format!("versions/{id}"))?;if !target.is_dir(){bail!("版本不存在");}
            let lockpath=safe_join(&root,format!(".tmcl/locks/launch-{id}.lock"))?;
            if lockpath.exists(){let lock=std::fs::OpenOptions::new().read(true).write(true).open(lockpath)?;lock.try_lock().context("游戏正在运行，无法删除")?;std::fs::remove_dir_all(&target)?;}else{std::fs::remove_dir_all(&target)?;}
            r.settings.update(|s|{if s.active_version==id&&minecraft_root(Path::new(&s.active_dir))==root{s.active_version.clear();}})?;Ok(json!(true))
        },
        "versions.repair"=>{
            let root=r.target_root(&p)?;let id=text(&p,"id")?.to_owned();let job=r.jobs.create(JobKind::Repair,format!("修复 {id}"),&["解析版本","解析资源","补全文件","提取 native"]);let job_id=job.snapshot().id;let installer=r.installer.clone();
            tokio::spawn(async move{let result=installer.repair(&root,&id,job.clone()).await;job.finish(&result);});Ok(json!(job_id))
        },
        "manifest"=>r.installer.manifest().await,
        "loaders"=>Ok(json!(loaders::catalog(&r.installer.client,text(&p,"minecraft")?,text(&p,"kind")?).await?)),
        "install"=>{let mut request:InstallRequest=decode(p)?;request.root=r.settings.get().registered_game_root(&request.root)?;Ok(json!(r.installer.start(request).await?))},
        "launch"=>{
            let s=r.settings.get();
            if p["id"].as_str().is_some_and(|id| id!=s.active_version)
                || p["directory"].as_str().is_some_and(|directory| directory!=s.active_dir) {
                bail!("游戏目录或版本已切换，请重新选择收藏版本");
            }
            let player=r.accounts.launch_identity(&s.active_player).await?;
            Ok(json!(r.installer.launch(s.active_version,player).await?))
        },
        "tasks"=>{
            let snapshots=r.downloads.snapshots().await;let summaries:Vec<_>=snapshots.into_iter().map(|s|{
                let total:u64=s.files.iter().map(|f|f.total.unwrap_or(0)).sum();let unknown=s.files.iter().any(|f|f.total.is_none());let downloaded=s.downloaded();let completed=s.completed();let failed=s.files.iter().filter(|f|f.status==Status::Failed).count();
                json!({"id":s.id,"title":s.title,"status":s.status,"downloaded":downloaded,"total":total,"unknownSize":unknown,"completed":completed,"failed":failed,"fileCount":s.files.len(),"speed":s.bytes_per_second,"workers":s.active_workers,"steps":s.steps,"error":s.error})
            }).collect();Ok(json!({"downloads":summaries,"jobs":r.jobs.snapshots()}))
        },
        "downloads.files"=>{let s=r.downloads.snapshot(text(&p,"id")?).await?;let offset=p["offset"].as_u64().unwrap_or(0) as usize;let mut files=s.files;files.sort_by_key(|f|match f.status{Status::Failed=>0,Status::Running=>1,_=>2});Ok(json!(files.into_iter().skip(offset).take(100).collect::<Vec<_>>()))},
        "downloads.control"=>{let id=text(&p,"id")?;match text(&p,"action")?{"pause"=>r.downloads.pause(id).await?,"resume"|"retry"=>r.downloads.resume(id).await?,"cancel"=>r.downloads.cancel(id).await?,"clear"=>r.downloads.clear(id).await?,_=>bail!("未知下载操作")};Ok(json!(true))},
        "jobs.cancel"=>{r.jobs.cancel(text(&p,"id")?)?;Ok(json!(true))},
        "resources.local"=>{let root=r.resource_root(&p)?;let kind=text(&p,"kind")?.to_owned();Ok(json!(tokio::task::spawn_blocking(move||local::scan(&root,&kind)).await??))},
        "resources.localSize"=>{let root=r.resource_root(&p)?;let kind=text(&p,"kind")?.to_owned();let path=PathBuf::from(text(&p,"path")?);let relative=path.strip_prefix(&root)?.to_string_lossy().into_owned();Ok(json!(tokio::task::spawn_blocking(move||local::directory_size(&root,&relative,&kind)).await??))},
        "resources.localProject"=>{let root=r.resource_root(&p)?;let path=PathBuf::from(text(&p,"path")?);Ok(json!(r.community.local_project(text(&p,"source")?,&root,&path).await?))},
        "resources.toggle"=>{let root=r.resource_root(&p)?;let path=PathBuf::from(text(&p,"path")?);Ok(json!(local::toggle_mod(&root,&path.strip_prefix(&root)?.to_string_lossy(),p["disabled"].as_bool().unwrap_or(false))?))},
        "resources.deletePack"=>{let root=r.resource_root(&p)?;let path=PathBuf::from(text(&p,"path")?);local::delete_pack(&root,&path.strip_prefix(&root)?.to_string_lossy())?;Ok(json!(true))},
        "resources.search"=>Ok(json!(r.community.search(&decode(p)?).await?)),
        "resources.detail"=>Ok(json!(r.community.detail(text(&p,"source")?,text(&p,"id")?).await?)),
        "resources.files"=>Ok(json!(r.community.files(text(&p,"source")?,text(&p,"id")?,p["gameVersion"].as_str().unwrap_or(""),p["loader"].as_str().unwrap_or("")).await?)),
        "resources.categories"=>r.community.categories(text(&p,"source")?,text(&p,"kind")?).await,
        "modpacks.inspect"=>{
            let path=PathBuf::from(text(&p,"path")?);let modpacks=r.modpacks.clone();
            Ok(json!(tokio::task::spawn_blocking(move||modpacks.inspect(&path)).await??))
        },
        "modpacks.discard"=>{r.modpacks.discard(text(&p,"token")?);Ok(json!(true))},
        "modpacks.supplyFile"=>{
            let id=text(&p,"id")?;
            if !r.jobs.snapshots().iter().any(|job|job.download_id.as_deref()==Some(id)&&job.title.starts_with("安装整合包 ")&&!matches!(job.status,Status::Completed|Status::Cancelled)){bail!("此下载不属于正在安装的整合包");}
            let snapshot=r.downloads.snapshot(id).await?;
            if snapshot.retention!=sfmcl_t_core::downloads::DownloadRetention::Session{bail!("此下载不支持补选整合包文件");}
            r.downloads.supply_file(id,text(&p,"path")?,Path::new(text(&p,"source")?)).await?;
            Ok(json!(true))
        },
        "modpacks.install"=>{
            let mut request:ModpackRequest=decode(p)?;request.root=r.settings.get().registered_game_root(&request.root)?;
            let resolver:UrlResolver=Arc::new(move|url|{let app=app.clone();Box::pin(async move{crate::curseforge_download::resolve(&app,&url).await})});
            Ok(json!(r.modpacks.start(request,r.installer.clone(),r.community.clone(),resolver).await?))
        },
        "resources.download"=>{
            let kind=text(&p,"kind")?;let folder=sfmcl_t_core::resources::download::installation_folder(kind)?;
            let mut spec:sfmcl_t_core::downloads::DownloadSpec=decode(p["file"].clone())?;sfmcl_t_core::paths::valid_name(&spec.path)?;
            let root=if let Some(directory)=p.get("directory") {
                if p.get("versionId").is_some(){bail!("请选择一种下载方式");}
                let (root,file)=sfmcl_t_core::resources::download::folder_destination(Path::new(directory.as_str().context("下载文件夹无效")?),spec)?;
                spec=file;
                root
            }else{
                let folder=folder.context("此资源需要下载到文件夹；整合包请选择新建实例安装")?;
                let root=r.root()?;let game=r.resource_root(&p)?;
                spec.path=game.join(folder).join(&spec.path).strip_prefix(&root)?.to_string_lossy().into_owned();
                root
            };
            spec.url=crate::curseforge_download::resolve(&app,&spec.url).await?;
            Ok(json!(r.downloads.enqueue(p["title"].as_str().unwrap_or("资源下载").into(),root,vec![spec]).await?))
        },
        "image"=>{
            let source=text(&p,"path")?;
            let bytes=if source.to_ascii_lowercase().starts_with("http://") || source.to_ascii_lowercase().starts_with("https://") {
                r.accounts.texture_image(source).await?
            } else {
                let path=PathBuf::from(source);r.allowed_path(&path)?;if std::fs::metadata(&path)?.len()>8*1024*1024{bail!("图片超过 8 MB");}
                std::fs::read(&path)?
            };
            let mime=if bytes.starts_with(b"\x89PNG"){"image/png"}else if bytes.starts_with(&[0xff,0xd8]){"image/jpeg"}else{bail!("不支持的图片格式");};Ok(json!(format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes))))
        },
        "downloads.cache.open"=>{
            let requested=text(&p,"path")?.trim();
            let path=if requested.is_empty(){r.directory.join("downloads").join("cache")}else{PathBuf::from(requested)};
            if !path.is_absolute(){bail!("下载缓存文件夹必须是绝对路径");}
            // Open the directory currently shown in settings, including unsaved
            // selections. Creating it also rejects paths pointing to a file.
            std::fs::create_dir_all(&path).context("无法打开下载缓存文件夹")?;
            app.opener().open_path(path.to_string_lossy(),None::<&str>)?;
            Ok(json!(true))
        },
        "path.open"=>{
            let path=PathBuf::from(text(&p,"path")?);
            r.allowed_path(&path)?;
            if p["reveal"].as_bool().unwrap_or(false) {
                if !path.is_file(){bail!("资源文件不存在，请刷新本地资源列表");}
                app.opener().reveal_item_in_dir(&path)?;
            } else {
                if !path.exists(){std::fs::create_dir_all(&path)?;}
                app.opener().open_path(path.to_string_lossy(),None::<&str>)?;
            }
            Ok(json!(true))
        },
        "updates"=>Ok(sfmcl_t_core::http_client()?.get("https://api.github.com/repos/Turing158/StarFall-Minecraft-Launcher/releases/latest").send().await?.error_for_status()?.json::<Value>().await?),
        _=>bail!("未知命令：{op}"),
    }
}
