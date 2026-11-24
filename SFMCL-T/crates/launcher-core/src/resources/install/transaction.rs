use super::*;
use crate::{downloads::verify_file_blocking, paths::atomic_write};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
};
use tokio_util::sync::CancellationToken;

pub(super) fn lock(game: &Path) -> Result<File> {
    let path = safe_join(game, ".tmcl/mod-install.lock")?;
    fs::create_dir_all(path.parent().unwrap())?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    lock.try_lock()
        .context("此游戏目录正在安装模组，请等待当前任务结束")?;
    Ok(lock)
}

#[derive(Serialize, Deserialize)]
struct Change {
    source: String,
    destination: String,
    hash: String,
    enable: bool,
}

pub(super) fn commit(
    target: &Target,
    expected: &Inventory,
    selections: &[Selection],
    stage: &Path,
    cancel: &CancellationToken,
) -> Result<()> {
    check_cancel(cancel)?;
    if Inventory::read(&target.game)? != *expected {
        bail!("本地资源在下载期间发生变化，请重新检查前置依赖");
    }
    let mut changes = vec![];
    let mut mod_ids = HashSet::new();
    for file in expected.files.iter().filter(|file| !file.disabled) {
        for id in &file.mod_ids {
            if !mod_ids.insert(id.clone()) {
                bail!("本地已有重复模组 ID：{id}，请先处理后再安装");
            }
        }
    }
    let staged_mods = local::scan(stage, "mod")?;
    for resource in &staged_mods {
        if let Some(error) = &resource.error {
            bail!("下载的模组元数据无效：{}：{error}", resource.name);
        }
        for id in resource.details["modIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|id| id.as_str())
        {
            if !mod_ids.insert(id.into()) {
                bail!("下载的模组与已有模组 ID 重复：{id}");
            }
        }
    }
    for selection in selections {
        check_cancel(cancel)?;
        if let Some(existing) = &selection.existing {
            if !existing.disabled {
                continue;
            }
            for id in &existing.mod_ids {
                if !mod_ids.insert(id.clone()) {
                    bail!("启用前置会产生重复模组 ID：{id}");
                }
            }
        } else {
            let source = safe_join(stage, &selection.item.path)?;
            let mut spec = selection.candidate.file.clone();
            spec.path = selection.item.path.clone();
            verify_file_blocking(&source, &spec, cancel)?;
        }
        let destination = super::resolver::enabled_path(&selection.item.path)?;
        let path = safe_join(&target.game, &destination)?;
        if path.exists() {
            bail!("安装目标已存在：{destination}，请重新检查前置依赖");
        }
        let (source, hash) = if let Some(existing) = &selection.existing {
            (existing.path.clone(), existing.sha1.clone())
        } else {
            let source = safe_join(stage, &selection.item.path)?;
            (
                selection.item.path.clone(),
                super::super::community::install_metadata::identity(&source)?.0,
            )
        };
        changes.push(Change {
            source,
            destination,
            hash,
            enable: selection.existing.is_some(),
        });
    }
    let journal = stage.join("recovery.json");
    // Write the complete intent before any rename. On failure the same record is
    // enough to reverse only this transaction's unchanged files.
    atomic_write(&journal, &serde_json::to_vec_pretty(&changes)?)?;
    let mut committed = 0;
    let result = (|| -> Result<()> {
        for change in &changes {
            check_cancel(cancel)?;
            let source = safe_join(
                if change.enable { &target.game } else { stage },
                &change.source,
            )?;
            let destination = safe_join(&target.game, &change.destination)?;
            fs::create_dir_all(destination.parent().unwrap())?;
            // hard_link refuses to replace an existing target, including on Unix.
            // Staging is on the game's volume; removing the source finishes the move.
            fs::hard_link(&source, &destination)
                .with_context(|| format!("无法安装 {}，文件可能被占用", change.destination))?;
            committed += 1;
            fs::remove_file(&source)
                .with_context(|| format!("无法完成文件移动：{}", change.source))?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut failures = vec![];
        for change in changes.iter().take(committed).rev() {
            let restored = (|| -> Result<()> {
                let destination = safe_join(&target.game, &change.destination)?;
                let source = safe_join(
                    if change.enable { &target.game } else { stage },
                    &change.source,
                )?;
                if super::super::community::install_metadata::identity(&destination)?.0
                    != change.hash
                {
                    bail!("文件已被其他程序修改：{}", change.destination);
                }
                if !source.exists() {
                    fs::hard_link(&destination, &source)?;
                }
                fs::remove_file(&destination)?;
                Ok(())
            })();
            if let Err(error) = restored {
                failures.push(format!("{error:#}"));
            }
        }
        if !failures.is_empty() {
            bail!(
                "{error:#}；恢复未完成：{}。恢复记录保存在 {}",
                failures.join("；"),
                journal.display()
            );
        }
        fs::remove_file(&journal)?;
        return Err(error);
    }
    fs::remove_file(&journal)?;
    Ok(())
}

fn check_cancel(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        bail!("安装已取消");
    }
    Ok(())
}
