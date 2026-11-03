use std::{sync::Mutex, time::Duration};
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Minimize,
    Hide,
    Show,
}

#[derive(Clone, Copy, serde::Serialize)]
struct Transition {
    id: u32,
    action: Action,
}

#[derive(Default)]
pub struct WindowMotion(Mutex<MotionState>);

#[derive(Default)]
struct MotionState {
    next_id: u32,
    current: Option<(Transition, bool)>,
}

impl MotionState {
    fn begin(&mut self, action: Action) -> Option<Transition> {
        if self
            .current
            .is_some_and(|(current, applied)| current.action == action && !applied)
        {
            return None;
        }
        self.next_id += 1;
        let transition = Transition {
            id: self.next_id,
            action,
        };
        self.current = Some((transition, false));
        Some(transition)
    }

    fn pending(&self, id: u32) -> Option<Action> {
        self.current
            .filter(|(current, applied)| current.id == id && !applied)
            .map(|(current, _)| current.action)
    }

    fn applied(&mut self, id: u32) -> bool {
        if let Some((current, applied)) = &mut self.current {
            if current.id == id {
                *applied = true;
                return true;
            }
        }
        false
    }

    fn can_finish(&self, id: Option<u32>) -> bool {
        match (self.current, id) {
            (None, None) => true,
            (Some((current, true)), Some(id)) => current.id == id && current.action == Action::Show,
            (Some((current, true)), None) => current.action != Action::Show,
            _ => false,
        }
    }

    fn cancel(&mut self, id: u32) -> bool {
        if self
            .current
            .is_some_and(|(current, applied)| current.id == id && !applied)
        {
            self.current = None;
            return true;
        }
        false
    }
}

pub fn finish(window: &tauri::WebviewWindow, id: Option<u32>) -> tauri::Result<()> {
    let state = window.state::<WindowMotion>();
    let state = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if state.can_finish(id) && window.is_visible()? && !window.is_minimized()? {
        crate::window_frame::set_visible(window, true)?;
    }
    Ok(())
}

pub fn reset_for_startup(window: &tauri::WebviewWindow) {
    // Keep the generation counter so an old fallback cannot affect a reloaded UI.
    window
        .state::<WindowMotion>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .current = None;
}

fn complete(window: &tauri::WebviewWindow, id: u32) -> tauri::Result<bool> {
    let state = window.state::<WindowMotion>();
    let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(action) = state.pending(id) {
        match action {
            Action::Minimize => window.minimize()?,
            Action::Hide => window.hide()?,
            Action::Show => {
                window.show()?;
                window.unminimize()?;
                window.set_focus()?;
                // Keep the recovery icon until the native window is visible.
                if let Some(tray) = window.app_handle().tray_by_id("launcher") {
                    tray.set_visible(false)?;
                }
            }
        }
    }
    // A timeout may already have applied this same transition. Acknowledge it
    // without repeating the native operation, but reject superseded requests.
    Ok(state.applied(id))
}

pub fn request(window: &tauri::WebviewWindow, action: Action) -> tauri::Result<()> {
    let transition = {
        let state = window.state::<WindowMotion>();
        let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
        state.begin(action)
    };
    let Some(transition) = transition else {
        return Ok(());
    };
    crate::window_frame::set_visible(window, false)?;
    if window
        .emit("sfmcl-t-window-transition", transition)
        .is_err()
    {
        complete(window, transition.id)?;
        return Ok(());
    }
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        // An unavailable or suspended webview must never prevent window control.
        tokio::time::sleep(Duration::from_millis(900)).await;
        if let Err(error) = complete(&window, transition.id) {
            eprintln!("Cannot finish launcher window transition: {error}");
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn minimize_window(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("此窗口不能操作启动器".into());
    }
    request(&window, Action::Minimize).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn complete_window_transition(
    window: tauri::WebviewWindow,
    id: u32,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("此窗口不能操作启动器".into());
    }
    complete(&window, id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn finish_window_transition(
    window: tauri::WebviewWindow,
    id: Option<u32>,
    cancel: Option<bool>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("此窗口不能操作启动器".into());
    }
    let id = if cancel.unwrap_or(false) {
        let state = window.state::<WindowMotion>();
        if !id.is_some_and(|id| state.0.lock().unwrap_or_else(|e| e.into_inner()).cancel(id)) {
            return Ok(());
        }
        None
    } else {
        id
    };
    finish(&window, id).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restoring_supersedes_pending_hide_and_its_timeout() {
        let mut state = MotionState::default();
        let hide = state.begin(Action::Hide).unwrap();
        let show = state.begin(Action::Show).unwrap();
        assert!(state.pending(hide.id).is_none());
        assert!(!state.applied(hide.id));
        assert!(matches!(state.pending(show.id), Some(Action::Show)));
        assert!(state.applied(show.id));
    }

    #[test]
    fn repeated_clicks_share_the_pending_transition() {
        let mut state = MotionState::default();
        let minimize = state.begin(Action::Minimize).unwrap();
        assert!(state.begin(Action::Minimize).is_none());
        assert!(state.applied(minimize.id));
        assert!(state.pending(minimize.id).is_none());
        // A delayed frontend acknowledgement of the fallback remains valid.
        assert!(state.applied(minimize.id));
        assert!(state.begin(Action::Minimize).is_some());
    }

    #[test]
    fn only_the_current_completed_show_can_restore_the_frame() {
        let mut state = MotionState::default();
        assert!(state.can_finish(None));
        let show = state.begin(Action::Show).unwrap();
        assert!(!state.can_finish(Some(show.id)));
        state.applied(show.id);
        assert!(state.can_finish(Some(show.id)));
        assert!(!state.can_finish(None));
        let hide = state.begin(Action::Hide).unwrap();
        assert!(!state.can_finish(Some(show.id)));
        assert!(!state.can_finish(None));
        state.applied(hide.id);
        // An OS restore has no frontend-issued transition ID.
        assert!(state.can_finish(None));
    }

    #[test]
    fn cancelled_failed_hide_cannot_run_from_its_fallback() {
        let mut state = MotionState::default();
        let hide = state.begin(Action::Hide).unwrap();
        assert!(state.cancel(hide.id));
        assert!(state.pending(hide.id).is_none());
        assert!(!state.applied(hide.id));
        assert!(state.can_finish(None));
    }
}
