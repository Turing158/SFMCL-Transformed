use crate::jobs::Job;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{path::Path, process::Stdio, sync::Arc, time::Instant};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandShell {
    Cmd,
    Powershell,
    Sh,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommandSettings {
    pub enabled: bool,
    pub shell: CommandShell,
    pub command: String,
    pub working_directory: String,
    pub timeout_seconds: u64,
    pub continue_on_failure: bool,
}
impl Default for CommandSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            shell: if cfg!(windows) {
                CommandShell::Cmd
            } else {
                CommandShell::Sh
            },
            command: String::new(),
            working_directory: String::new(),
            timeout_seconds: 60,
            continue_on_failure: false,
        }
    }
}
impl CommandSettings {
    pub fn after_exit() -> Self {
        Self {
            timeout_seconds: 300,
            ..Self::default()
        }
    }
    pub fn validate(&self) -> Result<()> {
        if !(1..=3600).contains(&self.timeout_seconds) {
            bail!("命令超时时间必须在 1–3600 秒之间");
        }
        if self.command.len() > 64 * 1024 || self.command.contains('\0') {
            bail!("命令内容过长或包含无效字符");
        }
        if self.working_directory.contains('\0') {
            bail!("命令工作目录包含无效字符");
        }
        if self.enabled && self.command.trim().is_empty() {
            bail!("启用执行命令时，请填写命令内容");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandPhase {
    PreLaunch,
    PostExit,
}
impl CommandPhase {
    pub fn label(self) -> &'static str {
        match self {
            Self::PreLaunch => "启动前命令",
            Self::PostExit => "退出后命令",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
    Skipped,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRun {
    pub status: CommandStatus,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub error: Option<String>,
}
impl CommandRun {
    pub fn pending(enabled: bool) -> Self {
        Self {
            status: if enabled {
                CommandStatus::Pending
            } else {
                CommandStatus::Skipped
            },
            exit_code: None,
            duration_ms: 0,
            error: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRuns {
    pub pre_launch: CommandRun,
    pub post_exit: CommandRun,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameExit {
    pub code: Option<i32>,
    pub reason: String,
}

#[derive(Debug)]
pub struct CommandFailure(pub String);
impl std::fmt::Display for CommandFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for CommandFailure {}

fn redact(value: &str, secrets: &[String]) -> String {
    let mut value = value.to_owned();
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        value = value.replace(secret, "[REDACTED]");
    }
    value
}

// Drain both streams even after the log limit is reached. A command that emits
// an unbounded line must not retain an unbounded allocation or block the pipe.
async fn pump(
    mut reader: impl AsyncRead + Unpin,
    job: Arc<Job>,
    label: &'static str,
    secrets: Vec<String>,
) {
    let mut buffer = [0; 4096];
    let mut line = Vec::new();
    let mut count = 0;
    while let Ok(length) = reader.read(&mut buffer).await {
        if length == 0 {
            break;
        }
        for &byte in &buffer[..length] {
            if byte == b'\n' {
                if count < 200 {
                    job.log(format!(
                        "[{label}] {}",
                        redact(
                            String::from_utf8_lossy(&line).trim_end_matches('\r'),
                            &secrets
                        )
                    ));
                }
                count += 1;
                line.clear();
            } else if line.len() < 4096 {
                line.push(byte);
            }
        }
    }
    if !line.is_empty() && count < 200 {
        job.log(format!(
            "[{label}] {}",
            redact(&String::from_utf8_lossy(&line), &secrets)
        ));
    }
}

#[cfg(windows)]
struct ProcessTree(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
impl ProcessTree {
    fn new(child: &tokio::process::Child) -> Result<Self> {
        use windows_sys::Win32::System::JobObjects::*;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let tree = Self(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let process = child.raw_handle().context("无法取得命令进程句柄")?;
        unsafe {
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, process as _) == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        Ok(tree)
    }
    fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
    fn release(&self) -> Result<()> {
        use windows_sys::Win32::System::JobObjects::*;
        let limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            SetInformationJobObject(
                self.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
}
#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(not(windows))]
struct ProcessTree(u32);
#[cfg(not(windows))]
impl ProcessTree {
    fn new(child: &tokio::process::Child) -> Result<Self> {
        Ok(Self(child.id().context("无法取得命令进程 ID")?))
    }
    fn terminate(&self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
    fn release(&self) -> Result<()> {
        Ok(())
    }
}

pub async fn execute(
    config: &CommandSettings,
    phase: CommandPhase,
    directory: &Path,
    java: &str,
    job: Arc<Job>,
    secrets: &[String],
    cancel: &CancellationToken,
) -> Result<()> {
    if !config.enabled {
        job.set_command_run(phase, CommandRun::pending(false));
        return Ok(());
    }
    let started = Instant::now();
    job.set_command_run(
        phase,
        CommandRun {
            status: CommandStatus::Running,
            ..CommandRun::pending(true)
        },
    );
    job.log(format!(
        "[{}] 开始执行（超时 {} 秒）",
        phase.label(),
        config.timeout_seconds
    ));
    let mut code = None;
    let result: Result<()> = async {
        config.validate()?;
        if cancel.is_cancelled() { bail!("命令已取消"); }
        let cwd = if config.working_directory.trim().is_empty() { directory.to_path_buf() } else { directory.join(config.working_directory.trim()) };
        if !cwd.is_dir() { bail!("命令工作目录不存在：{}", cwd.display()); }
        let mut command = match config.shell {
            CommandShell::Cmd => {
                #[cfg(not(windows))]
                bail!("当前系统不支持 CMD");
                #[cfg(windows)]
                {
                    // A private batch file preserves multiline CMD syntax and
                    // avoids the extra quoting rules of /C with a command string.
                    let mut command = tokio::process::Command::new("cmd.exe");
                    command.args(["/D", "/Q", "/C"]);
                    command
                }
            }
            CommandShell::Powershell => {
                let mut command = tokio::process::Command::new(if cfg!(windows) { "powershell.exe" } else { "pwsh" });
                command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
                command
            }
            CommandShell::Sh => {
                let command = tokio::process::Command::new("sh");
                command
            }
        };
        let extension = match config.shell { CommandShell::Cmd => ".cmd", CommandShell::Powershell => ".ps1", CommandShell::Sh => ".sh" };
        let script = tempfile::Builder::new().prefix("sfmcl-command-").suffix(extension).tempfile()?.into_temp_path();
        let content = match config.shell {
            CommandShell::Cmd => format!("@chcp 65001 >nul\r\n{}", config.command.replace("\r\n", "\n").replace('\n', "\r\n")),
            CommandShell::Powershell => format!("\u{feff}$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n{}\nif ($LASTEXITCODE) {{ exit $LASTEXITCODE }}\n", config.command),
            CommandShell::Sh => config.command.clone(),
        };
        std::fs::write(&script, content)?;
        let snapshot = job.snapshot();
        command.arg(script.as_os_str()).current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        command.env_remove("SFMCL_EXIT_CODE").env_remove("SFMCL_EXIT_REASON");
        command.env("SFMCL_GAME_DIR", directory).env("SFMCL_JAVA_PATH", java).env("SFMCL_SESSION_ID", &snapshot.id);
        if let Some(context) = &snapshot.launch {
            command.env("SFMCL_VERSION_ID", &context.version_id).env("SFMCL_PLAYER_NAME", &context.player_name);
        }
        if let Some(exit) = &snapshot.game_exit {
            command.env("SFMCL_EXIT_CODE", exit.code.map(|code| code.to_string()).unwrap_or_default()).env("SFMCL_EXIT_REASON", &exit.reason);
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().context("无法创建命令进程")?;
        let tree = match ProcessTree::new(&child) {
            Ok(tree) => tree,
            Err(error) => { let _ = child.kill().await; let _ = child.wait().await; return Err(error.context("无法管理命令进程")); }
        };
        let stdout = tokio::spawn(pump(child.stdout.take().context("无法读取命令输出")?, job.clone(), phase.label(), secrets.to_vec()));
        let stderr = tokio::spawn(pump(child.stderr.take().context("无法读取命令错误输出")?, job.clone(), phase.label(), secrets.to_vec()));
        let status = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(anyhow::anyhow!("命令已取消")),
            _ = tokio::time::sleep(std::time::Duration::from_secs(config.timeout_seconds)) => Err(anyhow::anyhow!("命令执行超时（{} 秒）", config.timeout_seconds)),
            status = child.wait() => status.context("等待命令进程失败"),
        };
        if status.is_err() {
            tree.terminate();
            let _ = child.kill().await;
            let _ = child.wait().await;
        } else { tree.release()?; }
        let mut stdout = stdout;
        let mut stderr = stderr;
        if tokio::time::timeout(std::time::Duration::from_secs(2), async { let _ = (&mut stdout).await; let _ = (&mut stderr).await; }).await.is_err() {
            stdout.abort(); stderr.abort();
        }
        let status = status?;
        code = status.code();
        if !status.success() { bail!("命令退出，错误码 {}", code.map(|code| code.to_string()).unwrap_or_else(|| "未知".into())); }
        Ok(())
    }.await;
    let error = result
        .as_ref()
        .err()
        .map(|error| redact(&format!("{error:#}"), secrets));
    let duration_ms = started.elapsed().as_millis() as u64;
    job.set_command_run(
        phase,
        CommandRun {
            status: if cancel.is_cancelled() {
                CommandStatus::Cancelled
            } else if result.is_ok() {
                CommandStatus::Completed
            } else {
                CommandStatus::Failed
            },
            exit_code: code,
            duration_ms,
            error: error.clone(),
        },
    );
    job.log(format!(
        "[{}] {} · {} ms · 退出码 {}",
        phase.label(),
        error.as_deref().unwrap_or("执行完成"),
        duration_ms,
        code.map(|code| code.to_string())
            .unwrap_or_else(|| "未知".into())
    ));
    if let Some(error) = error {
        if phase == CommandPhase::PreLaunch
            && (!config.continue_on_failure || cancel.is_cancelled())
        {
            return Err(CommandFailure(format!("{}失败：{error}", phase.label())).into());
        }
        job.log(format!("[{}] 警告：{error}", phase.label()));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
