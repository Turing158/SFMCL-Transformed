use crate::{
    downloads::DownloadSpec,
    paths::{safe_join, valid_name},
};
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

pub fn installation_folder(kind: &str) -> Result<Option<&'static str>> {
    match kind {
        "mod" => Ok(Some("mods")),
        "resourcepack" => Ok(Some("resourcepacks")),
        "shader" => Ok(Some("shaderpacks")),
        "datapack" | "modpack" => Ok(None),
        _ => bail!("此资源类型不支持下载"),
    }
}

pub fn folder_destination(directory: &Path, file: DownloadSpec) -> Result<(PathBuf, DownloadSpec)> {
    if !directory.is_absolute() {
        bail!("请选择绝对路径的下载文件夹");
    }
    valid_name(&file.path)?;
    let root = directory
        .canonicalize()
        .context("下载文件夹不存在或无法访问")?;
    if !root.is_dir() {
        bail!("下载目标必须是文件夹");
    }
    safe_join(&root, &file.path)?;
    Ok((root, file))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str) -> DownloadSpec {
        DownloadSpec {
            url: "https://example.com/resource.jar".into(),
            path: path.into(),
            size: Some(2048),
            sha1: None,
            sha512: None,
        }
    }

    #[test]
    fn saves_directly_in_the_selected_folder() {
        let directory = tempfile::tempdir().unwrap();
        let (root, spec) = folder_destination(directory.path(), file("resource.jar")).unwrap();
        assert_eq!(root, directory.path().canonicalize().unwrap());
        assert_eq!(spec.path, "resource.jar");
        assert_eq!(spec.size, Some(2048));
    }

    #[test]
    fn datapacks_require_a_selected_folder_instead_of_a_game_installation() {
        assert_eq!(installation_folder("datapack").unwrap(), None);
        assert_eq!(installation_folder("mod").unwrap(), Some("mods"));
        assert_eq!(
            installation_folder("resourcepack").unwrap(),
            Some("resourcepacks")
        );
        assert_eq!(installation_folder("shader").unwrap(), Some("shaderpacks"));
        assert!(installation_folder("unknown").is_err());

        let directory = tempfile::tempdir().unwrap();
        let (root, spec) = folder_destination(directory.path(), file("datapack.zip")).unwrap();
        assert_eq!(root, directory.path().canonicalize().unwrap());
        assert_eq!(spec.path, "datapack.zip");
    }

    #[test]
    fn rejects_invalid_directories_and_file_paths() {
        let directory = tempfile::tempdir().unwrap();
        assert!(folder_destination(Path::new("relative"), file("resource.jar")).is_err());
        assert!(
            folder_destination(&directory.path().join("missing"), file("resource.jar")).is_err()
        );
        let regular_file = directory.path().join("not-a-directory");
        std::fs::write(&regular_file, b"test").unwrap();
        assert!(folder_destination(&regular_file, file("resource.jar")).is_err());
        for name in [
            "../escape.jar",
            "mods/resource.jar",
            "C:\\escape.jar",
            "CON.jar",
        ] {
            assert!(
                folder_destination(directory.path(), file(name)).is_err(),
                "{name}"
            );
        }
    }
}
