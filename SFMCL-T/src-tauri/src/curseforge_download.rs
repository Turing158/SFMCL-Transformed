use anyhow::{Context, Result};
use sfmcl_t_core::resources::curseforge::{is_download_cdn, is_download_entry, is_website_url};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{
    webview::{DownloadEvent, NewWindowResponse},
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tokio::sync::oneshot;

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);
type Reply = Arc<Mutex<Option<oneshot::Sender<Result<String, String>>>>>;

fn finish(reply: &Reply, result: Result<String, String>) {
    if let Some(sender) = reply.lock().unwrap().take() {
        let _ = sender.send(result);
    }
}

fn capture(reply: &Reply, url: &str) -> bool {
    if is_download_cdn(url) {
        finish(reply, Ok(url.into()));
        true
    } else {
        false
    }
}

struct ResolverWindow(WebviewWindow);
impl Drop for ResolverWindow {
    fn drop(&mut self) {
        // Also clean up on timeout or when the requesting future is cancelled.
        let _ = self.0.destroy();
    }
}

/// Run the website's redirects in an isolated webview, then let the normal
/// download manager handle the file. No API credential is used in this webview.
pub async fn resolve(app: &tauri::AppHandle, url: &str) -> Result<String> {
    if !is_download_entry(url) {
        return Ok(url.into());
    }
    let (sender, receiver) = oneshot::channel();
    let reply: Reply = Arc::new(Mutex::new(Some(sender)));
    let navigation = reply.clone();
    let download = reply.clone();
    let popup = reply.clone();
    let label = format!(
        "curseforge-download-{}",
        NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)
    );
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url.parse()?))
        .title("CurseForge 下载")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .incognito(true)
        .on_navigation(move |url| {
            if capture(&navigation, url.as_str()) {
                return false;
            }
            if is_website_url(url.as_str()) {
                return true;
            }
            finish(
                &navigation,
                Err("CurseForge 返回了无法识别的下载跳转，请到项目官网重试".into()),
            );
            false
        })
        .on_new_window(move |url, _| {
            capture(&popup, url.as_str());
            NewWindowResponse::Deny
        })
        .on_download(move |_, event| {
            if let DownloadEvent::Requested { url, .. } = event {
                if !capture(&download, url.as_str()) {
                    finish(
                        &download,
                        Err("CurseForge 未返回有效的文件下载地址，请到项目官网重试".into()),
                    );
                }
            }
            // Never save a webpage or let WebView2 start a second download.
            false
        })
        .build()
        .context("无法打开 CurseForge 下载入口，请重试或前往项目官网")?;
    let _window = ResolverWindow(window);
    let result = tokio::time::timeout(Duration::from_secs(20), receiver)
        .await
        .context("获取 CurseForge 下载地址超时，网站可能需要验证，请到项目官网下载")?
        .context("获取 CurseForge 下载地址已中断，请重试")?;
    result.map_err(anyhow::Error::msg)
}
