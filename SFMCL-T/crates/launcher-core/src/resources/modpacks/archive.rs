use crate::paths::{safe_join, valid_name};
use anyhow::{bail, Context, Result};
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

pub const MAX_METADATA: u64 = 16 * 1024 * 1024;
const MAX_FILE: u64 = 4 * 1024 * 1024 * 1024;
const MAX_TOTAL: u64 = 20 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;

pub fn relative(value: &str) -> Result<String> {
    let value = value.replace('\\', "/");
    let value = value
        .strip_prefix("./")
        .unwrap_or(&value)
        .trim_end_matches('/');
    if value.is_empty() {
        bail!("整合包文件路径为空");
    }
    for segment in value.split('/') {
        valid_name(segment)?;
    }
    Ok(value.to_owned())
}

pub fn check_cancel(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        bail!("整合包安装已取消");
    }
    Ok(())
}

struct Extraction<'a> {
    root: &'a Path,
    cancel: &'a CancellationToken,
    paths: HashSet<String>,
    entries: usize,
    total: u64,
}
impl Extraction<'_> {
    fn target(&mut self, name: &str, size: u64, directory: bool) -> Result<PathBuf> {
        check_cancel(self.cancel)?;
        self.entries += 1;
        if self.entries > MAX_ENTRIES || size > MAX_FILE || size > MAX_TOTAL - self.total {
            bail!("整合包文件数量或解压大小超过限制");
        }
        let name = relative(name)?;
        let target = safe_join(self.root, &name)?;
        if !directory && !self.paths.insert(name.to_lowercase()) {
            bail!("整合包存在重复或大小写冲突的文件路径");
        }
        Ok(target)
    }
    fn write(
        &mut self,
        name: &str,
        size: u64,
        directory: bool,
        reader: &mut dyn Read,
    ) -> Result<()> {
        if directory && matches!(name, "." | "./") {
            return Ok(());
        }
        let target = self.target(name, size, directory)?;
        if directory {
            std::fs::create_dir_all(target)?;
            return Ok(());
        }
        std::fs::create_dir_all(target.parent().context("文件缺少父目录")?)?;
        let mut output = File::options().write(true).create_new(true).open(target)?;
        let copied = copy_bounded(
            reader,
            &mut output,
            size.min(MAX_TOTAL - self.total),
            self.cancel,
        )?;
        if copied != size {
            bail!("整合包文件解压大小与清单不符");
        }
        self.total += copied;
        Ok(())
    }
    fn tar(&mut self, reader: impl Read) -> Result<()> {
        let mut archive = tar::Archive::new(reader);
        for entry in archive.entries()? {
            let mut entry = entry?;
            let kind = entry.header().entry_type();
            if !kind.is_dir() && !kind.is_file() {
                bail!("整合包包含链接或特殊文件");
            }
            let name = entry.path()?.to_string_lossy().into_owned();
            let size = if kind.is_dir() { 0 } else { entry.size() };
            self.write(&name, size, kind.is_dir(), &mut entry)?;
        }
        Ok(())
    }
}

pub fn copy_bounded(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    limit: u64,
    cancel: &CancellationToken,
) -> Result<u64> {
    let mut buffer = vec![0; 128 * 1024];
    let mut copied = 0;
    loop {
        check_cancel(cancel)?;
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        if read as u64 > limit - copied {
            bail!("整合包文件大小超过限制");
        }
        writer.write_all(&buffer[..read])?;
        copied += read as u64;
    }
    Ok(copied)
}

pub fn files(root: &Path, cancel: &CancellationToken) -> Result<Vec<PathBuf>> {
    fn visit(
        root: &Path,
        current: &Path,
        cancel: &CancellationToken,
        output: &mut Vec<PathBuf>,
        depth: usize,
        total: &mut u64,
        count: &mut usize,
    ) -> Result<()> {
        check_cancel(cancel)?;
        if depth > 64 {
            bail!("整合包目录层数过多");
        }
        for entry in std::fs::read_dir(current)? {
            let entry = entry?;
            *count += 1;
            if *count > MAX_ENTRIES {
                bail!("整合包文件数量超过限制");
            }
            let path = safe_join(root, entry.path().strip_prefix(root)?)?;
            let meta = std::fs::symlink_metadata(&path)?;
            if meta.is_dir() {
                visit(root, &path, cancel, output, depth + 1, total, count)?;
            } else if meta.is_file() {
                if meta.len() > MAX_FILE || meta.len() > MAX_TOTAL - *total {
                    bail!("整合包大小超过限制");
                }
                *total += meta.len();
                output.push(path);
            } else {
                bail!("整合包包含特殊文件");
            }
        }
        Ok(())
    }
    let mut output = Vec::new();
    visit(root, root, cancel, &mut output, 0, &mut 0, &mut 0)?;
    Ok(output)
}

pub fn copy_file(source: &Path, target: &Path, cancel: &CancellationToken) -> Result<()> {
    std::fs::create_dir_all(target.parent().context("文件缺少父目录")?)?;
    let mut input = File::open(source)?;
    let size = input.metadata()?.len();
    let mut output = File::create(target)?;
    copy_bounded(&mut input, &mut output, size.min(MAX_FILE), cancel)?;
    Ok(())
}

/// Detect the container by its signature, independently of its extension.
pub fn extract(source: &Path, root: &Path, cancel: &CancellationToken) -> Result<()> {
    if let Some(parent) = source.parent() {
        safe_join(parent, source.file_name().context("整合包路径无效")?)?;
    }
    std::fs::create_dir_all(root)?;
    if source.is_dir() {
        for file in files(source, cancel)? {
            copy_file(&file, &safe_join(root, file.strip_prefix(source)?)?, cancel)?;
        }
        return Ok(());
    }
    let mut input = File::open(source)?;
    let mut signature = [0; 512];
    let length = input.read(&mut signature)?;
    input.seek(SeekFrom::Start(0))?;
    let mut extraction = Extraction {
        root,
        cancel,
        paths: HashSet::new(),
        entries: 0,
        total: 0,
    };
    if signature.starts_with(b"PK") {
        let mut archive = zip::ZipArchive::new(input)?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            if entry.encrypted()
                || entry
                    .unix_mode()
                    .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                bail!("不支持加密包或包含链接的整合包");
            }
            let name = entry.name().to_owned();
            let directory = entry.is_dir();
            let size = if directory { 0 } else { entry.size() };
            extraction.write(&name, size, directory, &mut entry)?;
        }
    } else if signature.starts_with(&[0x1f, 0x8b]) {
        extraction.tar(flate2::read::GzDecoder::new(input))?;
    } else if signature.starts_with(b"7z\xbc\xaf\x27\x1c") {
        let mut archive = sevenz_rust::SevenZReader::new(
            input,
            std::fs::metadata(source)?.len(),
            sevenz_rust::Password::empty(),
        )?;
        for entry in &archive.archive().files {
            if entry.is_anti_item
                || entry.windows_attributes & 0x400 != 0
                || (entry.windows_attributes >> 16) & 0o170000 == 0o120000
            {
                bail!("整合包包含链接或特殊文件");
            }
            if entry.size > MAX_FILE {
                bail!("整合包单个文件过大");
            }
        }
        archive.for_each_entries(|entry, reader| {
            extraction
                .write(&entry.name, entry.size, entry.is_directory, reader)
                .map_err(|error| {
                    sevenz_rust::Error::io(std::io::Error::other(error.to_string()))
                })?;
            Ok(true)
        })?;
    } else if signature.starts_with(b"Rar!\x1a\x07") {
        let mut archive = unrar::Archive::new(source).open_for_processing()?;
        while let Some(header) = archive.read_header()? {
            let entry = header.entry();
            if entry.is_encrypted()
                || entry.is_split()
                || entry.file_attr & 0x400 != 0
                || entry.file_attr & 0o170000 == 0o120000
            {
                bail!("不支持加密、多卷或包含链接的 RAR 整合包");
            }
            let directory = entry.is_directory();
            let target = extraction.target(
                &entry.filename.to_string_lossy(),
                entry.unpacked_size,
                directory,
            )?;
            let size = entry.unpacked_size;
            if directory {
                std::fs::create_dir_all(target)?;
                archive = header.skip()?;
            } else {
                // Read data through the decoder rather than asking native
                // UnRAR to create archive-controlled links on the filesystem.
                if size > 512 * 1024 * 1024 {
                    bail!("RAR 整合包单个文件超过 512 MB，请改用 ZIP 或 7Z");
                }
                let (bytes, next) = header.read()?;
                if bytes.len() as u64 != size {
                    bail!("RAR 文件大小不符");
                }
                check_cancel(cancel)?;
                std::fs::create_dir_all(target.parent().context("文件缺少父目录")?)?;
                File::options()
                    .write(true)
                    .create_new(true)
                    .open(target)?
                    .write_all(&bytes)?;
                archive = next;
                extraction.total += size;
            }
        }
    } else if length >= 262 && &signature[257..262] == b"ustar"
        || source
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("tar"))
    {
        extraction.tar(input)?;
    } else {
        bail!("不支持的压缩格式。请选择 ZIP、MRPACK、7Z、RAR、TAR 或 TAR.GZ 整合包");
    }
    Ok(())
}
