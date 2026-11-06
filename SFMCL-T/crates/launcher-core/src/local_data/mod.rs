//! Profile relocation and verified backups. Transfers run after the UI exits.
mod archive;
mod transfer;

use crate::paths::atomic_write;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    path::{Component, Path, PathBuf},
};

pub use archive::{backup, inspect_backup, BackupInfo};
pub use transfer::{migrate, recover_restore, remove_original, restore};

pub const PROFILE_LOCK: &str = ".sfmcl-t-profile.lock";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OperationKind {
    Migrate,
    Backup,
    Restore,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub kind: OperationKind,
    pub success: bool,
    pub message: String,
    pub path: PathBuf,
    pub recovery_path: Option<PathBuf>,
}

/// Kept beside the default profile, so moving that profile cannot move its pointer.
pub fn control_directory(default: &Path) -> Result<PathBuf> {
    Ok(default
        .parent()
        .context("无法定位本地数据路径配置")?
        .join("SFMCL-T-data-locations"))
}

pub fn location_key(override_path: Option<&std::ffi::OsStr>) -> String {
    let value = override_path
        .map(|value| format!("override:{}", value.to_string_lossy()))
        .unwrap_or_else(|| "default".into());
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub fn resolve_directory(
    default: &Path,
    override_path: Option<std::ffi::OsString>,
) -> Result<PathBuf> {
    let control = control_directory(default)?;
    let _operation_lock = lock_control(&control)?;
    recover_restore(&control)?;
    let pointer = control.join(format!("{}.json", location_key(override_path.as_deref())));
    if pointer.exists() {
        reject_links(&pointer)?;
        let path: PathBuf = serde_json::from_slice(&fs::read(&pointer)?)
            .context("本地数据路径配置损坏，请保留该文件后修复")?;
        if !path.is_dir() {
            bail!(
                "本地数据目录无法访问：{}。请恢复该目录后重试。",
                path.display()
            );
        }
        return absolute_path(&path);
    }
    let path = crate::brand::data_directory(default, override_path);
    reject_links(&path)?;
    fs::create_dir_all(&path).context("无法创建本地数据目录")?;
    absolute_path(&path)
}

pub fn lock_control(control: &Path) -> Result<File> {
    reject_links(control)?;
    fs::create_dir_all(control)?;
    reject_links(control)?;
    let path = control.join("operation.lock");
    if path.exists() {
        reject_links(&path)?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    file.try_lock()
        .map_err(|_| anyhow::anyhow!("本地数据操作仍在进行，请稍后重新打开启动器"))?;
    Ok(file)
}

pub fn save_location(control: &Path, key: &str, directory: &Path) -> Result<()> {
    if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("无效的本地数据路径配置标识");
    }
    reject_links(control)?;
    fs::create_dir_all(control)?;
    atomic_write(
        &control.join(format!("{key}.json")),
        &serde_json::to_vec(directory)?,
    )
}

pub fn lock_profile(directory: &Path) -> Result<File> {
    reject_links(directory)?;
    let path = directory.join(PROFILE_LOCK);
    if path.exists() {
        reject_links(&path)?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)?;
    file.try_lock()
        .map_err(|_| anyhow::anyhow!("本地数据正在被另一个启动器使用，请先关闭该实例"))?;
    Ok(file)
}

pub fn absolute_path(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        bail!("请选择有效的绝对路径");
    }
    reject_links(path)?;
    let canonical = if path.exists() {
        fs::canonicalize(path)?
    } else {
        let parent = path.parent().context("请选择具体的文件或文件夹")?;
        fs::canonicalize(parent)?.join(path.file_name().context("无效的目标名称")?)
    };
    // Canonical Windows paths use an extended prefix; keep displayed/stored paths conventional.
    Ok(conventional_path(&canonical))
}

pub(crate) fn conventional_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    let value = if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()
    };
    PathBuf::from(value.as_ref() as &str)
}

pub(crate) fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

pub(crate) fn contains(root: &Path, path: &Path) -> bool {
    let root = path_key(root).trim_end_matches('/').to_owned();
    let path = path_key(path);
    path == root || path.starts_with(&(root + "/"))
}

pub fn validate_destination(
    source: &Path,
    destination: &Path,
    kind: OperationKind,
) -> Result<PathBuf> {
    let source = absolute_path(source)?;
    let destination = absolute_path(destination)?;
    if contains(&source, &destination) || contains(&destination, &source) {
        bail!("目标路径不能是当前本地数据目录、其子目录或父目录");
    }
    match kind {
        OperationKind::Migrate => {
            if destination.exists()
                && (!destination.is_dir() || fs::read_dir(&destination)?.next().is_some())
            {
                bail!("请选择空文件夹，迁移不会覆盖目标位置已有的文件");
            }
        }
        OperationKind::Backup => {
            if destination.is_dir() {
                bail!("请选择 ZIP 备份文件的保存位置");
            }
        }
        OperationKind::Restore => {
            if !destination.is_file() {
                bail!("备份文件不存在");
            }
        }
    }
    Ok(destination)
}

/// Inspect every ancestor; neither directory junctions nor file symlinks are followed.
pub(crate) fn reject_links(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        if let Ok(metadata) = fs::symlink_metadata(ancestor) {
            #[cfg(windows)]
            let linked = {
                use std::os::windows::fs::MetadataExt;
                metadata.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let linked = metadata.file_type().is_symlink();
            if linked {
                bail!(
                    "本地数据操作不能沿符号链接或目录联接执行：{}",
                    ancestor.display()
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
