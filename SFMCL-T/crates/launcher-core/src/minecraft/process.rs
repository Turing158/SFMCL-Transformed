use crate::jobs::Job;
use anyhow::{bail, Context, Result};
use std::{path::Path, process::Stdio, sync::Arc};
use tokio::io::{AsyncBufReadExt, BufReader};

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
    let mut child = super::java::command(super::java::executable(java))
        .args(args)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("无法启动 Java 进程")?;
    let out = child.stdout.take().context("无法读取 Java 输出")?;
    let err = child.stderr.take().context("无法读取 Java 错误输出")?;
    let stdout = tokio::spawn(pump(out, job.clone(), redactions.to_vec()));
    let stderr = tokio::spawn(pump(err, job.clone(), redactions.to_vec()));
    let pid = child.id().unwrap_or(0);
    let mut title_tick = tokio::time::interval(std::time::Duration::from_secs(1));
    let status = loop {
        let status = tokio::select! {
            status = child.wait() => Some(status?),
            _ = job.cancel.cancelled() => { child.kill().await?; child.wait().await?; stdout.abort(); stderr.abort(); bail!("{}，Java 进程已停止", job.cancellation_message()); }
            _ = title_tick.tick() => { if !title.is_empty() { set_window_title(pid, title); } None }
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

#[cfg(windows)]
fn set_window_title(pid: u32, title: &str) {
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM},
        UI::WindowsAndMessaging::*,
    };
    struct WindowTitle {
        pid: u32,
        title: Vec<u16>,
    }
    unsafe extern "system" fn visit(window: HWND, data: LPARAM) -> i32 {
        let data = &*(data as *const WindowTitle);
        let mut pid = 0;
        GetWindowThreadProcessId(window, &mut pid);
        if pid == data.pid && IsWindowVisible(window) != 0 {
            SetWindowTextW(window, data.title.as_ptr());
        }
        1
    }
    let data = WindowTitle {
        pid,
        title: title.encode_utf16().chain(Some(0)).collect(),
    };
    unsafe {
        EnumWindows(Some(visit), &data as *const _ as LPARAM);
    }
}
#[cfg(not(windows))]
fn set_window_title(_: u32, _: &str) {}

#[cfg(test)]
mod tests {
    use super::*;
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
