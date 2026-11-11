//! A click-through owned window draws the shadow beyond the transparent client.
//! The cached bitmap needs no additional WebView or rendering process.
use std::{cell::RefCell, ptr};
use windows_sys::Win32::{
    Foundation::{HWND, POINT, SIZE},
    Graphics::Gdi::{
        ClientToScreen, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject,
        AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION,
        DIB_RGB_COLORS, HBITMAP, HDC,
    },
    UI::{
        HiDpi::GetDpiForWindow,
        WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GetClientRect, IsIconic, IsWindow, IsWindowVisible,
            IsZoomed, SetWindowPos, ShowWindow, UpdateLayeredWindow, SWP_NOACTIVATE, SWP_NOSIZE,
            SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, ULW_ALPHA, WS_EX_LAYERED, WS_EX_NOACTIVATE,
            WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
        },
    },
};

thread_local! {
    static SHADOW: RefCell<Option<Shadow>> = const { RefCell::new(None) };
}

struct Surface {
    dc: HDC,
    bitmap: HBITMAP,
    previous: windows_sys::Win32::Graphics::Gdi::HGDIOBJ,
    width: i32,
    height: i32,
    dpi: u32,
}

impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.previous);
            DeleteObject(self.bitmap);
            DeleteDC(self.dc);
        }
    }
}

fn distance(x: f64, y: f64, width: f64, height: f64, step: f64) -> f64 {
    // The union of three inset rectangles matches window-corners.css exactly.
    // Use its outside distance so the shadow follows the two 3px corner steps.
    let rectangle = |inset_x: f64, inset_y: f64| {
        let dx = (x - width / 2.0).abs() - (width / 2.0 - inset_x);
        let dy = (y - height / 2.0).abs() - (height / 2.0 - inset_y);
        dx.max(0.0).hypot(dy.max(0.0)) + dx.max(dy).min(0.0)
    };
    rectangle(2.0 * step, 0.0)
        .min(rectangle(step, step))
        .min(rectangle(0.0, 2.0 * step))
}

impl Surface {
    fn new(width: i32, height: i32, padding: i32, dpi: u32) -> tauri::Result<Self> {
        let dc = unsafe { CreateCompatibleDC(ptr::null_mut()) };
        if dc.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = ptr::null_mut();
        let bitmap =
            unsafe { CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut pixels, ptr::null_mut(), 0) };
        if bitmap.is_null() {
            unsafe { DeleteDC(dc) };
            return Err(std::io::Error::last_os_error().into());
        }
        let previous = unsafe { SelectObject(dc, bitmap) };
        let surface = Self {
            dc,
            bitmap,
            previous,
            width,
            height,
            dpi,
        };
        let pixels = unsafe {
            std::slice::from_raw_parts_mut(
                pixels.cast::<u8>(),
                width as usize * height as usize * 4,
            )
        };
        pixels.fill(0);
        let scale = dpi as f64 / 96.0;
        let content_width = (width - padding * 2) as f64;
        let content_height = (height - padding * 2) as f64;
        let step = 3.0 * scale;
        for y in 0..height {
            for x in 0..width {
                let px = (x - padding) as f64 + 0.5;
                let py = (y - padding) as f64 + 0.5;
                if px >= 2.0 * step
                    && px <= content_width - 2.0 * step
                    && py >= 2.0 * step
                    && py <= content_height - 2.0 * step
                {
                    continue;
                }
                let edge = distance(px, py, content_width, content_height, step);
                // Every painted UI pixel stays clear. Only the outside of the
                // stepped silhouette receives the ambient and contact shadows.
                let coverage = (edge + 0.5).clamp(0.0, 1.0);
                if coverage == 0.0 {
                    continue;
                }
                let offset =
                    distance(px, py - 5.0 * scale, content_width, content_height, step).max(0.0);
                let ambient = 0.20 * (-offset.powi(2) / (2.0 * (10.0 * scale).powi(2))).exp();
                let contact = 0.08 * (-edge.max(0.0).powi(2) / (2.0 * (2.5 * scale).powi(2))).exp();
                pixels[((y * width + x) as usize) * 4 + 3] =
                    ((ambient + contact) * coverage * 255.0).round() as u8;
            }
        }
        Ok(surface)
    }
}

struct Shadow {
    window: HWND,
    surface: Option<Surface>,
}

impl Drop for Shadow {
    fn drop(&mut self) {
        unsafe {
            if IsWindow(self.window) != 0 {
                DestroyWindow(self.window);
            }
        }
    }
}

impl Shadow {
    fn new(owner: HWND) -> tauri::Result<Self> {
        // STATIC provides a native window procedure; the layered bitmap owns
        // all painting. An owned tool window shares the main window's stacking
        // and lifetime without gaining focus, a taskbar item, or mouse input.
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let window = unsafe {
            CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                class.as_ptr(),
                ptr::null(),
                WS_POPUP,
                0,
                0,
                0,
                0,
                owner,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
            )
        };
        if window.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Self {
            window,
            surface: None,
        })
    }

    fn show(&mut self, owner: HWND) -> tauri::Result<()> {
        let mut client = Default::default();
        let mut origin = POINT { x: 0, y: 0 };
        if unsafe { GetClientRect(owner, &mut client) } == 0
            || unsafe { ClientToScreen(owner, &mut origin) } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let dpi = unsafe { GetDpiForWindow(owner) }.max(96);
        let padding = (32.0 * dpi as f64 / 96.0).ceil() as i32;
        let width = client.right - client.left + padding * 2;
        let height = client.bottom - client.top + padding * 2;
        if width <= padding * 2 || height <= padding * 2 {
            return Ok(());
        }
        let repaint = self
            .surface
            .as_ref()
            .is_none_or(|s| s.width != width || s.height != height || s.dpi != dpi);
        if repaint {
            self.surface = Some(Surface::new(width, height, padding, dpi)?);
        }
        let destination = POINT {
            x: origin.x - padding,
            y: origin.y - padding,
        };
        if !repaint {
            // Moving or restoring reuses the bitmap instead of copying its
            // entire pixel buffer for each mouse-drag frame.
            if unsafe {
                SetWindowPos(
                    self.window,
                    ptr::null_mut(),
                    destination.x,
                    destination.y,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            unsafe { ShowWindow(self.window, SW_SHOWNOACTIVATE) };
            return Ok(());
        }
        let surface = self.surface.as_ref().unwrap();
        let size = SIZE {
            cx: width,
            cy: height,
        };
        let source = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        if unsafe {
            UpdateLayeredWindow(
                self.window,
                ptr::null_mut(),
                &destination,
                &size,
                surface.dc,
                &source,
                0,
                &blend,
                ULW_ALPHA,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        unsafe { ShowWindow(self.window, SW_SHOWNOACTIVATE) };
        Ok(())
    }
}

/// Must run on the owner window's UI thread.
pub fn update(window: &tauri::WebviewWindow, enabled: bool) -> tauri::Result<()> {
    let owner = window.hwnd()?.0 as HWND;
    let show = enabled
        && unsafe { IsWindowVisible(owner) != 0 && IsIconic(owner) == 0 && IsZoomed(owner) == 0 };
    SHADOW.with(|state| {
        let mut state = state.borrow_mut();
        if !show {
            if let Some(shadow) = state.as_ref() {
                unsafe { ShowWindow(shadow.window, SW_HIDE) };
            }
            return Ok(());
        }
        if state.is_none() {
            *state = Some(Shadow::new(owner)?);
        }
        state.as_mut().unwrap().show(owner)
    })
}

pub fn schedule(window: &tauri::WebviewWindow, enabled: bool) -> tauri::Result<()> {
    let owner = window.clone();
    window.run_on_main_thread(move || {
        if let Err(error) = update(&owner, enabled) {
            eprintln!("Cannot update window shadow: {error}");
        }
    })
}
