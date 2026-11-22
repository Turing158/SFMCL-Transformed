use serde_json::Value;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Clone)]
pub struct SavedWindow {
    pub ui: Value,
    size: tauri::PhysicalSize<u32>,
    position: tauri::PhysicalPosition<i32>,
    maximized: bool,
}

#[derive(Default)]
pub struct WindowSession(Mutex<SessionState>);

#[derive(Default)]
struct SessionState {
    revision: u32,
    pending: Option<u32>,
    saved: Option<SavedWindow>,
    destroying: bool,
    rebuilding: bool,
    restore_requested: bool,
    resuspend: Option<String>,
    quit_event: Option<Value>,
}

impl SessionState {
    fn begin(&mut self, launch_id: &str) -> Option<u32> {
        if self.rebuilding {
            self.resuspend = Some(launch_id.into());
            return None;
        }
        if self.pending.is_some() || self.saved.is_some() || self.rebuilding {
            return None;
        }
        self.revision = self.revision.wrapping_add(1);
        self.pending = Some(self.revision);
        Some(self.revision)
    }

    fn accept(&mut self, id: u32) -> bool {
        if self.pending != Some(id) {
            return false;
        }
        self.pending = None;
        true
    }
}

pub fn suspend(app: &tauri::AppHandle, launch_id: &str) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let id = {
        let state = app.state::<WindowSession>();
        let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
        state.begin(launch_id)
    };
    let Some(id) = id else { return Ok(()) };
    // Acknowledge only after the launch fill reaches 100% and drafts are safe.
    let launch_id = serde_json::to_string(launch_id)?;
    if let Err(error) = window.eval(format!("window.__SFMCL_T_SUSPEND__({id}, {launch_id});")) {
        abort(app, id);
        return Err(error);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        if abort(&app, id) {
            eprintln!("Cannot suspend launcher: saving the interface timed out");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("sfmcl-t-session-error", "保存界面超时，已保留窗口。");
            }
        }
    });
    Ok(())
}

fn abort(app: &tauri::AppHandle, id: u32) -> bool {
    app.state::<WindowSession>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .accept(id)
}

#[tauri::command]
pub async fn suspend_launcher_window(
    window: tauri::WebviewWindow,
    id: u32,
    snapshot: Option<Value>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("此窗口不能操作启动器".into());
    }
    let app = window.app_handle().clone();
    let Some(ui) = snapshot else {
        abort(&app, id);
        return Ok(false);
    };
    let saved = SavedWindow {
        ui,
        size: window.inner_size().map_err(|e| e.to_string())?,
        position: window.outer_position().map_err(|e| e.to_string())?,
        maximized: window.is_maximized().map_err(|e| e.to_string())?,
    };
    {
        let state = app.state::<WindowSession>();
        let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if !state.accept(id) {
            return Ok(false);
        }
        state.saved = Some(saved);
    }
    if let Err(error) = crate::window_motion::request(&window, crate::window_motion::Action::Hide) {
        app.state::<WindowSession>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .saved = None;
        return Err(error.to_string());
    }
    Ok(true)
}

// The existing window transition calls this only after its exit animation.
pub fn hide(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle();
    {
        let state = app.state::<WindowSession>();
        let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.saved.is_none() || state.rebuilding {
            return window.hide();
        }
        state.destroying = true;
    }
    let result = window.hide().and_then(|_| {
        crate::window_frame::set_visible(&window, false)?;
        window.destroy()
    });
    if let Err(error) = result {
        let state = app.state::<WindowSession>();
        let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
        state.saved = None;
        state.destroying = false;
        return Err(error);
    }
    Ok(())
}

/// Returns true when rebuilding (or waiting for destruction) handles the show.
pub fn show(app: &tauri::AppHandle) -> tauri::Result<bool> {
    let saved = {
        let state = app.state::<WindowSession>();
        let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
        // A manual restore or an early game exit cancels an unacknowledged save.
        state.pending = None;
        state.resuspend = None;
        if state.saved.is_none() {
            return Ok(false);
        }
        // A restore during the exit animation keeps this WebView and reverses it.
        if !state.destroying && !state.rebuilding && app.get_webview_window("main").is_some() {
            state.saved = None;
            return Ok(false);
        }
        state.restore_requested = true;
        if state.destroying || state.rebuilding {
            return Ok(true);
        }
        state.rebuilding = true;
        state.saved.clone().unwrap()
    };
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = crate::create_main_window(&handle, Some(&saved)) {
            handle
                .state::<WindowSession>()
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .rebuilding = false;
            eprintln!("Cannot rebuild launcher window: {error}");
        }
    })?;
    Ok(true)
}

pub fn destroyed(app: &tauri::AppHandle) {
    let restore = {
        let state = app.state::<WindowSession>();
        let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
        state.destroying = false;
        state.restore_requested && state.saved.is_some()
    };
    if restore {
        if let Err(error) = show(app) {
            eprintln!("Cannot restore launcher: {error}");
        }
    }
}

pub fn restoring(app: &tauri::AppHandle) -> bool {
    app.state::<WindowSession>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .rebuilding
}

pub fn restore_geometry(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let saved = window
        .state::<WindowSession>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .saved
        .clone();
    if let Some(saved) = saved {
        window.set_size(saved.size)?;
        window.set_position(saved.position)?;
        if saved.maximized {
            window.maximize()?;
        }
    }
    Ok(())
}

pub fn restored(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let (event, resuspend) = {
        let state = window.state::<WindowSession>();
        let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
        state.saved = None;
        state.rebuilding = false;
        state.restore_requested = false;
        let resuspend = state.resuspend.take();
        (state.quit_event.take(), resuspend)
    };
    if let Some(launch_id) = resuspend {
        suspend(window.app_handle(), &launch_id)?;
    } else {
        if let Some(tray) = window.app_handle().tray_by_id("launcher") {
            tray.set_visible(false)?;
        }
        window.set_focus()?;
    }
    if let Some(event) = event {
        window.emit("sfmcl-t-quit", event)?;
    }
    Ok(())
}

pub fn queue_quit(app: &tauri::AppHandle, event: Value) -> bool {
    let state = app.state::<WindowSession>();
    let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if state.saved.is_none() {
        return false;
    }
    state.quit_event = Some(event);
    true
}

pub fn keep_alive(app: &tauri::AppHandle) -> bool {
    app.state::<WindowSession>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .saved
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_suspends_and_stale_acknowledgements_are_ignored() {
        let mut state = SessionState::default();
        let first = state.begin("first-game").unwrap();
        assert_eq!(state.begin("first-game"), None);
        state.pending = None; // restore before the frontend finishes saving
        let second = state.begin("second-game").unwrap();
        assert!(!state.accept(first));
        assert!(state.accept(second));
        assert!(!state.accept(second));
    }

    #[test]
    fn a_game_start_during_rebuild_waits_until_the_new_interface_is_ready() {
        let mut state = SessionState {
            rebuilding: true,
            ..Default::default()
        };
        assert_eq!(state.begin("game"), None);
        assert_eq!(state.resuspend.as_deref(), Some("game"));
        state.rebuilding = false;
        assert!(state.begin("game").is_some());
    }
}
