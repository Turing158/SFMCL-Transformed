use anyhow::{bail, Context, Result};
use std::path::{Component, Path, PathBuf};

/// Settings store the selected outer directory; older records may already point
/// at the Minecraft data folder.
pub fn minecraft_root(directory: &Path) -> PathBuf {
    if directory.file_name().is_some_and(|name| {
        if cfg!(windows) {
            name.to_string_lossy().eq_ignore_ascii_case(".minecraft")
        } else {
            name == ".minecraft"
        }
    }) {
        directory.to_path_buf()
    } else {
        directory.join(".minecraft")
    }
}

pub fn valid_name(name: &str) -> Result<()> {
    if name.trim().is_empty()
        || name.len() > 150
        || name.ends_with([' ', '.'])
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || name == "."
        || name == ".."
    {
        bail!("名称为空、过长或包含文件系统不允许的字符");
    }
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
    {
        bail!("不能使用系统保留名称");
    }
    Ok(())
}

/// Resolve only relative paths beneath the selected root. Refuse junctions/symlinks
/// that could let an archive, manifest or download escape the game directory.
pub fn safe_join(root: &Path, relative: impl AsRef<Path>) -> Result<PathBuf> {
    let relative = relative.as_ref();
    if relative.as_os_str().is_empty() {
        bail!("目标路径为空");
    }
    let mut path = root.to_path_buf();
    for part in relative.components() {
        match part {
            Component::Normal(value) => {
                valid_name(&value.to_string_lossy())?;
                path.push(value);
                if let Ok(meta) = std::fs::symlink_metadata(&path) {
                    if meta.file_type().is_symlink() {
                        bail!("路径包含符号链接：{}", path.display());
                    }
                    #[cfg(windows)]
                    {
                        use std::os::windows::fs::MetadataExt;
                        if meta.file_attributes() & 0x400 != 0 {
                            bail!("路径包含重解析点");
                        }
                    }
                }
            }
            _ => bail!("路径必须位于所选目录内：{}", relative.display()),
        }
    }
    Ok(path)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("缺少父目录")?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_escape_and_windows_special_names() {
        let root = tempfile::tempdir().unwrap();
        for path in [
            "../secret",
            "C:\\secret",
            "/tmp/a",
            "CON.txt",
            "x/../../a",
            "bad:stream",
        ] {
            assert!(safe_join(root.path(), path).is_err(), "{path}");
        }
        assert!(safe_join(root.path(), "libraries/a.jar").is_ok());
    }
    #[test]
    fn atomic_write_replaces_existing_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"new");
    }
}
