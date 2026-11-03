use crate::{config::Settings, jobs::Job};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    pub id: String,
    pub primary: bool,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub work_width: i32,
    pub work_height: i32,
    pub screen_x: i32,
    pub screen_y: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Position {
    monitor: String,
    x: i32,
    y: i32,
}

pub struct Controller {
    settings: Settings,
    path: PathBuf,
    remembered: Option<Position>,
    last: Option<Position>,
    window: usize,
    job: Arc<Job>,
}

impl Controller {
    pub fn new(settings: &Settings, directory: &Path, job: Arc<Job>) -> Self {
        let path = crate::paths::safe_join(directory, ".tmcl/window-position.json").ok();
        let remembered = path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        Self {
            settings: settings.clone(),
            path: path.unwrap_or_default(),
            remembered,
            last: None,
            window: 0,
            job,
        }
    }
    pub fn tick(&mut self, pid: u32) {
        #[cfg(windows)]
        native::tick(self, pid);
        #[cfg(not(windows))]
        let _ = pid;
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        if self.settings.window_mode == "remember" && !self.path.as_os_str().is_empty() {
            if let Some(position) = &self.last {
                let result = serde_json::to_vec(position)
                    .map_err(anyhow::Error::from)
                    .and_then(|bytes| crate::paths::atomic_write(&self.path, &bytes));
                if let Err(e) = result {
                    self.job.log(format!("保存游戏窗口位置失败：{e}"));
                }
            }
        }
    }
}

fn clamp_position(x: i32, y: i32, width: i32, height: i32, monitor: &Monitor) -> (i32, i32) {
    (
        x.clamp(
            monitor.x,
            monitor
                .x
                .saturating_add((monitor.work_width - width).max(0)),
        ),
        y.clamp(
            monitor.y,
            monitor
                .y
                .saturating_add((monitor.work_height - height).max(0)),
        ),
    )
}

#[cfg(windows)]
pub fn monitors() -> Vec<Monitor> {
    native::monitors()
}
#[cfg(not(windows))]
pub fn monitors() -> Vec<Monitor> {
    Vec::new()
}

#[cfg(windows)]
pub fn set_priority(pid: u32, priority: &str) -> Result<()> {
    native::set_priority(pid, priority)
}
#[cfg(not(windows))]
pub fn set_priority(_: u32, priority: &str) -> Result<()> {
    if priority != "normal" {
        anyhow::bail!("当前平台不支持游戏进程优先级设置");
    }
    Ok(())
}

#[cfg(windows)]
mod native {
    use super::*;
    use windows_sys::Win32::{
        Foundation::*, Graphics::Gdi::*, System::Threading::*, UI::WindowsAndMessaging::*,
    };

    unsafe fn monitor_info(handle: HMONITOR) -> Option<Monitor> {
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(handle, &mut info.monitorInfo) == 0 {
            return None;
        }
        let len = info
            .szDevice
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(info.szDevice.len());
        let rect = info.monitorInfo.rcWork;
        Some(Monitor {
            id: String::from_utf16_lossy(&info.szDevice[..len]),
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            x: rect.left,
            y: rect.top,
            width: info.monitorInfo.rcMonitor.right - info.monitorInfo.rcMonitor.left,
            height: info.monitorInfo.rcMonitor.bottom - info.monitorInfo.rcMonitor.top,
            work_width: rect.right - rect.left,
            work_height: rect.bottom - rect.top,
            screen_x: info.monitorInfo.rcMonitor.left,
            screen_y: info.monitorInfo.rcMonitor.top,
        })
    }
    pub fn monitors() -> Vec<Monitor> {
        unsafe extern "system" fn visit(
            handle: HMONITOR,
            _: HDC,
            _: *mut RECT,
            data: LPARAM,
        ) -> i32 {
            if let Some(info) = monitor_info(handle) {
                (&mut *(data as *mut Vec<Monitor>)).push(info);
            }
            1
        }
        let mut result: Vec<Monitor> = Vec::new();
        unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(visit),
                &mut result as *mut _ as LPARAM,
            );
        }
        result.sort_by(|a, b| b.primary.cmp(&a.primary).then(a.id.cmp(&b.id)));
        result
    }

    pub fn set_priority(pid: u32, priority: &str) -> Result<()> {
        let class = match priority {
            "idle" => IDLE_PRIORITY_CLASS,
            "belowNormal" => BELOW_NORMAL_PRIORITY_CLASS,
            "normal" => NORMAL_PRIORITY_CLASS,
            "aboveNormal" => ABOVE_NORMAL_PRIORITY_CLASS,
            "high" => HIGH_PRIORITY_CLASS,
            _ => anyhow::bail!("未知进程优先级"),
        };
        unsafe {
            let process = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
            if process.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let result = SetPriorityClass(process, class);
            let error = std::io::Error::last_os_error();
            CloseHandle(process);
            if result == 0 {
                return Err(error.into());
            }
        }
        Ok(())
    }

    fn find_window(pid: u32) -> HWND {
        struct Search {
            pid: u32,
            window: HWND,
        }
        unsafe extern "system" fn visit(window: HWND, data: LPARAM) -> i32 {
            let search = &mut *(data as *mut Search);
            let mut pid = 0;
            GetWindowThreadProcessId(window, &mut pid);
            if pid != search.pid || IsWindowVisible(window) == 0 {
                return 1;
            }
            let mut class = [0u16; 128];
            let len = GetClassNameW(window, class.as_mut_ptr(), class.len() as i32);
            let class = String::from_utf16_lossy(&class[..len.max(0) as usize]);
            if ["GLFW30", "LWJGL", "SunAwtFrame"]
                .iter()
                .any(|name| class.starts_with(name))
            {
                search.window = window;
                return 0;
            }
            1
        }
        let mut search = Search {
            pid,
            window: std::ptr::null_mut(),
        };
        unsafe {
            EnumWindows(Some(visit), &mut search as *mut _ as LPARAM);
        }
        search.window
    }

    pub fn tick(controller: &mut Controller, pid: u32) {
        let window = find_window(pid);
        if window.is_null() {
            return;
        }
        let settings = &controller.settings;
        unsafe {
            if !settings.window_title.is_empty() {
                let title: Vec<u16> = settings
                    .window_title
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                SetWindowTextW(window, title.as_ptr());
            }
            if controller.window != window as usize {
                let monitors = monitors();
                let remembered = controller
                    .remembered
                    .as_ref()
                    .filter(|_| settings.window_mode == "remember");
                let id = if !settings.window_monitor.is_empty() {
                    settings.window_monitor.as_str()
                } else {
                    remembered.map(|p| p.monitor.as_str()).unwrap_or("")
                };
                let monitor = monitors
                    .iter()
                    .find(|m| m.id == id)
                    .or_else(|| monitors.iter().find(|m| m.primary));
                if let Some(monitor) = monitor {
                    if settings.window_mode != "default" || !settings.window_monitor.is_empty() {
                        let mut rect: RECT = std::mem::zeroed();
                        if GetWindowRect(window, &mut rect) != 0 {
                            let width = rect.right - rect.left;
                            let height = rect.bottom - rect.top;
                            let (x, y) = if settings.fullscreen {
                                (monitor.screen_x, monitor.screen_y)
                            } else if settings.window_mode == "custom" {
                                clamp_position(
                                    monitor.x.saturating_add(settings.window_x),
                                    monitor.y.saturating_add(settings.window_y),
                                    width,
                                    height,
                                    monitor,
                                )
                            } else if let Some(saved) = remembered {
                                clamp_position(saved.x, saved.y, width, height, monitor)
                            } else {
                                (
                                    monitor.x + (monitor.work_width - width).max(0) / 2,
                                    monitor.y + (monitor.work_height - height).max(0) / 2,
                                )
                            };
                            if SetWindowPos(
                                window,
                                std::ptr::null_mut(),
                                x,
                                y,
                                0,
                                0,
                                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                            ) == 0
                            {
                                controller.job.log(format!(
                                    "设置游戏窗口位置失败：{}",
                                    std::io::Error::last_os_error()
                                ));
                            }
                            if settings.window_mode == "maximized" && !settings.fullscreen {
                                ShowWindow(window, SW_MAXIMIZE);
                            }
                        }
                    }
                }
                controller.window = window as usize;
            }
            if settings.window_mode == "remember"
                && !settings.fullscreen
                && IsIconic(window) == 0
                && IsZoomed(window) == 0
            {
                let mut rect: RECT = std::mem::zeroed();
                if GetWindowRect(window, &mut rect) != 0 {
                    if let Some(monitor) =
                        monitor_info(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST))
                    {
                        controller.last = Some(Position {
                            monitor: monitor.id,
                            x: rect.left,
                            y: rect.top,
                        });
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn priority_is_applied_to_the_requested_process() {
        use std::{
            os::windows::process::CommandExt,
            process::{Command, Stdio},
        };
        use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let child = Child(
            Command::new("cmd.exe")
                .args(["/D", "/Q"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x08000000)
                .spawn()
                .unwrap(),
        );
        let pid = child.0.id();
        for (name, expected) in [
            ("belowNormal", BELOW_NORMAL_PRIORITY_CLASS),
            ("normal", NORMAL_PRIORITY_CLASS),
            ("aboveNormal", ABOVE_NORMAL_PRIORITY_CLASS),
        ] {
            set_priority(pid, name).unwrap();
            unsafe {
                let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                assert!(!process.is_null());
                let actual = GetPriorityClass(process);
                CloseHandle(process);
                assert_eq!(actual, expected);
            }
        }
    }
    #[test]
    fn disconnected_or_offscreen_positions_are_clamped_to_the_selected_work_area() {
        let monitor = Monitor {
            id: "left".into(),
            primary: false,
            x: -1920,
            y: 0,
            width: 1920,
            height: 1040,
            work_width: 1920,
            work_height: 1040,
            screen_x: -1920,
            screen_y: 0,
        };
        assert_eq!(clamp_position(9000, -500, 1280, 720, &monitor), (-1280, 0));
        assert_eq!(
            clamp_position(-9000, 5000, 2560, 1440, &monitor),
            (-1920, 0)
        );
    }
}
