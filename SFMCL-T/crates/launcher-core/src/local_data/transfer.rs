use super::{
    absolute_path, archive, contains, reject_links, save_location, validate_destination,
    OperationKind,
};
use crate::paths::atomic_write;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
};

pub fn migrate(
    source: &Path,
    destination: &Path,
    control: &Path,
    key: &str,
) -> Result<Option<PathBuf>> {
    let source = absolute_path(source)?;
    let destination = validate_destination(&source, destination, OperationKind::Migrate)?;
    if contains(&source, control) || contains(&destination, control) {
        bail!("目标文件夹与本地数据路径配置冲突");
    }
    let parent = destination.parent().context("无效的目标文件夹")?;
    let stage = tempfile::Builder::new()
        .prefix(".sfmcl-t-migrate-")
        .tempdir_in(parent)?;
    let (directories, files) = archive::collect(&source)?;
    for directory in directories {
        fs::create_dir_all(stage.path().join(directory))?;
    }
    for (relative, path) in files {
        let destination = stage.path().join(relative);
        fs::create_dir_all(destination.parent().context("无效的数据文件路径")?)?;
        let mut output = File::create(&destination)?;
        let digest = archive::copy_hashed(File::open(&path)?, &mut output)?;
        output.sync_all()?;
        if digest != archive::copy_hashed(File::open(&destination)?, std::io::sink())? {
            bail!("迁移文件校验失败");
        }
    }
    archive::remap_paths(stage.path(), &source, &destination)?;
    archive::validate_profile(stage.path())?;
    validate_destination(&source, &destination, OperationKind::Migrate)?;
    let existed = destination.exists();
    if existed {
        fs::remove_dir(&destination)?;
    }
    if let Err(error) = fs::rename(stage.path(), &destination) {
        if existed {
            let _ = fs::create_dir(&destination);
        }
        return Err(error).context("无法启用新的本地数据目录");
    }
    if let Err(error) = save_location(control, key, &destination) {
        // The original profile remains authoritative until the pointer is durable.
        return Err(error).context(format!(
            "迁移未切换路径，原数据仍保留；已复制的数据位于 {}",
            destination.display()
        ));
    }
    // The caller releases the old profile lock before removing the original tree.
    Ok(Some(source))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreJournal {
    source: PathBuf,
    stage: PathBuf,
    previous: PathBuf,
}

pub fn restore(source: &Path, backup: &Path, control: &Path) -> Result<PathBuf> {
    reject_links(control)?;
    let source = absolute_path(source)?;
    let backup = validate_destination(&source, backup, OperationKind::Restore)?;
    let parent = source.parent().context("无效的本地数据目录")?;
    let stage = tempfile::Builder::new()
        .prefix(".sfmcl-t-restore-")
        .tempdir_in(parent)?;
    let info = archive::extract(&backup, stage.path())?;
    archive::remap_paths(stage.path(), &info.source_dir, &source)?;
    archive::validate_profile(stage.path())?;
    let previous = parent.join(format!("SFMCL-T-before-restore-{}", uuid::Uuid::new_v4()));
    let journal = RestoreJournal {
        source: source.clone(),
        stage: stage.path().into(),
        previous: previous.clone(),
    };
    fs::create_dir_all(control)?;
    let journal_path = control.join("restore-journal.json");
    if journal_path.exists() {
        bail!("上次还原尚未处理，请重新启动后再试");
    }
    atomic_write(&journal_path, &serde_json::to_vec(&journal)?)?;
    // Retain staging output after journaling, even if the process is interrupted.
    let stage = stage.keep();
    reject_links(&source)?;
    if let Err(error) = fs::rename(&source, &previous) {
        let _ = fs::remove_file(&journal_path);
        fs::remove_dir_all(stage)?;
        return Err(error).context("本地数据文件仍被占用，未还原任何数据");
    }
    if let Err(error) = fs::rename(&stage, &source) {
        fs::rename(&previous, &source).context("无法恢复原数据，请保留还原前的数据副本")?;
        fs::remove_file(&journal_path)?;
        fs::remove_dir_all(stage)?;
        return Err(error).context("无法启用还原的数据，已恢复原数据");
    }
    fs::remove_file(&journal_path)?;
    Ok(previous)
}

pub fn recover_restore(control: &Path) -> Result<()> {
    let path = control.join("restore-journal.json");
    if !path.exists() {
        return Ok(());
    }
    reject_links(&path)?;
    let journal: RestoreJournal = serde_json::from_slice(&fs::read(&path)?)?;
    let parent = journal.source.parent().context("还原记录无效")?;
    if !journal.source.is_absolute()
        || journal.stage.parent() != Some(parent)
        || journal.previous.parent() != Some(parent)
        || !journal
            .stage
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(".sfmcl-t-restore-"))
        || !journal.previous.file_name().is_some_and(|name| {
            name.to_string_lossy()
                .starts_with("SFMCL-T-before-restore-")
        })
    {
        bail!("还原记录的目录不匹配，请保留该记录后修复");
    }
    for directory in [&journal.source, &journal.stage, &journal.previous] {
        reject_links(directory)?;
    }
    if !journal.source.exists() && journal.previous.is_dir() {
        fs::rename(&journal.previous, &journal.source)?;
    }
    if !journal.source.is_dir() {
        bail!("无法恢复中断的还原，请检查还原前的数据副本");
    }
    // Discard only our uniquely named, fully inspected staging tree.
    if journal.stage.exists() {
        archive::collect(&journal.stage)?;
        fs::remove_dir_all(&journal.stage)?;
    }
    fs::remove_file(path)?;
    Ok(())
}

pub fn remove_original(source: &Path) -> Result<()> {
    let source = absolute_path(source)?;
    if source.parent().is_none() || source.file_name().is_none() {
        bail!("不能清理根目录");
    }
    archive::collect(&source)?;
    fs::remove_dir_all(&source).context("新路径已启用，但旧目录仍被占用，已保留无法清理的数据")
}
