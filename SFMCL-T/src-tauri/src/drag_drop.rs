//! Windows OLE bridge for authlib-injector cards and the existing file importer.
//! WebView2's HTML drag events are bypassed by Wry's native file-only drop target.
use std::{cell::RefCell, ffi::OsString, os::windows::ffi::OsStringExt, path::PathBuf};
use tauri::{Emitter, EventTarget};
use windows::{
    core::{implement, w, Ref, BOOL},
    Win32::{
        Foundation::{DRAGDROP_E_INVALIDHWND, HWND, LPARAM, POINT, POINTL},
        Graphics::Gdi::ScreenToClient,
        System::{
            Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, STGMEDIUM, TYMED_HGLOBAL},
            DataExchange::RegisterClipboardFormatW,
            Memory::{GlobalLock, GlobalSize, GlobalUnlock},
            Ole::{
                IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop,
                CF_HDROP, CF_TEXT, CF_UNICODETEXT, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
            },
            SystemServices::MODIFIERKEYS_FLAGS,
        },
        UI::{
            Shell::{DragQueryFileW, HDROP},
            WindowsAndMessaging::EnumChildWindows,
        },
    },
};

thread_local! {
    // COM drop targets belong to the window's STA thread, not Tauri's shared state.
    static TARGETS: RefCell<Vec<(HWND, IDropTarget)>> = const { RefCell::new(Vec::new()) };
}

struct Medium(STGMEDIUM);
impl Drop for Medium {
    fn drop(&mut self) {
        unsafe { ReleaseStgMedium(&mut self.0) };
    }
}

fn medium(data: &IDataObject, format: u16) -> Option<Medium> {
    let format = FORMATETC {
        cfFormat: format,
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
        ..Default::default()
    };
    let result = Medium(unsafe { data.GetData(&format) }.ok()?);
    (result.0.tymed == TYMED_HGLOBAL.0 as u32).then_some(result)
}

fn text(data: &IDataObject, format: u16, wide: bool) -> Option<String> {
    let storage = medium(data, format)?;
    let handle = unsafe { storage.0.u.hGlobal };
    let size = unsafe { GlobalSize(handle) };
    // Bound untrusted cross-process data before making a slice or decoding it.
    if size == 0 || size > 32768 || (wide && size % 2 != 0) {
        return None;
    }
    let pointer = unsafe { GlobalLock(handle) };
    if pointer.is_null() {
        return None;
    }
    let result = unsafe {
        if wide {
            let units = std::slice::from_raw_parts(pointer.cast::<u16>(), size / 2);
            units
                .iter()
                .position(|&unit| unit == 0)
                .and_then(|end| String::from_utf16(&units[..end]).ok())
        } else {
            let bytes = std::slice::from_raw_parts(pointer.cast::<u8>(), size);
            bytes
                .iter()
                .position(|&byte| byte == 0)
                .and_then(|end| String::from_utf8(bytes[..end].to_vec()).ok())
        }
    };
    let _ = unsafe { GlobalUnlock(handle) };
    result
}

fn is_card(value: &str) -> bool {
    const PREFIX: &str = "authlib-injector:yggdrasil-server:";
    value.lines().any(|line| {
        line.trim()
            .get(..PREFIX.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(PREFIX))
    })
}

#[derive(Clone)]
enum Payload {
    Files(Vec<PathBuf>),
    Card(String),
}

fn read_payload(data: Option<&IDataObject>) -> Option<Payload> {
    let data = data?;
    // File drags always keep the existing importer, even if they also offer text.
    if let Some(storage) = medium(data, CF_HDROP.0) {
        let handle = HDROP(unsafe { storage.0.u.hGlobal }.0);
        let count = unsafe { DragQueryFileW(handle, u32::MAX, None) };
        if count == 0 || count > 4096 {
            return None;
        }
        let mut paths = Vec::new();
        for index in 0..count {
            let length = unsafe { DragQueryFileW(handle, index, None) } as usize;
            if length == 0 || length > 32768 {
                return None;
            }
            let mut buffer = vec![0; length + 1];
            let written = unsafe { DragQueryFileW(handle, index, Some(&mut buffer)) } as usize;
            paths.push(OsString::from_wide(&buffer[..written]).into());
        }
        return Some(Payload::Files(paths));
    }
    let url_format = unsafe { RegisterClipboardFormatW(w!("UniformResourceLocatorW")) } as u16;
    for (format, wide) in [
        (CF_UNICODETEXT.0, true),
        (url_format, true),
        (CF_TEXT.0, false),
    ] {
        if let Some(value) = text(data, format, wide).filter(|value| is_card(value)) {
            return Some(Payload::Card(value));
        }
    }
    None
}

#[implement(IDropTarget)]
struct DropTarget {
    window: tauri::WebviewWindow,
    root: HWND,
    payload: RefCell<Option<Payload>>,
}

impl DropTarget {
    fn emit(&self, phase: &str, payload: &Payload, point: Option<&POINTL>) {
        let (event, data) = match payload {
            Payload::Card(text) => (
                "yggdrasil-card-drop".to_string(),
                serde_json::json!({ "phase": phase, "text": if phase == "drop" { text.as_str() } else { "" } }),
            ),
            Payload::Files(paths) => {
                let point = point.map(|point| {
                    let mut position = POINT {
                        x: point.x,
                        y: point.y,
                    };
                    let _ = unsafe { ScreenToClient(self.root, &mut position) };
                    serde_json::json!({ "x": position.x, "y": position.y })
                });
                (
                    format!("tauri://drag-{phase}"),
                    serde_json::json!({ "paths": paths, "position": point }),
                )
            }
        };
        if let Err(error) = self.window.emit_to(
            EventTarget::Webview {
                label: self.window.label().into(),
            },
            &event,
            data,
        ) {
            eprintln!("Cannot deliver window drag event: {error}");
        }
    }
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for DropTarget_Impl {
    fn DragEnter(
        &self,
        data: Ref<'_, IDataObject>,
        _: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let payload = read_payload(data.as_ref());
        let accepted = payload.is_some()
            && !effect.is_null()
            && unsafe { (*effect & DROPEFFECT_COPY) != DROPEFFECT_NONE };
        if !effect.is_null() {
            unsafe {
                *effect = if accepted {
                    DROPEFFECT_COPY
                } else {
                    DROPEFFECT_NONE
                };
            }
        }
        if accepted {
            if let Some(payload) = &payload {
                self.emit("enter", payload, Some(point));
            }
            *self.payload.borrow_mut() = payload;
        } else {
            *self.payload.borrow_mut() = None;
        }
        Ok(())
    }

    fn DragOver(
        &self,
        _: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let payload = self.payload.borrow();
        if let Some(payload @ Payload::Files(_)) = payload.as_ref() {
            self.emit("over", payload, Some(point));
        }
        if !effect.is_null() {
            unsafe {
                *effect = if payload.is_some() {
                    DROPEFFECT_COPY
                } else {
                    DROPEFFECT_NONE
                };
            }
        }
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        if let Some(payload) = self.payload.take() {
            self.emit("leave", &payload, None);
        }
        Ok(())
    }

    fn Drop(
        &self,
        data: Ref<'_, IDataObject>,
        _: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let previous = self.payload.take();
        let payload = previous.as_ref().and_then(|_| read_payload(data.as_ref()));
        if !effect.is_null() {
            unsafe {
                *effect = if payload.is_some() {
                    DROPEFFECT_COPY
                } else {
                    DROPEFFECT_NONE
                };
            }
        }
        if let Some(payload) = payload {
            self.emit("drop", &payload, Some(point));
        } else if let Some(previous) = previous {
            self.emit("leave", &previous, None);
        }
        Ok(())
    }
}

pub fn install(window: &tauri::WebviewWindow) -> anyhow::Result<()> {
    let root = HWND(window.hwnd()?.0);
    let mut handles = vec![root];
    unsafe extern "system" fn collect(hwnd: HWND, parameter: LPARAM) -> BOOL {
        unsafe { &mut *(parameter.0 as *mut Vec<HWND>) }.push(hwnd);
        true.into()
    }
    let _ = unsafe {
        EnumChildWindows(
            Some(root),
            Some(collect),
            LPARAM(&mut handles as *mut _ as isize),
        )
    };
    for hwnd in handles {
        let target: IDropTarget = DropTarget {
            window: window.clone(),
            root,
            payload: RefCell::new(None),
        }
        .into();
        if unsafe { RevokeDragDrop(hwnd) } == Err(DRAGDROP_E_INVALIDHWND.into()) {
            continue;
        }
        if let Err(error) = unsafe { RegisterDragDrop(hwnd, &target) } {
            uninstall();
            return Err(error.into());
        }
        TARGETS.with(|targets| targets.borrow_mut().push((hwnd, target)));
    }
    anyhow::ensure!(
        TARGETS.with(|targets| !targets.borrow().is_empty()),
        "无法启用窗口拖放"
    );
    Ok(())
}

pub fn uninstall() {
    TARGETS.with(|targets| {
        for (hwnd, _) in targets.borrow_mut().drain(..) {
            let _ = unsafe { RevokeDragDrop(hwnd) };
        }
    });
}

#[cfg(test)]
mod tests;
