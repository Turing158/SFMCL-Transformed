use std::sync::Mutex;
use tauri::Manager;

#[derive(Clone, Copy)]
struct Viewport {
    size: tauri::PhysicalSize<u32>,
    position: tauri::PhysicalPosition<i32>,
}

#[derive(Default)]
struct FrameState {
    enabled: Option<bool>,
    changing: bool,
    viewport: Option<Viewport>,
    restore: Option<Viewport>,
}

#[derive(Default)]
pub struct WindowFrame(Mutex<FrameState>);

fn viewport(window: &tauri::WebviewWindow) -> tauri::Result<Viewport> {
    Ok(Viewport {
        size: window.inner_size()?,
        position: window.inner_position()?,
    })
}

fn preserve_viewport(window: &tauri::WebviewWindow, saved: Viewport) -> tauri::Result<()> {
    window.set_size(saved.size)?;
    let inner = window.inner_position()?;
    let outer = window.outer_position()?;
    window.set_position(tauri::PhysicalPosition::new(
        saved.position.x - (inner.x - outer.x),
        saved.position.y - (inner.y - outer.y),
    ))
}

#[cfg(windows)]
fn rendering(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMNCRP_ENABLED, DWMWA_BORDER_COLOR, DWMWA_NCRENDERING_POLICY,
        DWMWA_TRANSITIONS_FORCEDISABLED, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    let hwnd = window.hwnd()?.0 as _;
    // Tao retains WS_CAPTION for native window behavior even without decorations.
    // Disabling DWM lets activation repaint a classic titlebar over the transparent
    // startup screen. Keep DWM enabled and hide only the shadow during animation.
    let policy = DWMNCRP_ENABLED;
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_NCRENDERING_POLICY as u32,
            &policy as *const _ as _,
            4,
        )
    };
    if result < 0 {
        return Err(anyhow::anyhow!(
            "Cannot update native frame rendering: 0x{:08X}",
            result as u32
        )
        .into());
    }
    let disabled = 1_i32;
    let no_border = 0xfffffffe_u32;
    let corners = DWMWCP_ROUND;
    unsafe {
        // Use the app's animation instead of a second Windows restore animation.
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            &disabled as *const _ as _,
            4,
        );
        // Windows 11 supports COLOR_NONE; older Windows ignores this attribute.
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR as u32,
            &no_border as *const _ as _,
            4,
        );
        // Tao couples corners to the shadow flag. Retain native rounding when
        // the shadow is hidden so the CSS animation can hand its corners back
        // without a square frame between the frontend and native updates.
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &corners as *const _ as _,
            4,
        );
    }
    Ok(())
}

#[cfg(not(windows))]
fn rendering(_: &tauri::WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

#[cfg(windows)]
mod atomic_frame {
    use super::Viewport;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                IsIconic, IsZoomed, NCCALCSIZE_PARAMS, SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE,
                WINDOWPOS, WM_NCCALCSIZE, WM_NCDESTROY, WM_WINDOWPOSCHANGING,
            },
        },
    };

    unsafe extern "system" fn client_top(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        _: usize,
    ) -> LRESULT {
        if message == WM_NCCALCSIZE && wparam != 0 && IsZoomed(hwnd) == 0 && IsIconic(hwnd) == 0 {
            let calculation = &mut *(lparam as *mut NCCALCSIZE_PARAMS);
            let top = calculation.rgrc[0].top;
            let result = DefSubclassProc(hwnd, message, wparam, lparam);
            // Tao leaves a 1-2px nonclient strip above undecorated Windows 11
            // windows with shadows. Let WebView2 paint that row as part of the
            // client instead of exposing the native black caption background.
            calculation.rgrc[0].top = top;
            return result;
        }
        if message == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(client_top), id);
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    unsafe extern "system" fn preserve_client(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _: usize,
        data: usize,
    ) -> LRESULT {
        if message == WM_WINDOWPOSCHANGING {
            let position = &mut *(lparam as *mut WINDOWPOS);
            if position.flags & SWP_FRAMECHANGED != 0 {
                let saved = &*(data as *const Viewport);
                let proposed = RECT {
                    left: saved.position.x,
                    top: saved.position.y,
                    right: saved.position.x + saved.size.width as i32,
                    bottom: saved.position.y + saved.size.height as i32,
                };
                let mut calculation = NCCALCSIZE_PARAMS {
                    rgrc: [proposed; 3],
                    lppos: position,
                };
                // Ask the updated Tao frame for its actual insets, including DPI
                // and Windows-version differences, before any WM_SIZE is sent.
                DefSubclassProc(hwnd, WM_NCCALCSIZE, 1, &mut calculation as *mut _ as LPARAM);
                let client = calculation.rgrc[0];
                position.x = saved.position.x - (client.left - proposed.left);
                position.y = saved.position.y - (client.top - proposed.top);
                position.cx = saved.size.width as i32
                    + (client.left - proposed.left)
                    + (proposed.right - client.right);
                position.cy = saved.size.height as i32
                    + (client.top - proposed.top)
                    + (proposed.bottom - client.bottom);
                position.flags &= !(SWP_NOMOVE | SWP_NOSIZE);
            }
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    pub fn update(
        window: &tauri::WebviewWindow,
        enabled: bool,
        saved: Option<Viewport>,
    ) -> tauri::Result<()> {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let main_window = window.clone();
        window.run_on_main_thread(move || {
            let result = (|| {
                let hwnd = main_window.hwnd()?.0 as HWND;
                if unsafe {
                    SetWindowSubclass(hwnd, Some(client_top), client_top as *const () as usize, 0)
                } == 0
                {
                    return Err(std::io::Error::last_os_error().into());
                }
                let subclass_id = preserve_client as *const () as usize;
                if let Some(saved) = &saved {
                    if unsafe {
                        SetWindowSubclass(
                            hwnd,
                            Some(preserve_client),
                            subclass_id,
                            saved as *const _ as usize,
                        )
                    } == 0
                    {
                        return Err(std::io::Error::last_os_error().into());
                    }
                }
                let result = (|| {
                    // On the window thread this runs synchronously. The scoped
                    // subclass compensates the outer rectangle in the same
                    // SetWindowPos that changes the nonclient frame. WebView2
                    // never sees a temporary size or responsive breakpoint.
                    // The owned layered window supplies the external shadow
                    // even when DWM omits shadows for transparent windows.
                    main_window.set_shadow(false)?;
                    super::rendering(&main_window)?;
                    crate::window_shadow::update(&main_window, enabled)?;
                    Ok(())
                })();
                if saved.is_some() {
                    unsafe { RemoveWindowSubclass(hwnd, Some(preserve_client), subclass_id) };
                }
                result
            })();
            let _ = sender.send(result);
        })?;
        receiver.recv().map_err(|error| anyhow::anyhow!(error))?
    }
}

#[cfg(not(windows))]
fn update_frame(
    window: &tauri::WebviewWindow,
    enabled: bool,
    saved: Option<Viewport>,
) -> tauri::Result<()> {
    window.set_shadow(enabled)?;
    if let Some(saved) = saved {
        preserve_viewport(window, saved)?;
    }
    Ok(())
}

pub fn set_visible(window: &tauri::WebviewWindow, enabled: bool) -> tauri::Result<()> {
    let minimized = window.is_minimized()?;
    let maximized = window.is_maximized()?;
    let saved = if !minimized && !maximized {
        Some(viewport(window)?)
    } else {
        None
    };
    let state = window.state::<WindowFrame>();
    {
        let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.changing {
            return Ok(());
        }
        if state.enabled == Some(enabled) {
            drop(state);
            #[cfg(windows)]
            return atomic_frame::update(window, enabled, None);
            #[cfg(not(windows))]
            return rendering(window);
        }
        state.changing = true;
        if let Some(saved) = saved {
            state.viewport = Some(saved);
        }
        if minimized && !enabled && state.enabled == Some(true) {
            // Do not resize an iconic window. Preserve its client geometry when
            // Windows restores it, before the frontend starts the entry motion.
            state.restore = state.viewport;
        }
    }
    #[cfg(windows)]
    let result = atomic_frame::update(window, enabled, saved);
    #[cfg(not(windows))]
    let result = update_frame(window, enabled, saved);
    let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
    state.changing = false;
    if result.is_ok() {
        state.enabled = Some(enabled);
    }
    result
}

pub fn observe(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let state = window.state::<WindowFrame>();
    if state.0.lock().unwrap_or_else(|e| e.into_inner()).changing {
        return Ok(());
    }
    if window.is_minimized()? {
        return set_visible(window, false);
    }
    if window.is_maximized()? {
        let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
        state.viewport = None;
        state.restore = None;
        drop(state);
        #[cfg(windows)]
        crate::window_shadow::schedule(window, false)?;
        return Ok(());
    }
    let saved = {
        let mut state = state.0.lock().unwrap_or_else(|e| e.into_inner());
        let saved = state.restore.take();
        if saved.is_some() {
            state.changing = true;
        }
        saved
    };
    if let Some(saved) = saved {
        let result = preserve_viewport(window, saved);
        state.0.lock().unwrap_or_else(|e| e.into_inner()).changing = false;
        result?;
    }
    let current = viewport(window)?;
    state.0.lock().unwrap_or_else(|e| e.into_inner()).viewport = Some(current);
    #[cfg(windows)]
    {
        let enabled = state.0.lock().unwrap_or_else(|e| e.into_inner()).enabled == Some(true);
        crate::window_shadow::schedule(window, enabled)?;
    }
    Ok(())
}
