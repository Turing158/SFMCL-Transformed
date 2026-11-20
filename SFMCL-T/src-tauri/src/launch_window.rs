use sfmcl_t_core::minecraft::process::LaunchEvent;
use std::sync::atomic::{AtomicU8, Ordering};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
const IDLE: u8 = 0;
const CONFIRMING: u8 = 1;
const QUITTING: u8 = 2;
static QUIT_STATE: AtomicU8 = AtomicU8::new(IDLE);
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum QuitEvent {
    Confirm,
    Error { message: String },
}

#[derive(Default)]
pub struct LaunchWindows(Mutex<WindowState>);
#[derive(Default)]
struct WindowState {
    games: HashMap<String, bool>,
    changed: bool,
    restore: bool,
}

impl WindowState {
    fn started(&mut self, id: &str, restore: bool) {
        self.games.insert(id.into(), restore);
        self.changed = true;
        self.restore |= restore;
    }
    fn exited(&mut self, id: &str) -> bool {
        self.games.remove(id);
        let restore = self.games.is_empty() && self.changed && self.restore;
        if self.games.is_empty() {
            self.restore = false;
        }
        restore
    }
}

pub fn show(app: &tauri::AppHandle) -> tauri::Result<()> {
    if !crate::window_session::show(app)? {
        if let Some(window) = app.get_webview_window("main") {
            crate::window_motion::request(&window, crate::window_motion::Action::Show)?;
        }
    }
    app.state::<LaunchWindows>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .changed = false;
    Ok(())
}

pub fn quit(app: tauri::AppHandle) {
    if QUIT_STATE
        .compare_exchange(IDLE, QUITTING, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let runtime = app.state::<Arc<crate::commands::Runtime>>().inner().clone();
    if runtime.multiplayer.active() {
        QUIT_STATE.store(CONFIRMING, Ordering::Release);
        if let Err(error) = notify_quit(&app, QuitEvent::Confirm) {
            QUIT_STATE.store(IDLE, Ordering::Release);
            eprintln!("Cannot request launcher quit confirmation: {error}");
        }
    } else {
        finish_quit(app, runtime);
    }
}

fn notify_quit(app: &tauri::AppHandle, event: QuitEvent) -> tauri::Result<()> {
    // Tray exits must restore the window before showing the in-app dialog.
    if crate::window_session::queue_quit(app, serde_json::to_value(&event)?) {
        return show(app);
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| tauri::Error::AssetNotFound("启动器主窗口".into()))?;
    if !window.is_visible()? || window.is_minimized()? {
        show(app)?;
    }
    window.emit("sfmcl-t-quit", event)
}

#[tauri::command]
pub fn resolve_launcher_quit(window: tauri::WebviewWindow, confirmed: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("此窗口不能操作启动器".into());
    }
    let next = if confirmed { QUITTING } else { IDLE };
    // Ignore repeated responses, including while shutdown is already running.
    if QUIT_STATE
        .compare_exchange(CONFIRMING, next, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
        && confirmed
    {
        let app = window.app_handle().clone();
        let runtime = app.state::<Arc<crate::commands::Runtime>>().inner().clone();
        finish_quit(app, runtime);
    }
    Ok(())
}

fn finish_quit(app: tauri::AppHandle, runtime: Arc<crate::commands::Runtime>) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = runtime.multiplayer.shutdown().await {
            QUIT_STATE.store(IDLE, Ordering::Release);
            if let Err(error) = notify_quit(
                &app,
                QuitEvent::Error {
                    message: format!("联机尚未结束：{error}"),
                },
            ) {
                eprintln!("Cannot report launcher quit failure: {error}");
            }
            return;
        }
        if let Err(error) = runtime.downloads.pause_all().await {
            eprintln!("Cannot pause downloads: {error}");
        }
        app.exit(0);
    });
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    app.manage(LaunchWindows::default());
    let show_item = MenuItem::with_id(app, "show-launcher", "显示启动器", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit-launcher", "退出启动器", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("启动器托盘图标".into()))?;
    let tray = TrayIconBuilder::with_id("launcher")
        .icon(icon)
        .tooltip("SFMCL-T · 点击恢复启动器")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show-launcher" => {
                if let Err(e) = show(app) {
                    eprintln!("Cannot restore launcher: {e}");
                }
            }
            "quit-launcher" => quit(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if let Err(e) = show(tray.app_handle()) {
                    eprintln!("Cannot restore launcher: {e}");
                }
            }
        })
        .build(app)?;
    tray.set_visible(false)?;
    Ok(())
}

pub fn event(app: &tauri::AppHandle, id: &str, event: LaunchEvent) -> tauri::Result<()> {
    let state = app.state::<LaunchWindows>();
    match event {
        LaunchEvent::Started {
            action, restore, ..
        } => {
            if action == "keep" {
                return Ok(());
            }
            if action == "tray" {
                let tray = app
                    .tray_by_id("launcher")
                    .ok_or_else(|| tauri::Error::AssetNotFound("启动器托盘".into()))?;
                // Keep a recovery entry before releasing the main WebView.
                tray.set_visible(true)?;
                state
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .started(id, restore);
                crate::window_session::suspend(app)?;
            } else if let Some(window) = app.get_webview_window("main") {
                crate::window_motion::request(&window, crate::window_motion::Action::Minimize)?;
                state
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .started(id, restore);
            }
        }
        LaunchEvent::Exited => {
            let restore = {
                let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
                state.exited(id)
            };
            if restore {
                show(app)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn waits_for_all_games_before_restoring_and_respects_opt_out() {
        let mut state = WindowState::default();
        state.started("first", true);
        state.started("second", false);
        assert!(!state.exited("first"));
        assert!(state.exited("second"));
        state.started("third", false);
        assert!(!state.exited("third"));
    }
    #[test]
    fn manual_tray_restore_does_not_focus_the_window_again_on_game_exit() {
        let mut state = WindowState::default();
        state.started("game", true);
        state.changed = false;
        assert!(!state.exited("game"));
        assert!(!state.exited("failed-spawn"));
        state.started("next", true);
        assert!(state.exited("next"));
    }
}
