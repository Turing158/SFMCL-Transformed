use crate::jobs::Job;
use anyhow::{bail, Context, Result};
use std::{path::Path, process::Stdio, sync::Arc};
use tokio::io::{AsyncBufReadExt, BufReader};

pub enum LaunchEvent {
    Started { action: String, restore: bool },
    Exited,
}
pub type LaunchEvents = tokio::sync::mpsc::UnboundedSender<LaunchEvent>;
struct ExitEvent(Option<LaunchEvents>);
impl Drop for ExitEvent {
    fn drop(&mut self) {
        if let Some(events) = &self.0 {
            let _ = events.send(LaunchEvent::Exited);
        }
    }
}

async fn pump(reader: impl tokio::io::AsyncRead + Unpin, job: Arc<Job>, redactions: Vec<String>) {
    let mut reader = BufReader::new(reader);
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        match reader.read_until(b'\n', &mut bytes).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        // Java 8/17 and third-party loaders can emit the Windows code page.
        // Invalid UTF-8 must not stop draining either process output pipe.
        let mut line = String::from_utf8_lossy(&bytes)
            .trim_end_matches(['\r', '\n'])
            .to_owned();
        for token in &redactions {
            if !token.is_empty() {
                line = line.replace(token, "[REDACTED]");
            }
        }
        if line.len() > 4000 {
            line = line.chars().take(4000).collect();
        }
        job.log(line);
    }
}

pub async fn run_java(
    java: &str,
    args: &[String],
    directory: &Path,
    job: Arc<Job>,
    redactions: &[String],
) -> Result<i32> {
    run_java_with_title(java, args, directory, job, redactions, "").await
}

pub async fn run_java_with_title(
    java: &str,
    args: &[String],
    directory: &Path,
    job: Arc<Job>,
    redactions: &[String],
    title: &str,
) -> Result<i32> {
    let settings = crate::config::Settings {
        window_title: title.into(),
        ..Default::default()
    };
    run_java_with_settings(java, args, directory, job, redactions, &settings, None).await
}

pub async fn run_java_with_settings(
    java: &str,
    args: &[String],
    directory: &Path,
    job: Arc<Job>,
    redactions: &[String],
    settings: &crate::config::Settings,
    events: Option<LaunchEvents>,
) -> Result<i32> {
    let mut child = super::java::command(super::java::executable(java))
        .args(args)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("无法启动 Java 进程")?;
    let pid = child.id().unwrap_or(0);
    if let Err(e) = super::window::set_priority(pid, &settings.process_priority) {
        job.log(format!("设置游戏进程优先级失败，继续使用系统默认值：{e}"));
    }
    if let Some(events) = &events {
        let _ = events.send(LaunchEvent::Started {
            action: settings.launcher_action.clone(),
            restore: settings.restore_launcher,
        });
    }
    let _exit = ExitEvent(events);
    let mut window = super::window::Controller::new(settings, directory, job.clone());
    let out = child.stdout.take().context("无法读取 Java 输出")?;
    let err = child.stderr.take().context("无法读取 Java 错误输出")?;
    let stdout = tokio::spawn(pump(out, job.clone(), redactions.to_vec()));
    let stderr = tokio::spawn(pump(err, job.clone(), redactions.to_vec()));
    let mut title_tick = tokio::time::interval(std::time::Duration::from_secs(1));
    let status = loop {
        let status = tokio::select! {
            status = child.wait() => Some(status?),
            _ = job.cancel.cancelled() => { child.kill().await?; child.wait().await?; stdout.abort(); stderr.abort(); bail!("{}，Java 进程已停止", job.cancellation_message()); }
            _ = title_tick.tick() => { window.tick(pid); None }
        };
        if let Some(status) = status {
            break status;
        }
    };
    stdout.await?;
    stderr.await?;
    let code = status.code().unwrap_or(-1);
    if !status.success() {
        bail!("Java 进程退出，错误码 {code}。请查看任务日志");
    }
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[tokio::test]
    async fn lifecycle_events_start_only_after_spawn_and_always_pair_with_exit() {
        let directory = tempfile::tempdir().unwrap();
        let jobs = crate::jobs::Jobs::default();
        let settings = crate::config::Settings {
            launcher_action: "tray".into(),
            ..Default::default()
        };
        for code in [0, 7] {
            let job = jobs.create(crate::jobs::JobKind::Launch, "events".into(), &["running"]);
            let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
            let result = run_java_with_settings(
                "cmd.exe",
                &["/D".into(), "/C".into(), format!("exit {code}")],
                directory.path(),
                job,
                &[],
                &settings,
                Some(events),
            )
            .await;
            assert_eq!(result.is_ok(), code == 0);
            assert!(
                matches!(receiver.recv().await,Some(LaunchEvent::Started { action,restore:true }) if action=="tray")
            );
            assert!(matches!(receiver.recv().await, Some(LaunchEvent::Exited)));
            assert!(receiver.recv().await.is_none());
        }
        let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let job = jobs.create(
            crate::jobs::JobKind::Launch,
            "failed spawn".into(),
            &["running"],
        );
        assert!(run_java_with_settings(
            "nonexistent-sfmcl-java.exe",
            &[],
            directory.path(),
            job,
            &[],
            &settings,
            Some(events)
        )
        .await
        .is_err());
        assert!(receiver.recv().await.is_none());
    }
    #[tokio::test]
    async fn non_utf8_log_lines_do_not_drop_subsequent_output_or_expose_tokens() {
        let jobs = crate::jobs::Jobs::default();
        let job = jobs.create(crate::jobs::JobKind::Other, "test".into(), &["running"]);
        let output = b"before\r\nlocal \xff\xfe token-secret\r\nafter\n";
        pump(&output[..], job.clone(), vec!["token-secret".into()]).await;
        let log = job.snapshot().log;
        assert_eq!(log.len(), 3);
        assert_eq!(log[0], "before");
        assert!(log[1].contains("[REDACTED]"));
        assert!(!log[1].contains("token-secret"));
        assert_eq!(log[2], "after");
    }
}
