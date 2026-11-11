use crate::{
    downloads::{DownloadManager, DownloadRetention, DownloadSpec, Status},
    jobs::Job,
};
use anyhow::{ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[cfg(test)]
#[path = "component_download_tests.rs"]
mod tests;

pub const VERSION: &str = "2.6.4";
pub struct Release {
    pub arch: &'static str,
    pub size: u64,
    pub archive_hash: &'static str,
    pub core_hash: &'static str,
    pub cli_hash: &'static str,
    pub packet_hash: &'static str,
}
pub fn release() -> Result<Release> {
    ensure!(cfg!(windows), "联机组件目前支持 Windows");
    release_for(std::env::consts::ARCH)
}
pub(super) fn release_for(arch: &str) -> Result<Release> {
    match arch {
        "x86_64" => Ok(Release {
            arch: "x86_64",
            size: 32657720,
            archive_hash: "27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84",
            core_hash: "da7eb2d24b5416f3d3407636949e964a0750e3f9dc53a828cb6799a57ead445d",
            cli_hash: "d8783e851e944b44a9b71b39fd02f227ec0a2a82b3165c55ead5dd32dcde53a1",
            packet_hash: "ab3cce674f5216895fd26a073771f82b05d4c8b214a89f0f288a59774a06b14b",
        }),
        "x86" => Ok(Release {
            arch: "i686",
            size: 30881261,
            archive_hash: "bf557daeccc5525d95b8a230c339d75554fb52d82d1e050e9a5202c92c02e09e",
            core_hash: "657400c756aa4e2868b9505f669527733ba872dff3b8877cee24d7772616c76b",
            cli_hash: "e1d6a617e4cb3b9bf77c9d32616dace5d5715fabcbcb0f5f9969a98f3626d69a",
            packet_hash: "49656c178b17198470ad6906e9ee0865f16f01c1dbbf11c613b55a07246a7918",
        }),
        _ => anyhow::bail!("当前处理器架构尚无已验证的联机组件"),
    }
}
#[derive(Clone)]
pub struct Binaries {
    pub core: PathBuf,
    pub cli: PathBuf,
}
pub(super) fn digest(path: &Path) -> Result<String> {
    let mut input = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    std::io::copy(&mut input, &mut hash)?;
    Ok(hex::encode(hash.finalize()))
}
fn paths(root: &Path, release: &Release) -> Binaries {
    let root = root.join(format!("easytier-{VERSION}-{}", release.arch));
    Binaries {
        core: root.join("easytier-core.exe"),
        cli: root.join("easytier-cli.exe"),
    }
}
pub fn installed(root: &Path) -> bool {
    let Ok(release) = release() else { return false };
    let files = paths(root, &release);
    digest(&files.core).is_ok_and(|hash| hash == release.core_hash)
        && digest(&files.cli).is_ok_and(|hash| hash == release.cli_hash)
        && digest(&files.core.with_file_name("Packet.dll"))
            .is_ok_and(|hash| hash == release.packet_hash)
}

/// The archive's path is never used for extraction. Only these two fixed members
/// are read, then both the archive and executable hashes are checked.
pub(super) fn install_archive(root: &Path, archive: &Path, release: &Release) -> Result<Binaries> {
    ensure!(
        std::fs::metadata(archive)?.len() == release.size
            && digest(archive)? == release.archive_hash,
        "组件校验失败，请使用对应架构的 EasyTier v2.6.4 官方 ZIP"
    );
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?)?;
    let files = paths(root, release);
    for (name, target, expected) in [
        ("easytier-core.exe", &files.core, release.core_hash),
        ("easytier-cli.exe", &files.cli, release.cli_hash),
    ] {
        let mut entry = zip.by_name(&format!("easytier-windows-{}/{name}", release.arch))?;
        ensure!(entry.size() < 100_000_000, "组件体积异常");
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes)?;
        ensure!(
            hex::encode(Sha256::digest(&bytes)) == expected,
            "组件文件校验失败"
        );
        std::fs::create_dir_all(target.parent().unwrap())?;
        crate::paths::atomic_write(target, &bytes)?;
    }
    let directory = files.core.parent().unwrap();
    // Only the BSD-licensed WinPcap compatibility DLL is shipped. The upstream
    // archive's Npcap DLL and all drivers are deliberately not extracted.
    let packet: &[u8] = if release.arch == "x86_64" {
        include_bytes!("../../../../resources/multiplayer/winpcap/x64/Packet.dll")
    } else {
        include_bytes!("../../../../resources/multiplayer/winpcap/x86/Packet.dll")
    };
    ensure!(
        hex::encode(Sha256::digest(packet)) == release.packet_hash,
        "兼容库校验失败"
    );
    crate::paths::atomic_write(&directory.join("Packet.dll"), packet)?;
    crate::paths::atomic_write(
        &directory.join("WINPCAP-LICENSE"),
        include_bytes!("../../../../licenses/easytier/WINPCAP-LICENSE"),
    )?;
    crate::paths::atomic_write(
        &directory.join("NOTICE.txt"),
        include_bytes!("../../../../licenses/easytier/NOTICE.txt"),
    )?;
    crate::paths::atomic_write(
        &directory.join("LICENSE"),
        include_bytes!("../../../../licenses/easytier/LICENSE"),
    )?;
    crate::paths::atomic_write(
        &directory.join("COPYING"),
        include_bytes!("../../../../licenses/easytier/COPYING"),
    )?;
    Ok(files)
}

pub async fn prepare(
    root: &Path,
    archive: Option<PathBuf>,
    downloads: &Arc<DownloadManager>,
    job: &Job,
    cancel: &CancellationToken,
) -> Result<Binaries> {
    check_cancel(job, cancel)?;
    job.step(0, "检查已安装的 EasyTier 组件");
    let release = release()?;
    // Verify every start, including an already installed component.
    if archive.is_none() && installed(root) {
        return Ok(paths(root, &release));
    }
    std::fs::create_dir_all(root)?;
    if let Some(archive) = archive {
        job.step(1, "读取所选官方 ZIP");
        check_cancel(job, cancel)?;
        job.step(2, "校验官方归档并安装组件");
        return install_archive(root, &archive, &release);
    }
    let filename = format!("easytier-windows-{}-v{VERSION}.zip", release.arch);
    let spec = DownloadSpec {
        url: format!(
            "https://github.com/EasyTier/EasyTier/releases/download/v{VERSION}/{filename}"
        ),
        path: filename,
        size: Some(release.size),
        sha1: None,
        sha512: None,
    };
    download_archive(root, &release, spec, downloads, job, cancel).await
}

pub(super) fn check_cancel(job: &Job, cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() || job.cancel.is_cancelled() {
        job.cancel.cancel();
        anyhow::bail!("组件准备已取消");
    }
    Ok(())
}

async fn download_archive(
    root: &Path,
    release: &Release,
    spec: DownloadSpec,
    downloads: &Arc<DownloadManager>,
    job: &Job,
    cancel: &CancellationToken,
) -> Result<Binaries> {
    download_component(
        root,
        spec,
        format!("EasyTier {VERSION} · 联机组件"),
        downloads,
        job,
        cancel,
        |archive| install_archive(root, archive, release),
    )
    .await
}

pub(super) async fn download_component<T>(
    root: &Path,
    spec: DownloadSpec,
    title: String,
    downloads: &Arc<DownloadManager>,
    job: &Job,
    cancel: &CancellationToken,
    install: impl FnOnce(&Path) -> Result<T>,
) -> Result<T> {
    // The workflow owns this directory; pause/retry keeps it alive, and all
    // workers are drained before cancellation or completion removes it.
    let work = tempfile::Builder::new()
        .prefix("component-")
        .tempdir_in(root)?;
    job.step(1, "在下载中心查看进度、暂停或重试");
    let archive = work.path().join(&spec.path);
    let id = downloads
        .enqueue_with_retention(
            title,
            work.path().into(),
            vec![spec],
            DownloadRetention::Session,
        )
        .await?;
    let result = async {
        loop {
            check_cancel(job, cancel)?;
            let snapshot = downloads.snapshot(&id).await?;
            job.download(id.clone(), snapshot.status);
            if snapshot.status == Status::Completed {
                break;
            }
            if snapshot.status == Status::Cancelled {
                job.cancel.cancel();
                anyhow::bail!("组件下载已取消");
            }
            tokio::select! {
                _ = cancel.cancelled() => {},
                _ = job.cancel.cancelled() => {},
                _ = tokio::time::sleep(Duration::from_millis(150)) => {},
            }
        }
        check_cancel(job, cancel)?;
        job.step(2, "校验官方归档并安装组件");
        install(&archive)
    }
    .await;
    // Clearing a failed task in the UI has already drained its workers.
    if downloads.snapshot(&id).await.is_ok() {
        downloads.cancel(&id).await?;
        downloads.discard_temporary_files(&id).await?;
    }
    job.detach_download();
    work.close().context("无法清理组件临时文件")?;
    result
}
