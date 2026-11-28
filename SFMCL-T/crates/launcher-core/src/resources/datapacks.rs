use crate::{
    config::{ConfigStore, Settings},
    downloads::{DownloadManager, DownloadSpec},
    jobs::{self, JobKind, Jobs},
    minecraft::version_settings,
    paths::{atomic_write, safe_join, valid_name},
    resources::{install, local, modpacks::UrlResolver},
};
use anyhow::{bail, Context, Result};
use fastnbt::Value;
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

const LEVEL_LIMIT: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldSelection {
    pub directory: PathBuf,
    pub version_id: String,
    pub world_id: String,
}

pub struct Target {
    selection: WorldSelection,
    game: PathBuf,
    world: PathBuf,
    identity: same_file::Handle,
}

impl Target {
    pub fn resolve(settings: &Settings, selection: WorldSelection) -> Result<Self> {
        let (game, world) = resolve_world(settings, &selection)?;
        let identity = same_file::Handle::from_path(&world)?;
        Ok(Self {
            selection,
            game,
            world,
            identity,
        })
    }

    fn check(&self, settings: &Settings) -> Result<()> {
        let (game, world) =
            resolve_world(settings, &self.selection).context("存档或游戏版本已变化，请重新选择")?;
        if game != self.game
            || world != self.world
            || same_file::Handle::from_path(&world)? != self.identity
        {
            bail!("存档或游戏版本已变化，请重新选择");
        }
        Ok(())
    }

    pub fn folder(&self) -> Result<PathBuf> {
        let folder = safe_join(&self.world, "datapacks")?;
        if folder.exists() && !folder.is_dir() {
            bail!("存档的 datapacks 路径不是文件夹");
        }
        Ok(folder)
    }

    pub fn open_folder(&self, settings: &Settings, jobs: &Jobs) -> Result<PathBuf> {
        let folder = self.folder()?;
        if !folder.is_dir() {
            self.check(settings)?;
            let _game = install::mod_edit_guard(&self.game, jobs)?;
            self.check(settings)?;
            let _world = lock_world(&self.world)?;
            fs::create_dir_all(self.folder()?)?;
        }
        Ok(folder)
    }
}

fn resolve_world(settings: &Settings, selection: &WorldSelection) -> Result<(PathBuf, PathBuf)> {
    valid_name(&selection.world_id)?;
    let root = settings.registered_game_root(&selection.directory)?;
    let effective = version_settings::resolve(&root, &selection.version_id, settings)?;
    let game = local::version_root(&root, &selection.version_id, effective.isolation)?;
    let world = safe_join(&game, Path::new("saves").join(&selection.world_id))?;
    if !world.is_dir() || !safe_join(&world, "level.dat")?.is_file() {
        bail!("存档不存在，请重新选择");
    }
    Ok((game, world))
}

fn lock_world(world: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(safe_join(world, "session.lock")?)
        .context("无法打开存档锁，请检查文件权限")?;
    file.try_lock()
        .context("存档正在使用，请退出该世界后再操作")?;
    #[cfg(unix)]
    {
        // Java NIO uses POSIX record locks. Rust's Unix File lock also keeps
        // concurrent launcher edits apart when they share a process.
        use std::os::fd::AsRawFd;
        let mut lock: libc::flock = unsafe { std::mem::zeroed() };
        lock.l_type = libc::F_WRLCK as _;
        lock.l_whence = libc::SEEK_SET as _;
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &lock) } == -1 {
            return Err(io::Error::last_os_error()).context("存档正在使用，请退出该世界后再操作");
        }
    }
    Ok(file)
}

type Compound = HashMap<String, Value>;
struct LevelData {
    file: PathBuf,
    original: Vec<u8>,
    root: Compound,
    root_name: Vec<u8>,
    gzip: bool,
}

impl LevelData {
    fn read(world: &Path) -> Result<Self> {
        let file = safe_join(world, "level.dat")?;
        let original = bounded_read(File::open(&file)?)?;
        let gzip = original.starts_with(&[0x1f, 0x8b]);
        let inflated;
        let nbt = if gzip {
            inflated = bounded_read(GzDecoder::new(original.as_slice()))?;
            &inflated
        } else {
            &original
        };
        let header = nbt.get(..3).context("level.dat 缺少有效的 NBT 根标签")?;
        if header[0] != 10 {
            bail!("level.dat 缺少有效的 NBT 根标签");
        }
        let root_name_end = 3 + u16::from_be_bytes([header[1], header[2]]) as usize;
        let root_name = nbt
            .get(1..root_name_end)
            .context("NBT 根标签名称无效")?
            .to_vec();
        let root: Compound = fastnbt::from_bytes(nbt).context("level.dat 无法解析")?;
        if !matches!(root.get("Data"), Some(Value::Compound(_))) {
            bail!("level.dat 缺少有效的 Data 元数据");
        }
        Ok(Self {
            file,
            original,
            root,
            root_name,
            gzip,
        })
    }

    fn statuses(&self) -> Result<(&[Value], &[Value])> {
        let Some(Value::Compound(data)) = self.root.get("Data") else {
            bail!("level.dat 缺少有效的 Data 元数据");
        };
        let config = match data.get("DataPacks") {
            Some(Value::Compound(config)) => config,
            None => return Ok((&[], &[])),
            _ => bail!("level.dat 的数据包配置无效"),
        };
        Ok((
            pack_list(config, "Enabled")?,
            pack_list(config, "Disabled")?,
        ))
    }

    fn set(&mut self, id: &Value, status: Option<PackState>) -> Result<bool> {
        let (enabled, disabled) = self.statuses()?;
        if status.is_none() && !enabled.contains(id) && !disabled.contains(id) {
            return Ok(false);
        }
        let Some(Value::Compound(data)) = self.root.get_mut("Data") else {
            bail!("level.dat 缺少有效的 Data 元数据");
        };
        let Value::Compound(config) = data.entry("DataPacks".into()).or_insert_with(|| {
            Value::Compound(HashMap::from([
                (
                    "Enabled".into(),
                    Value::List(vec![Value::String("vanilla".into())]),
                ),
                ("Disabled".into(), Value::List(Vec::new())),
            ]))
        }) else {
            bail!("level.dat 的数据包配置无效");
        };
        let mut changed = false;
        for (key, target) in [
            ("Enabled", PackState::Enabled),
            ("Disabled", PackState::Disabled),
        ] {
            let Value::List(list) = config
                .entry(key.into())
                .or_insert_with(|| Value::List(Vec::new()))
            else {
                bail!("level.dat 的数据包列表无效");
            };
            if status == Some(target) {
                if !list.contains(id) {
                    list.push(id.clone());
                    changed = true;
                }
            } else {
                let length = list.len();
                list.retain(|entry| entry != id);
                changed |= list.len() != length;
            }
        }
        Ok(changed)
    }

    fn write(&self, world: &Path) -> Result<()> {
        let nbt = fastnbt::to_bytes(&self.root)?;
        // fastnbt writes an empty root name. Keep the original root header,
        // including its raw modified UTF-8 name.
        let mut output = Vec::with_capacity(nbt.len() + self.root_name.len());
        output.push(nbt[0]);
        output.extend_from_slice(&self.root_name);
        output.extend_from_slice(&nbt[3..]);
        let output = if self.gzip {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(&output)?;
            encoder.finish()?
        } else {
            output
        };
        let backup = safe_join(world, ".tmcl/level.dat.datapacks.bak")?;
        atomic_write(&backup, &self.original).context("备份 level.dat 失败")?;
        atomic_write(&self.file, &output).context("写入 level.dat 失败")
    }
}

fn bounded_read(reader: impl Read) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(LEVEL_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LEVEL_LIMIT {
        bail!("存档元数据过大");
    }
    Ok(bytes)
}

fn pack_list<'a>(config: &'a Compound, key: &str) -> Result<&'a [Value]> {
    match config.get(key) {
        Some(Value::List(list)) if list.iter().all(|v| matches!(v, Value::String(_))) => Ok(list),
        None => Ok(&[]),
        _ => bail!("level.dat 的数据包列表无效"),
    }
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum PackState {
    Enabled,
    Disabled,
    Pending,
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    name: String,
    description: String,
    directory: bool,
    state: PackState,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    packs: Vec<Pack>,
    state_error: Option<String>,
}

fn is_zip(path: &Path) -> bool {
    path.extension()
        .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
}

fn zip_name(name: &str) -> Result<()> {
    valid_name(name)?;
    if !is_zip(Path::new(name)) {
        bail!("请选择 ZIP 格式的数据包");
    }
    Ok(())
}

fn pack_description(path: &Path, directory: bool) -> Result<String> {
    let bytes = if directory {
        let mut bytes = Vec::new();
        File::open(safe_join(path, "pack.mcmeta")?)?
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 4 * 1024 * 1024 {
            bail!("pack.mcmeta 过大");
        }
        bytes
    } else {
        let mut archive = zip::ZipArchive::new(File::open(path)?)?;
        local::read_entry(&mut archive, "pack.mcmeta").context("ZIP 根目录缺少 pack.mcmeta")?
    };
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).context("pack.mcmeta 无法解析")?;
    let metadata = &value["pack"];
    let has_version = metadata["pack_format"].is_u64()
        || ["min_format", "max_format"].iter().all(|key| {
            let value = &metadata[*key];
            value.is_u64()
                || value.as_array().is_some_and(|parts| {
                    (1..=2).contains(&parts.len()) && parts.iter().all(|part| part.is_u64())
                })
        });
    if !has_version || metadata["description"].is_null() {
        bail!("pack.mcmeta 缺少数据包格式或说明");
    }
    Ok(local::plain_text(&metadata["description"]))
}

fn pack_id(name: &str) -> Value {
    Value::String(format!("file/{name}"))
}

pub fn list(target: &Target) -> Result<Inventory> {
    let folder = target.folder()?;
    let level = LevelData::read(&target.world);
    let states = match &level {
        Ok(level) => level.statuses(),
        Err(error) => Err(anyhow::anyhow!("{error:#}")),
    };
    let state_error = states.as_ref().err().map(|error| format!("{error:#}"));
    let mut packs = Vec::new();
    if folder.is_dir() {
        for entry in fs::read_dir(&folder)? {
            let entry = entry?;
            let Some(name) = entry.file_name().into_string().ok() else {
                continue;
            };
            let Ok(path) = safe_join(&folder, &name) else {
                continue;
            };
            let kind = entry.file_type()?;
            let directory = kind.is_dir();
            if !(directory || (kind.is_file() && is_zip(&path))) {
                continue;
            }
            // Plain folders and launcher/OS metadata are not Minecraft packs.
            if directory && !path.join("pack.mcmeta").exists() {
                continue;
            }
            let id = pack_id(&name);
            let state = match &states {
                Ok((enabled, _)) if enabled.contains(&id) => PackState::Enabled,
                Ok((_, disabled)) if disabled.contains(&id) => PackState::Disabled,
                Ok(_) => PackState::Pending,
                Err(_) => PackState::Unknown,
            };
            let (description, error) = match pack_description(&path, directory) {
                Ok(description) => (description, None),
                Err(error) => (String::new(), Some(format!("{error:#}"))),
            };
            packs.push(Pack {
                name,
                description,
                directory,
                state,
                error,
            });
        }
    }
    packs.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.name.cmp(&b.name))
    });
    Ok(Inventory { packs, state_error })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Edit {
    Enable,
    Disable,
    Delete,
}

pub fn edit(
    target: &Target,
    settings: &Settings,
    jobs: &Jobs,
    name: &str,
    operation: Edit,
) -> Result<()> {
    valid_name(name)?;
    target.check(settings)?;
    let _game = install::mod_edit_guard(&target.game, jobs)?;
    target.check(settings)?;
    let _world = lock_world(&target.world)?;
    let folder = target.folder()?;
    let path = safe_join(&folder, name)?;
    if !fs::read_dir(&folder)?.any(|entry| entry.is_ok_and(|entry| entry.file_name() == name))
        || !(path.is_dir() && path.join("pack.mcmeta").is_file() || path.is_file() && is_zip(&path))
    {
        bail!("数据包不存在，请刷新存档详情");
    }
    let mut level = LevelData::read(&target.world)?;
    let id = pack_id(name);
    if matches!(operation, Edit::Delete) {
        let trash = tempfile::Builder::new()
            .prefix("datapack-")
            .tempdir_in(&target.world)?;
        let destination = trash.path().join(name);
        let changed = level.set(&id, None)?;
        if changed {
            level.write(&target.world)?;
        }
        if let Err(error) = fs::rename(&path, destination) {
            if changed {
                atomic_write(&level.file, &level.original)
                    .context("删除失败，恢复 level.dat 失败，请从 .tmcl 备份恢复")?;
            }
            return Err(error).context("删除数据包失败");
        }
        return Ok(());
    }
    let status = if matches!(operation, Edit::Enable) {
        pack_description(&path, path.is_dir())?;
        PackState::Enabled
    } else {
        PackState::Disabled
    };
    if level.set(&id, Some(status))? {
        level.write(&target.world)?;
    }
    Ok(())
}

fn same_contents(source: &Path, destination: &Path) -> Result<bool> {
    let mut a = File::open(source)?;
    let mut b = File::open(destination)?;
    if a.metadata()?.len() != b.metadata()?.len() {
        return Ok(false);
    }
    let mut first = Sha256::new();
    let mut second = Sha256::new();
    io::copy(&mut a, &mut first)?;
    io::copy(&mut b, &mut second)?;
    Ok(first.finalize() == second.finalize())
}

pub fn install_file(
    target: &Target,
    settings: &ConfigStore,
    jobs: &Jobs,
    source: &Path,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<bool> {
    if !source.is_absolute() || !source.is_file() {
        bail!("请选择存在的数据包 ZIP 文件");
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .context("数据包文件名无效")?;
    zip_name(name)?;
    target.check(&settings.get())?;
    let _game = install::mod_edit_guard(&target.game, jobs)?;
    target.check(&settings.get())?;
    let _world = lock_world(&target.world)?;
    LevelData::read(&target.world)?.statuses()?;
    // Keep staging outside datapacks so Minecraft never observes partial ZIPs.
    let mut temporary = tempfile::NamedTempFile::new_in(&target.world)?;
    io::copy(&mut File::open(source)?, temporary.as_file_mut())?;
    temporary.as_file().sync_all()?;
    pack_description(temporary.path(), false)?;
    target.check(&settings.get())?;
    if cancel.is_cancelled() {
        bail!("安装已取消");
    }
    let folder = target.folder()?;
    let destination = safe_join(&folder, name)?;
    if destination.exists() {
        if destination.is_file() && same_contents(temporary.path(), &destination)? {
            return Ok(false);
        }
        bail!("存档中已有同名数据包：{name}");
    }
    fs::create_dir_all(&folder)?;
    temporary
        .persist_noclobber(&destination)
        .context("写入数据包失败，请检查同名文件和目录权限")?;
    Ok(true)
}

pub fn enqueue(
    target: Target,
    mut file: DownloadSpec,
    title: String,
    work_root: &Path,
    resolver: UrlResolver,
    downloads: Arc<DownloadManager>,
    jobs: Arc<Jobs>,
    settings: Arc<ConfigStore>,
) -> Result<String> {
    zip_name(&file.path)?;
    let work = tempfile::Builder::new()
        .prefix("datapack-")
        .tempdir_in(work_root)?;
    let job = jobs.create(JobKind::Install, title, &["下载数据包", "校验并安装到存档"]);
    job.set_datapack_world(target.world.clone());
    let job_id = job.snapshot().id;
    tokio::spawn(async move {
        let mut session = None;
        let result = async {
            let source = safe_join(work.path(), &file.path)?;
            job.step(0, "下载到临时目录");
            file.url = tokio::select! {
                resolved = resolver(file.url) => resolved?,
                _ = job.cancel.cancelled() => bail!("安装已取消"),
            };
            let downloaded = jobs::download_session(
                &downloads,
                &job,
                job.snapshot().title,
                work.path().into(),
                vec![file],
            )
            .await;
            session = job.snapshot().download_id;
            downloaded?;
            job.step(1, "检查存档和数据包");
            let cancel = job.cancel.clone();
            let install_jobs = jobs.clone();
            let installed = tokio::task::spawn_blocking(move || {
                install_file(&target, &settings, &install_jobs, &source, &cancel)
            })
            .await??;
            job.step(
                1,
                if installed {
                    "数据包已安装"
                } else {
                    "存档已包含相同文件"
                },
            );
            Ok(())
        }
        .await;
        if let Some(download) = session {
            let _ = downloads.cancel(&download).await;
            let _ = downloads.clear(&download).await;
        }
        job.detach_download();
        drop(work);
        job.finish(&result);
    });
    Ok(job_id)
}

#[cfg(test)]
mod tests;
