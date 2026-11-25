use super::*;
use std::fs::{self, File, OpenOptions};

pub struct Guard {
    _launch: File,
    _install: File,
    _mods: File,
}

pub fn operation_guard(root: &Path, id: &str) -> Result<Guard> {
    valid_name(id)?;
    let instance = safe_join(root, format!("versions/{id}"))?;
    let open = |relative: String| -> Result<File> {
        let path = safe_join(root, relative)?;
        fs::create_dir_all(path.parent().unwrap())?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        file.try_lock()
            .context("此版本正在运行、安装或进行独占操作，请稍后重试")?;
        Ok(file)
    };
    let launch = open(format!(".tmcl/locks/launch-{id}.lock"))?;
    let install = open(format!(".tmcl/locks/{id}.lock"))?;
    let mods = crate::resources::install::launch_guard(&instance)?;
    Ok(Guard {
        _launch: launch,
        _install: install,
        _mods: mods,
    })
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    path: String,
    before: Option<String>,
    after: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    version_id: String,
    state: String,
    changes: Vec<Change>,
    saves_backup: bool,
    #[serde(default)]
    created_at: u64,
}

fn history_root(root: &Path, id: &str) -> Result<PathBuf> {
    let instance = safe_join(root, format!("versions/{id}"))?;
    let key = record::read(&instance)?
        .map(|r| r.instance_id)
        .unwrap_or_else(|| id.into());
    safe_join(root, format!(".tmcl/modpack-updates/{key}"))
}
fn save(path: &Path, journal: &Journal) -> Result<()> {
    atomic_write(path, &serde_json::to_vec_pretty(journal)?)
}
pub fn history(root: &Path, id: &str) -> Result<Vec<Value>> {
    let directory = history_root(root, id)?;
    if !directory.exists() {
        return Ok(vec![]);
    }
    let mut history = vec![];
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = safe_join(&directory, &name)?;
        let log = safe_join(&path, "recovery.json")?;
        if !log.is_file() {
            continue;
        }
        let journal: Journal = serde_json::from_value(parser::read_json(&log)?)?;
        history.push(
            json!({"id":name,"state":journal.state,"path":path,"savesBackup":journal.saves_backup,"createdAt":journal.created_at}),
        );
    }
    history.sort_by(|a, b| b["createdAt"].as_u64().cmp(&a["createdAt"].as_u64()));
    Ok(history)
}
pub fn ensure_ready(root: &Path, id: &str) -> Result<()> {
    if history(root, id)?
        .iter()
        .any(|j| j["state"] == "applying" || j["state"] == "recovery_failed")
    {
        bail!("整合包更新曾中断，请在“更新整合包”中恢复后再操作此版本");
    }
    Ok(())
}

fn replace(source: &Path, target: &Path, cancel: &CancellationToken) -> Result<()> {
    fs::create_dir_all(target.parent().unwrap())?;
    let temp = target.with_file_name(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        archive::copy_file(source, &temp, cancel)?;
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(&temp)?
            .sync_all()?;
        fs::rename(&temp, target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub fn commit(
    root: &Path,
    id: &str,
    stage: &Path,
    expected: &BTreeMap<String, String>,
    desired: &BTreeMap<String, String>,
    backup_saves: bool,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    let target = instance(root, id)?;
    let mut next = record::read(stage)?.context("新版安装记录缺失")?;
    let key = record::read(&target)?
        .map(|r| r.instance_id)
        .unwrap_or_else(|| id.into());
    if next.instance_id != key {
        next.instance_id = key;
        atomic_write(
            &safe_join(stage, record::RECORD)?,
            &serde_json::to_vec_pretty(&next)?,
        )?;
    }
    if record::snapshot(&target, cancel)? != *expected {
        bail!("本地文件在提交前发生变化，请重新检查");
    }
    let mut changes = vec![];
    for path in expected
        .keys()
        .chain(desired.keys())
        .collect::<BTreeSet<_>>()
    {
        let before = expected.get(path).cloned();
        let after = desired.get(path).cloned();
        if before != after {
            changes.push(Change {
                path: path.clone(),
                before,
                after,
            });
        }
    }
    changes.push(Change {
        path: record::RECORD.into(),
        before: record::hash(&safe_join(&target, record::RECORD)?, cancel)?,
        after: record::hash(&safe_join(stage, record::RECORD)?, cancel)?,
    });
    let parent = history_root(root, id)?;
    fs::create_dir_all(&parent)?;
    let temporary = tempfile::Builder::new()
        .prefix("backup-")
        .tempdir_in(parent)?;
    let backup = temporary.path().join("files");
    let mut journal = Journal {
        version_id: id.into(),
        state: "prepared".into(),
        changes,
        saves_backup: backup_saves,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as u64,
    };
    for change in &journal.changes {
        archive::check_cancel(cancel)?;
        if let Some(before) = &change.before {
            let source = safe_join(&target, &change.path)?;
            let dest = safe_join(&backup, &change.path)?;
            archive::copy_file(&source, &dest, cancel)?;
            if record::hash(&dest, cancel)?.as_ref() != Some(before) {
                bail!("备份期间文件发生变化：{}", change.path);
            }
        }
        if let Some(after) = &change.after {
            if record::hash(&safe_join(stage, &change.path)?, cancel)?.as_ref() != Some(after) {
                bail!("新版文件校验失败：{}", change.path);
            }
        }
    }
    if backup_saves {
        let source = safe_join(&target, "saves")?;
        if source.is_dir() {
            super::super::copy_tree(&source, &temporary.path().join("saves"), cancel)?;
        }
    }
    if record::snapshot(&target, cancel)? != *expected {
        bail!("备份期间本地文件发生变化，请重新检查");
    }
    archive::check_cancel(cancel)?;
    journal.state = "applying".into();
    let log = temporary.path().join("recovery.json");
    save(&log, &journal)?;
    // Once the durable intent exists, retain all backups even after a crash
    // or a failed rollback. TempDir must not remove recovery data on unwind.
    let directory = temporary.keep();
    let log = directory.join("recovery.json");
    let result = (|| {
        for change in &journal.changes {
            archive::check_cancel(cancel)?;
            let dest = safe_join(&target, &change.path)?;
            if record::hash(&dest, cancel)? != change.before {
                bail!("提交期间文件被其他程序修改：{}", change.path);
            }
            if change.after.is_some() {
                replace(&safe_join(stage, &change.path)?, &dest, cancel)?;
            } else if dest.is_file() {
                fs::remove_file(&dest)
                    .with_context(|| format!("无法移除旧文件：{}", change.path))?;
            }
        }
        journal.state = "completed".into();
        save(&log, &journal)
    })();
    if let Err(error) = result {
        let recovery = rollback(&target, &directory, &journal);
        journal.state = if recovery.is_ok() {
            "rolled_back".into()
        } else {
            "recovery_failed".into()
        };
        let _ = save(&log, &journal);
        if let Err(recovery) = recovery {
            bail!(
                "{error:#}；恢复未完成：{recovery:#}。恢复记录：{}",
                directory.display()
            );
        }
        return Err(error);
    }
    Ok(directory)
}

fn rollback(target: &Path, directory: &Path, journal: &Journal) -> Result<()> {
    let cancel = CancellationToken::new();
    // Preflight every file before restoring any. A later user modification is
    // never silently overwritten by an old completed update's rollback.
    for change in &journal.changes {
        let current = record::hash(&safe_join(target, &change.path)?, &cancel)?;
        if current != change.before && current != change.after {
            bail!("文件已被修改，无法自动恢复：{}", change.path);
        }
        if change.before.is_some()
            && record::hash(&safe_join(&directory.join("files"), &change.path)?, &cancel)?
                != change.before
        {
            bail!("备份文件缺失或损坏：{}", change.path);
        }
    }
    for change in journal.changes.iter().rev() {
        let dest = safe_join(target, &change.path)?;
        if record::hash(&dest, &cancel)? == change.before {
            continue;
        }
        if change.before.is_some() {
            replace(
                &safe_join(&directory.join("files"), &change.path)?,
                &dest,
                &cancel,
            )?;
        } else if dest.is_file() {
            fs::remove_file(dest)?;
        }
    }
    Ok(())
}

pub fn restore(root: &Path, id: &str, backup_id: &str) -> Result<PathBuf> {
    let _guard = operation_guard(root, id)?;
    let target = instance(root, id)?;
    let directory = safe_join(&history_root(root, id)?, backup_id)?;
    let log = safe_join(&directory, "recovery.json")?;
    let mut journal: Journal = serde_json::from_value(parser::read_json(&log)?)?;
    if !matches!(
        journal.state.as_str(),
        "completed" | "applying" | "recovery_failed"
    ) {
        bail!("此备份已经恢复或未提交");
    }
    for change in &journal.changes {
        let relative = archive::relative(&change.path)?;
        if relative != record::RECORD
            && (record::personal(&relative) || relative.starts_with(".tmcl/"))
        {
            bail!("恢复记录包含无效路径");
        }
        safe_join(&target, &relative)?;
    }
    rollback(&target, &directory, &journal)?;
    journal.state = "restored".into();
    save(&log, &journal)?;
    Ok(directory)
}
