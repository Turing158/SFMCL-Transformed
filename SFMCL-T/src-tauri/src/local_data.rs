use crate::commands::Runtime;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sfmcl_t_core::{
    downloads::Status,
    local_data::{self as data, BackupInfo, OperationKind, OperationResult},
    paths::atomic_write,
};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

const HELPER_ARGUMENT: &str = "--sfmcl-t-data-operation";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    id: String,
    kind: OperationKind,
    path: PathBuf,
    backup: Option<BackupInfo>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Transfer {
    operation: Prepared,
    source: PathBuf,
    control: PathBuf,
    key: String,
    args: Vec<String>,
}

pub struct DataManager {
    _profile_lock: File,
    control: PathBuf,
    key: String,
    prepared: Mutex<Option<Prepared>>,
    executing: AtomicBool,
    pub result: Option<OperationResult>,
}

impl DataManager {
    pub fn new(default: &Path, directory: &Path) -> Result<Self> {
        let profile_lock = data::lock_profile(directory)?;
        let control = data::control_directory(default)?;
        let key = data::location_key(sfmcl_t_core::brand::environment("DATA_DIR").as_deref());
        let result_path = control.join(format!("{key}-result.json"));
        let result = if result_path.is_file() {
            let result =
                serde_json::from_slice(&fs::read(&result_path)?).context("本地数据操作结果损坏")?;
            fs::remove_file(result_path)?;
            Some(result)
        } else {
            None
        };
        Ok(Self {
            _profile_lock: profile_lock,
            control,
            key,
            prepared: Mutex::new(None),
            executing: AtomicBool::new(false),
            result,
        })
    }

    pub fn executing(&self) -> bool {
        self.executing.load(Ordering::Acquire)
    }
}

async fn ensure_idle(runtime: &Runtime) -> Result<()> {
    if runtime.multiplayer.active() {
        bail!("请先结束联机，再操作本地数据");
    }
    let active_downloads = runtime.downloads.snapshots().await.iter().any(|download| {
        matches!(
            download.status,
            Status::Queued | Status::Running | Status::Pausing
        )
    });
    if active_downloads
        || runtime
            .jobs
            .snapshots()
            .iter()
            .any(|job| !job.status.terminal())
    {
        bail!("请先结束正在运行的游戏、下载、安装或登录任务，再操作本地数据");
    }
    Ok(())
}

pub async fn prepare(
    app: &tauri::AppHandle,
    runtime: &Runtime,
    kind: OperationKind,
    path: PathBuf,
) -> Result<serde_json::Value> {
    ensure_idle(runtime).await?;
    if kind != OperationKind::Backup {
        let executable = data::absolute_path(&tauri::process::current_binary(&app.env())?)?;
        if executable.starts_with(&runtime.directory) {
            bail!("启动器程序位于本地数据目录中，请先将程序移至该目录之外");
        }
    }
    let source = runtime.directory.clone();
    let operation = tauri::async_runtime::spawn_blocking(move || -> Result<Prepared> {
        let path = data::validate_destination(&source, &path, kind)?;
        let backup = if kind == OperationKind::Restore {
            Some(data::inspect_backup(&path)?)
        } else {
            None
        };
        Ok(Prepared {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            path,
            backup,
        })
    })
    .await??;
    let value = serde_json::to_value(&operation)?;
    *app.state::<DataManager>()
        .prepared
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(operation);
    Ok(value)
}

pub async fn execute(
    app: tauri::AppHandle,
    runtime: Arc<Runtime>,
    id: &str,
) -> Result<serde_json::Value> {
    let manager = app.state::<DataManager>();
    let operation = manager
        .prepared
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .filter(|operation| operation.id == id)
        .cloned()
        .context("操作信息已过期，请重新选择目标路径")?;
    if manager
        .executing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        bail!("本地数据操作已开始");
    }
    let result = async {
        runtime.multiplayer.begin_maintenance()?;
        ensure_idle(&runtime).await?;
        data::validate_destination(&runtime.directory, &operation.path, operation.kind)?;
        // The frontend flushed edits; persist even a fresh profile's default settings.
        runtime.settings.save(runtime.settings.get())?;
        runtime.downloads.pause_all().await?;
        let transfer = Transfer {
            operation,
            source: runtime.directory.clone(),
            control: manager.control.clone(),
            key: manager.key.clone(),
            args: app
                .env()
                .args_os
                .iter()
                .skip(1)
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect(),
        };
        let job = manager
            .control
            .join(format!("{}-operation.json", transfer.operation.id));
        fs::create_dir_all(&manager.control)?;
        atomic_write(&job, &serde_json::to_vec(&transfer)?)?;
        let mut command = Command::new(tauri::process::current_binary(&app.env())?);
        command
            .arg(HELPER_ARGUMENT)
            .arg(&job)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        if let Err(error) = command.spawn() {
            let _ = fs::remove_file(job);
            return Err(error).context("无法启动本地数据操作，原数据未改变");
        }
        *manager
            .prepared
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            crate::launch_window::quit(app);
        });
        Ok(serde_json::json!({ "restarting": true }))
    }
    .await;
    if result.is_err() {
        runtime.multiplayer.end_maintenance();
        manager.executing.store(false, Ordering::Release);
    }
    result
}

fn perform(transfer: &Transfer) -> Result<OperationResult> {
    let _control_lock = data::lock_control(&transfer.control)?;
    let start = Instant::now();
    let profile_lock = loop {
        match data::lock_profile(&transfer.source) {
            Ok(lock) => break lock,
            Err(error) if start.elapsed() >= Duration::from_secs(30) => return Err(error),
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    // The WebView process releases its database handles shortly after the UI exits.
    std::thread::sleep(Duration::from_millis(500));
    let operation = &transfer.operation;
    let mut recovery_path = None;
    let message = match operation.kind {
        OperationKind::Backup => {
            data::backup(&transfer.source, &operation.path)?;
            "本地数据备份完成".to_owned()
        }
        OperationKind::Migrate => {
            let original = data::migrate(
                &transfer.source,
                &operation.path,
                &transfer.control,
                &transfer.key,
            )?;
            drop(profile_lock);
            if let Some(original) = original {
                if let Err(error) = data::remove_original(&original) {
                    recovery_path = Some(original);
                    return Ok(OperationResult {
                        kind: operation.kind,
                        success: true,
                        message: format!("本地数据已迁移；{error:#}"),
                        path: operation.path.clone(),
                        recovery_path,
                    });
                }
            }
            "本地数据已迁移，新路径已生效".to_owned()
        }
        OperationKind::Restore => {
            // Windows cannot rename a directory containing our open lock file.
            // The control lock still excludes launches and other transfers.
            drop(profile_lock);
            recovery_path = Some(data::restore(
                &transfer.source,
                &operation.path,
                &transfer.control,
            )?);
            "本地数据已还原，原数据副本已保留".to_owned()
        }
    };
    Ok(OperationResult {
        kind: operation.kind,
        success: true,
        message,
        path: operation.path.clone(),
        recovery_path,
    })
}

/// Invoked before Tauri creates a window. The helper inherits the original environment.
pub fn run_helper() -> bool {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(HELPER_ARGUMENT)) {
        return false;
    }
    let result = (|| -> Result<()> {
        let job = PathBuf::from(args.next().context("缺少本地数据操作记录")?);
        let transfer: Transfer = serde_json::from_slice(&fs::read(&job)?)?;
        if job.parent() != Some(transfer.control.as_path())
            || job.file_name().is_none_or(|name| {
                name != format!("{}-operation.json", transfer.operation.id).as_str()
            })
        {
            bail!("本地数据操作记录路径不匹配");
        }
        let result = perform(&transfer).unwrap_or_else(|error| OperationResult {
            kind: transfer.operation.kind,
            success: false,
            message: format!("本地数据操作未完成：{error:#}"),
            path: transfer.operation.path.clone(),
            recovery_path: None,
        });
        atomic_write(
            &transfer
                .control
                .join(format!("{}-result.json", transfer.key)),
            &serde_json::to_vec(&result)?,
        )?;
        fs::remove_file(&job)?;
        let mut command = Command::new(std::env::current_exe()?);
        command
            .args(transfer.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
            .spawn()
            .context("操作结束，但无法自动重新打开启动器，请手动打开")?;
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("{error:#}");
    }
    true
}
