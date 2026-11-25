use crate::{
    downloads::DownloadManager,
    paths::{safe_join, valid_name},
};
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

/// Only a directory exclusively created by this installation may be removed.
pub(super) struct InstallWork {
    root: PathBuf,
    relative: PathBuf,
    path: PathBuf,
}

impl InstallWork {
    pub fn create(root: &Path, id: &str) -> Result<Self> {
        valid_name(id)?;
        let parent = safe_join(root, ".tmcl/install")?;
        std::fs::create_dir_all(&parent)?;
        let relative = PathBuf::from(format!(".tmcl/install/{id}"));
        let path = safe_join(root, &relative)?;
        std::fs::create_dir(&path).context("无法创建独立的安装工作目录")?;
        Ok(Self {
            root: root.into(),
            relative,
            path,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn cleanup(&self, downloads: &DownloadManager) -> Result<Vec<String>> {
        let mut cleared = Vec::new();
        for batch in downloads.snapshots().await {
            if batch.root != self.root {
                continue;
            }
            let owned = batch
                .files
                .iter()
                .filter(|file| Path::new(&file.spec.path).starts_with(&self.relative))
                .count();
            if owned == 0 {
                continue;
            }
            if owned != batch.files.len() {
                bail!("下载任务包含安装工作目录以外的文件，保留工作目录");
            }
            if !batch.status.terminal() {
                downloads.cancel(&batch.id).await?;
            }
            // clear waits for workers and removes owned partials/state records;
            // it never removes committed game files outside this workspace.
            downloads.clear(&batch.id).await?;
            cleared.push(batch.id);
        }
        let root = self.root.clone();
        let relative = self.relative.clone();
        tokio::task::spawn_blocking(move || remove_unlinked(&root, &relative)).await??;
        Ok(cleared)
    }
}

fn remove_unlinked(root: &Path, relative: &Path) -> Result<()> {
    let directory = safe_join(root, relative)?;
    let mut pending = vec![directory.clone()];
    while let Some(path) = pending.pop() {
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            bail!("安装工作目录包含符号链接，保留文件");
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                bail!("安装工作目录包含重解析点，保留文件");
            }
        }
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path)? {
                pending.push(entry?.path());
            }
        }
    }
    std::fs::remove_dir_all(directory).context("无法清理安装工作目录")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::downloads::{
        DownloadRetention, DownloadSnapshot, DownloadSpec, FileSnapshot, Status, Step,
    };

    #[tokio::test]
    async fn cleanup_removes_installer_records_and_keeps_game_and_other_work() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let work = InstallWork::create(root, "owned").unwrap();
        std::fs::write(work.path().join("installer.jar"), b"installer").unwrap();
        std::fs::create_dir_all(root.join("versions/game")).unwrap();
        std::fs::write(root.join("versions/game/game.jar"), b"game").unwrap();
        let other = InstallWork::create(root, "other").unwrap();
        std::fs::write(other.path().join("request.json"), b"other").unwrap();
        let state = root.join("downloads");
        std::fs::create_dir(&state).unwrap();
        let snapshot = DownloadSnapshot {
            id: "installer".into(),
            title: "installer".into(),
            retention: DownloadRetention::Persistent,
            folder_download: false,
            root: root.into(),
            cache_dir: None,
            status: Status::Paused,
            files: vec![FileSnapshot {
                spec: DownloadSpec {
                    url: "https://example.invalid/installer.jar".into(),
                    path: ".tmcl/install/owned/installer.jar".into(),
                    size: None,
                    sha1: None,
                    sha512: None,
                },
                status: Status::Paused,
                downloaded: 0,
                total: None,
                attempts: 0,
                error: None,
            }],
            steps: vec![Step {
                name: "download".into(),
                status: Status::Paused,
                detail: String::new(),
            }],
            bytes_per_second: 0,
            active_workers: 0,
            error: None,
            created_at: 0,
        };
        std::fs::write(
            state.join("installer.json"),
            serde_json::to_vec(&snapshot).unwrap(),
        )
        .unwrap();
        let downloads = DownloadManager::open(&state, 1).unwrap();
        assert_eq!(work.cleanup(&downloads).await.unwrap(), ["installer"]);
        assert!(!work.path().exists());
        assert!(downloads.snapshots().await.is_empty());
        assert!(DownloadManager::open(&state, 1)
            .unwrap()
            .snapshots()
            .await
            .is_empty());
        assert_eq!(
            std::fs::read(root.join("versions/game/game.jar")).unwrap(),
            b"game"
        );
        assert!(other.path().join("request.json").exists());
    }

    #[test]
    fn existing_work_is_never_adopted() {
        let temp = tempfile::tempdir().unwrap();
        let work = InstallWork::create(temp.path(), "owned").unwrap();
        assert!(InstallWork::create(temp.path(), "owned").is_err());
        assert!(InstallWork::create(temp.path(), "../outside").is_err());
        assert!(work.path().exists());
    }
}
