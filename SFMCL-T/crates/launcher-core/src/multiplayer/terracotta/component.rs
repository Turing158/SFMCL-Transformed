use super::super::components::{check_cancel, digest, download_component};
use crate::{
    downloads::{DownloadManager, DownloadSpec},
    jobs::Job,
};
use anyhow::{ensure, Context, Result};
use flate2::read::GzDecoder;
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

pub const VERSION: &str = "0.4.2";
pub struct Release {
    pub arch: &'static str,
    pub meta_arch: &'static str,
    size: u64,
    archive: &'static str,
    sha512: &'static str,
    exe: &'static str,
    dll: &'static str,
}
const X64: Release = Release {
    arch: "x86_64", meta_arch: "x86_64", size: 8135914,
    sha512: "6a98f524d4f00373696517306af8aa50d01d55ce4eadb27e9e4bc2f882707a0b5f20d5d4c33371d1459dcf5bf144ffed9beb414202d9ccf32b11dbbfcf19d650",
    archive: "07ebe139e3ca5f74576e58b1a96efe59abdfbe148d3f1a49bfdca8b6f70745f0",
    exe: "74c10568a7fea9c1d38cf8d2d4ca90baf1517f8e5a26c63d3349db70bc449796",
    dll: "475ab98b7722e965bd38c8fa6ed23502309582ccf294ff1061cb290c7988f0d1",
};
const ARM64: Release = Release {
    arch: "arm64", meta_arch: "aarch64", size: 7211225,
    sha512: "fc1077247014ac0c712469498bde2ef7f6d881d5fcb7bdd5e11ebe20218fed365be19afdb8d453a79d77b729f866058522b910741767f4df947faa891434b463",
    archive: "acfab0a87a02dedc6dab7c05303186c8907f56f815548b693fb3324358da7d14",
    exe: "782c2fa911488d487447694acca6b17fa68304c87023fb6814b83a167fc2845f",
    dll: "606ce12f558832ebfd9389dc48c57964ac90eafab72721a083e062afd3688626",
};
pub fn release() -> Result<&'static Release> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::{
            LibraryLoader::{GetModuleHandleW, GetProcAddress},
            SystemInformation::*,
            Threading::GetCurrentProcess,
        };
        // GetNativeSystemInfo can report the emulated architecture on ARM64.
        // Older Windows releases predate IsWow64Process2 and ARM64 emulation.
        let kernel32: Vec<u16> = "kernel32.dll\0".encode_utf16().collect();
        let query = unsafe {
            GetProcAddress(
                GetModuleHandleW(kernel32.as_ptr()),
                c"IsWow64Process2".as_ptr().cast(),
            )
        };
        if let Some(query) = query {
            type Query = unsafe extern "system" fn(
                windows_sys::Win32::Foundation::HANDLE,
                *mut u16,
                *mut u16,
            ) -> i32;
            let query: Query = unsafe { std::mem::transmute(query) };
            let (mut process, mut native) = (0, 0);
            ensure!(
                unsafe { query(GetCurrentProcess(), &mut process, &mut native) } != 0,
                "无法识别 Windows 原生架构"
            );
            return match native {
                0x8664 => Ok(&X64),
                0xaa64 => Ok(&ARM64),
                _ => anyhow::bail!(
                    "陶瓦未提供此 Windows 架构的组件，请选择「SFMCL联机」或「自定义」"
                ),
            };
        }
        let mut info = SYSTEM_INFO::default();
        unsafe {
            GetNativeSystemInfo(&mut info);
        }
        match unsafe { info.Anonymous.Anonymous.wProcessorArchitecture } {
            PROCESSOR_ARCHITECTURE_AMD64 => Ok(&X64),
            PROCESSOR_ARCHITECTURE_ARM64 => Ok(&ARM64),
            _ => {
                anyhow::bail!("陶瓦未提供原生 32 位 Windows 组件，请选择「SFMCL联机」或「自定义」")
            }
        }
    }
    #[cfg(not(windows))]
    anyhow::bail!("陶瓦组件目前支持 Windows x64 和 ARM64")
}

const LICENSE: &[u8] = include_bytes!("../../../../../licenses/terracotta/LICENSE");
const NOTICE: &[u8] = include_bytes!("../../../../../licenses/terracotta/NOTICE.txt");

impl Release {
    fn base(&self) -> String {
        format!("terracotta-{VERSION}-windows-{}", self.arch)
    }
    fn executable(&self, root: &Path) -> PathBuf {
        root.join(self.base()).join(format!("{}.exe", self.base()))
    }
    pub fn installed(&self, root: &Path) -> bool {
        self.verified_executable(root).is_some()
    }
    pub fn verified_executable(&self, root: &Path) -> Option<PathBuf> {
        let exe = self.executable(root);
        (digest(&exe).is_ok_and(|hash| hash == self.exe)
            && digest(&exe.with_file_name("VCRUNTIME140.DLL")).is_ok_and(|hash| hash == self.dll)
            && fs::read(exe.with_file_name("LICENSE")).is_ok_and(|v| v == LICENSE)
            && fs::read(exe.with_file_name("NOTICE.txt")).is_ok_and(|v| v == NOTICE))
        .then_some(exe)
    }
    fn install(
        &self,
        root: &Path,
        archive: &Path,
        job: &Job,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        use sha2::{Digest, Sha256};
        use std::io::{Seek, SeekFrom};
        let mut file = File::open(archive).context("无法打开陶瓦组件包")?;
        let mut hash = Sha256::new();
        ensure!(
            file.metadata()?.len() == self.size
                && std::io::copy(&mut file, &mut hash)? == self.size
                && hex::encode(hash.finalize()) == self.archive,
            "陶瓦组件包校验失败，请选择对应架构的 v0.4.2 官方 tar.gz"
        );
        check_cancel(job, cancel)?;
        let target = self.executable(root);
        if self.installed(root) {
            return Ok(target);
        }
        file.seek(SeekFrom::Start(0))?;
        let stage = tempfile::Builder::new()
            .prefix("terracotta-install-")
            .tempdir_in(root)?;
        let files = stage.path().join("new");
        fs::create_dir(&files)?;
        let exe = format!("{}.exe", self.base());
        for entry in tar::Archive::new(GzDecoder::new(file)).entries()? {
            let mut entry = entry?;
            let path = entry.path()?;
            let name = if path == Path::new(&exe) {
                &exe
            } else if path == Path::new("VCRUNTIME140.DLL") {
                "VCRUNTIME140.DLL"
            } else {
                anyhow::bail!("陶瓦包包含未知文件");
            };
            ensure!(
                entry.header().entry_type().is_file() && entry.size() < 100_000_000,
                "陶瓦组件文件无效"
            );
            let dest = files.join(name);
            let mut out = File::create_new(&dest)?;
            std::io::copy(&mut entry, &mut out)?;
        }
        ensure!(
            digest(&files.join(&exe))? == self.exe
                && digest(&files.join("VCRUNTIME140.DLL"))? == self.dll,
            "陶瓦组件文件校验失败"
        );
        fs::write(files.join("LICENSE"), LICENSE)?;
        fs::write(files.join("NOTICE.txt"), NOTICE)?;
        check_cancel(job, cancel)?;
        let directory = root.join(self.base());
        // Only a damaged installation of this exact pinned release can be replaced.
        let previous = stage.path().join("previous");
        if directory.exists() {
            fs::rename(&directory, &previous)?;
        }
        if let Err(error) = fs::rename(&files, &directory) {
            if previous.exists() {
                fs::rename(previous, directory)?;
            }
            return Err(error.into());
        }
        Ok(target)
    }

    pub async fn acquire(
        &self,
        root: &Path,
        archive: Option<PathBuf>,
        downloads: &Arc<DownloadManager>,
        job: &Job,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        check_cancel(job, cancel)?;
        if let Some(archive) = archive {
            job.step(1, "读取官方 tar.gz");
            job.step(2, "校验并安装陶瓦组件");
            return self.install(root, &archive, job, cancel);
        }
        let filename = format!("{}-pkg.tar.gz", self.base());
        let spec = DownloadSpec {
            url: format!(
                "https://github.com/burningtnt/Terracotta/releases/download/v{VERSION}/{filename}"
            ),
            path: filename,
            size: Some(self.size),
            sha1: None,
            sha512: Some(self.sha512.into()),
        };
        download_component(
            root,
            spec,
            format!("Terracotta {VERSION} · 陶瓦联机"),
            downloads,
            job,
            cancel,
            0,
            |archive| self.install(root, archive, job, cancel),
        )
        .await
    }
}

pub fn lock(root: &Path) -> Result<File> {
    fs::create_dir_all(root)?;
    let lock = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("terracotta-session.lock"))?;
    lock.try_lock()
        .context("此数据目录正在准备或运行陶瓦联机")?;
    Ok(lock)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{JobKind, Jobs};

    #[test]
    #[ignore = "requires the official x64 and ARM64 v0.4.2 packages"]
    fn real_packages_check_architecture_cancel_and_repair() {
        let job = Jobs::default().create(JobKind::Other, "校验陶瓦".into(), &["校验"]);
        let archives = [
            (
                &X64,
                PathBuf::from(std::env::var_os("SFMCL_T_TERRACOTTA_PACKAGE").unwrap()),
            ),
            (
                &ARM64,
                PathBuf::from(std::env::var_os("SFMCL_T_TERRACOTTA_ARM64").unwrap()),
            ),
        ];
        for (i, (release, archive)) in archives.iter().enumerate() {
            let root = tempfile::tempdir_in(archive.parent().unwrap()).unwrap();
            let cancel = CancellationToken::new();
            let exe = release
                .install(root.path(), archive, &job, &cancel)
                .unwrap();
            assert!(release
                .install(root.path(), &archives[1 - i].1, &job, &cancel)
                .is_err());
            assert!(release.installed(root.path()));
            let dll = exe.with_file_name("VCRUNTIME140.DLL");
            fs::write(&dll, b"corrupt").unwrap();
            assert!(!release.installed(root.path()));
            release
                .install(root.path(), archive, &job, &cancel)
                .unwrap();
            fs::remove_file(&exe).unwrap();
            assert!(!release.installed(root.path()));
            release
                .install(root.path(), archive, &job, &cancel)
                .unwrap();
            let cancelled = CancellationToken::new();
            cancelled.cancel();
            let other_job = Jobs::default().create(JobKind::Other, "取消导入".into(), &["校验"]);
            assert!(release
                .install(root.path(), archive, &other_job, &cancelled)
                .is_err());
            assert!(release.installed(root.path()));
        }
    }
}
