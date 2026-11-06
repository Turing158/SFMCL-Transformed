use super::{
    absolute_path, conventional_path, path_key, reject_links, validate_destination, OperationKind,
    PROFILE_LOCK,
};
use crate::{accounts::Player, config::Settings, paths::atomic_write, vault::Vault};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const MANIFEST: &str = "sfmcl-t-backup.json";
const FORMAT: &str = "SFMCL-T-local-data";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub source_dir: PathBuf,
    pub created_at: u64,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    version: u32,
    source_dir: PathBuf,
    created_at: u64,
    directories: Vec<String>,
    files: Vec<Entry>,
}
#[derive(Serialize, Deserialize)]
struct Entry {
    path: String,
    size: u64,
    sha256: String,
}

pub(crate) fn collect(root: &Path) -> Result<(Vec<String>, Vec<(String, PathBuf)>)> {
    reject_links(root)?;
    fn visit(
        root: &Path,
        directory: &Path,
        dirs: &mut Vec<String>,
        files: &mut Vec<(String, PathBuf)>,
    ) -> Result<()> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            reject_links(&path)?;
            let relative = path
                .strip_prefix(root)?
                .to_str()
                .context("文件名无法编码")?
                .replace('\\', "/");
            if relative == PROFILE_LOCK {
                continue;
            }
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.is_dir() {
                dirs.push(relative);
                visit(root, &path, dirs, files)?;
            } else if metadata.is_file() {
                files.push((relative, path));
            } else {
                bail!("本地数据包含不支持的文件：{}", path.display());
            }
        }
        Ok(())
    }
    let (mut dirs, mut files) = (vec![], vec![]);
    visit(root, root, &mut dirs, &mut files)?;
    dirs.sort();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((dirs, files))
}

pub(crate) fn copy_hashed(mut input: impl Read, mut output: impl Write) -> Result<(u64, String)> {
    let mut hash = Sha256::new();
    let mut total = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let size = input.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        output.write_all(&buffer[..size])?;
        hash.update(&buffer[..size]);
        total += size as u64;
    }
    Ok((total, hex::encode(hash.finalize())))
}

pub fn backup(source: &Path, destination: &Path) -> Result<BackupInfo> {
    let source = absolute_path(source)?;
    let destination = validate_destination(&source, destination, OperationKind::Backup)?;
    validate_profile(&source)?;
    let (directories, files) = collect(&source)?;
    let temp =
        tempfile::NamedTempFile::new_in(destination.parent().context("无效的备份保存位置")?)?;
    let mut archive = ZipWriter::new(temp.reopen()?);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut manifest = Manifest {
        format: FORMAT.into(),
        version: 1,
        source_dir: source,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs(),
        directories,
        files: vec![],
    };
    for (relative, path) in files {
        archive.start_file(format!("data/{relative}"), options)?;
        let (size, sha256) = copy_hashed(File::open(path)?, &mut archive)?;
        manifest.files.push(Entry {
            path: relative,
            size,
            sha256,
        });
    }
    archive.start_file(MANIFEST, options)?;
    archive.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
    archive.finish()?.sync_all()?;
    // Read back every entry before replacing an existing backup file.
    let info = inspect_backup(temp.path())?;
    reject_links(&destination)?;
    temp.persist(&destination)
        .map_err(|error| error.error)
        .context("无法保存备份文件")?;
    Ok(info)
}

fn relative_path(value: &str) -> Result<PathBuf> {
    if value.is_empty()
        || value.contains('\\')
        || value.contains(':')
        || value.starts_with('/')
        || value == PROFILE_LOCK
    {
        bail!("备份包含无效的文件路径");
    }
    let path = PathBuf::from(value);
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
        || path
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
            != value
    {
        bail!("备份包含越界文件路径");
    }
    for part in value.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.ends_with([' ', '.'])
            || part
                .chars()
                .any(|ch| ch.is_control() || "<>\"|?*".contains(ch))
            || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit())
        {
            bail!("备份包含不支持的文件名");
        }
    }
    Ok(path)
}

fn read_manifest(archive: &mut ZipArchive<File>) -> Result<Manifest> {
    let file = archive
        .by_name(MANIFEST)
        .context("不是 SFMCL-T 本地数据备份")?;
    if file.size() > 16 * 1024 * 1024 {
        bail!("备份索引过大");
    }
    let manifest: Manifest = serde_json::from_reader(file).context("备份索引损坏")?;
    if manifest.format != FORMAT || manifest.version != 1 || !manifest.source_dir.is_absolute() {
        bail!("不支持此备份格式或版本");
    }
    let mut names = HashSet::new();
    for name in manifest
        .directories
        .iter()
        .chain(manifest.files.iter().map(|entry| &entry.path))
    {
        relative_path(name)?;
        if !names.insert(path_key(Path::new(name))) {
            bail!("备份包含重复路径");
        }
    }
    if archive.len() != manifest.files.len() + 1 {
        bail!("备份文件清单不匹配");
    }
    Ok(manifest)
}

fn read_backup(path: &Path, output: Option<&Path>) -> Result<BackupInfo> {
    reject_links(path)?;
    let mut archive = ZipArchive::new(File::open(path)?).context("无法读取 ZIP 备份文件")?;
    let manifest = read_manifest(&mut archive)?;
    if let Some(root) = output {
        for directory in &manifest.directories {
            fs::create_dir_all(root.join(relative_path(directory)?))?;
        }
    }
    let mut total_bytes = 0u64;
    for entry in &manifest.files {
        let relative = relative_path(&entry.path)?;
        let mut file = archive
            .by_name(&format!("data/{}", entry.path))
            .context("备份缺少文件")?;
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
            || file.is_dir()
            || file.size() != entry.size
        {
            bail!("备份文件信息不一致：{}", entry.path);
        }
        let (size, hash) = if let Some(root) = output {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().context("无效的备份文件路径")?)?;
            let mut target = File::create(&path)?;
            let digest = copy_hashed(&mut file, &mut target)?;
            target.sync_all()?;
            digest
        } else {
            copy_hashed(&mut file, std::io::sink())?
        };
        if size != entry.size || hash != entry.sha256 {
            bail!("备份校验失败：{}", entry.path);
        }
        total_bytes = total_bytes.checked_add(size).context("备份数据量溢出")?;
    }
    Ok(BackupInfo {
        source_dir: manifest.source_dir,
        created_at: manifest.created_at,
        file_count: manifest.files.len(),
        total_bytes,
    })
}

pub fn inspect_backup(path: &Path) -> Result<BackupInfo> {
    read_backup(path, None)
}
pub(crate) fn extract(path: &Path, output: &Path) -> Result<BackupInfo> {
    read_backup(path, Some(output))
}

pub(crate) fn validate_profile(root: &Path) -> Result<()> {
    for name in ["settings.json", "players.json", "credentials.dat"] {
        reject_links(&root.join(name))?;
    }
    let settings = root.join("settings.json");
    if !settings.is_file() {
        bail!("本地数据缺少 settings.json，无法验证启动器配置");
    }
    {
        let settings: Settings =
            serde_json::from_slice(&fs::read(settings)?).context("备份中的启动器设置损坏")?;
        settings.validate()?;
    }
    let players = root.join("players.json");
    if players.exists() {
        let _: Vec<Player> =
            serde_json::from_slice(&fs::read(players)?).context("备份中的角色数据损坏")?;
    }
    // Detect credentials from a different Windows user before replacing a profile.
    Vault::open(root).context("无法读取本地数据中的账号凭据")?;
    Ok(())
}

pub(crate) fn remap_paths(root: &Path, source: &Path, destination: &Path) -> Result<()> {
    fn visit(value: &mut Value, source: &Path, destination: &Path) {
        match value {
            Value::String(value) => {
                let path = Path::new(value);
                let resolved = if path.is_absolute() {
                    path.ancestors()
                        .find(|ancestor| ancestor.exists())
                        .and_then(|ancestor| {
                            let base = fs::canonicalize(ancestor).ok()?;
                            let relative = path.strip_prefix(ancestor).ok()?;
                            let base = conventional_path(&base);
                            Some(if relative.as_os_str().is_empty() {
                                base
                            } else {
                                base.join(relative)
                            })
                        })
                } else {
                    None
                };
                let normalized = resolved
                    .as_deref()
                    .unwrap_or(path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let prefix = source.to_string_lossy().replace('\\', "/");
                let key = path_key(Path::new(&normalized));
                let source_key = path_key(Path::new(&prefix));
                if key == source_key || key.starts_with(&(source_key + "/")) {
                    let suffix = normalized[prefix.len()..].trim_start_matches('/');
                    *value = if suffix.is_empty() {
                        destination.to_path_buf()
                    } else {
                        destination.join(suffix)
                    }
                    .to_string_lossy()
                    .into_owned();
                }
            }
            Value::Array(values) => values
                .iter_mut()
                .for_each(|value| visit(value, source, destination)),
            Value::Object(values) => values
                .values_mut()
                .for_each(|value| visit(value, source, destination)),
            _ => {}
        }
    }
    let (_, files) = collect(root)?;
    for (_, path) in files {
        // WebView owns its own databases; preserve them byte-for-byte.
        if path.strip_prefix(root)?.starts_with("webview")
            || path.extension().is_none_or(|ext| ext != "json")
        {
            continue;
        }
        let bytes = fs::read(&path)?;
        if let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) {
            let previous = value.clone();
            visit(&mut value, source, destination);
            if value != previous {
                atomic_write(&path, &serde_json::to_vec_pretty(&value)?)?;
            }
        }
    }
    Ok(())
}
