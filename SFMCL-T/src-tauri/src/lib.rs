mod commands;
mod curseforge_download;
#[cfg(windows)]
mod drag_drop;
mod launch_window;
mod local_data;
mod window_frame;
mod window_motion;
mod window_session;
#[cfg(windows)]
mod window_shadow;
use std::sync::Arc;
use tauri::Manager;

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum StartupPhase {
    Loading,
    Error,
    Ready,
    Reveal,
    Shown,
}

#[tauri::command]
async fn startup_window(window: tauri::WebviewWindow, phase: StartupPhase) -> Result<(), String> {
    if window.label() != "main" {
        return Err("此窗口不能操作启动器".into());
    }
    let update = || -> tauri::Result<()> {
        match phase {
            StartupPhase::Loading => {
                window_motion::reset_for_startup(&window);
                window_frame::set_visible(&window, false)?;
                window.set_resizable(false)?;
                window.set_min_size(None::<tauri::LogicalSize<f64>>)?;
                // Keep the real viewport while the invisible React tree lays out.
                if !window_session::restoring(window.app_handle()) {
                    window.set_size(tauri::LogicalSize::new(864.0, 591.0))?;
                    window.center()?;
                }
                // The small startup document is ready, including on tray restore.
                // Show its animation before React, IPC and first-screen assets load.
                window.show()?;
                window.unminimize()?;
            }
            StartupPhase::Error => {
                window_frame::set_visible(&window, false)?;
                window.set_resizable(false)?;
                window.set_min_size(None::<tauri::LogicalSize<f64>>)?;
                window.set_size(tauri::LogicalSize::new(400.0, 332.0))?;
                window.center()?;
                if window_session::restoring(window.app_handle()) {
                    window.show()?;
                }
            }
            StartupPhase::Ready => {
                window_frame::set_visible(&window, false)?;
                window.set_resizable(true)?;
                // Enabling resize changes the Win32 client inset. Restore the
                // intended viewport before the frontend's final layout check.
                window.set_min_size(Some(tauri::LogicalSize::new(850.0, 591.0)))?;
                if window_session::restoring(window.app_handle()) {
                    window_session::restore_geometry(&window)?;
                } else {
                    window.set_size(tauri::LogicalSize::new(864.0, 591.0))?;
                }
            }
            StartupPhase::Reveal => {
                if window_session::restoring(window.app_handle()) {
                    window.show()?;
                    window.unminimize()?;
                }
            }
            StartupPhase::Shown => {
                window_motion::finish(&window, None)?;
                if window_session::restoring(window.app_handle()) {
                    window_session::restored(&window)?;
                }
            }
        }
        Ok(())
    };
    update().map_err(|error| error.to_string())
}

pub(crate) fn create_main_window(
    app: &tauri::AppHandle,
    saved: Option<&window_session::SavedWindow>,
) -> tauri::Result<()> {
    let runtime = app.state::<Arc<commands::Runtime>>();
    let settings = runtime.settings.get();
    let hardware = settings.hardware_acceleration;
    let appearance = serde_json::json!({ "theme": settings.theme, "accent": settings.accent });
    let session = saved
        .map(|saved| saved.ui.clone())
        .unwrap_or(serde_json::Value::Null);
    let webview_directory = runtime.directory.join("webview");
    window_frame::reset(app);
    let mut window =
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title(format!(
                "{} · {}",
                sfmcl_t_core::brand::PRODUCT_NAME,
                sfmcl_t_core::brand::PRODUCT_FULL_NAME
            ))
            .decorations(false)
            .transparent(true)
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .shadow(false)
            .resizable(false)
            // Show the webview only after its small startup document is ready.
            // The React application loads behind that screen and reveals itself later.
            .visible(false)
            .initialization_script(format!(
        "window.__SFMCL_T_APPEARANCE__ = {appearance}; window.__SFMCL_T_SESSION__ = {session};"
    ))
            .data_directory(webview_directory)
            .inner_size(864.0, 591.0)
            .center();
    if !hardware {
        window = window.additional_browser_args("--disable-gpu");
    }
    // Wry's Windows file drop target swallows browser text/card drags.
    // Our OLE target supports both and retains Tauri's file event format.
    #[cfg(windows)]
    {
        window = window.disable_drag_drop_handler();
    }
    let main_window = window.build()?;
    if saved.is_some() {
        window_session::restore_geometry(&main_window)?;
    }
    #[cfg(windows)]
    drag_drop::install(&main_window)?;
    window_frame::set_visible(&main_window, false)?;
    Ok(())
}

#[cfg(windows)]
fn with_bundled_webview2(mut context: tauri::Context<tauri::Wry>) -> tauri::Context<tauri::Wry> {
    use std::os::windows::process::CommandExt;

    if let Some(runtime) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("WebView2")))
        .filter(|dir| dir.join("msedgewebview2.exe").is_file())
    {
        // Fixed Version 120+ requires these AppContainer permissions on Windows 10.
        // ZIP files do not preserve ACLs, so apply them on the destination machine.
        let icacls = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| "C:\\Windows".into())
            .join("System32/icacls.exe");
        match std::process::Command::new(icacls)
            .arg(&runtime)
            .args([
                "/grant",
                "*S-1-15-2-2:(OI)(CI)(RX)",
                "*S-1-15-2-1:(OI)(CI)(RX)",
            ])
            .creation_flags(0x08000000)
            .output()
        {
            Ok(output) if output.status.success() => {}
            result => eprintln!("Cannot set bundled WebView2 permissions: {result:?}"),
        }
        // Tauri resolves this against the executable directory before creating Wry.
        context.config_mut().bundle.windows.webview_install_mode =
            tauri::utils::config::WebviewInstallMode::FixedRuntime {
                path: "WebView2".into(),
            };
    }
    context
}

pub fn run() {
    #[cfg(windows)]
    if sfmcl_t_core::minecraft::detached::run_helper() {
        return;
    }
    if local_data::run_helper() {
        return;
    }
    let context = tauri::generate_context!();
    #[cfg(windows)]
    let context = with_bundled_webview2(context);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let default_directory = app.path().app_data_dir()?;
            let directory = sfmcl_t_core::local_data::resolve_directory(
                &default_directory,
                sfmcl_t_core::brand::environment("DATA_DIR"),
            )?;
            app.manage(local_data::DataManager::new(
                &default_directory,
                &directory,
            )?);
            let runtime = commands::Runtime::new(directory)?;
            app.manage(Arc::new(runtime));
            app.manage(window_motion::WindowMotion::default());
            app.manage(window_frame::WindowFrame::default());
            app.manage(window_session::WindowSession::default());
            create_main_window(app.handle(), None)?;
            launch_window::setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::request,
            startup_window,
            window_session::suspend_launcher_window,
            launch_window::resolve_launcher_quit,
            window_motion::minimize_window,
            window_motion::complete_window_transition,
            window_motion::finish_window_transition
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                #[cfg(windows)]
                {
                    drag_drop::uninstall();
                    window_shadow::reset();
                }
                window_session::destroyed(window.app_handle());
            }
            if matches!(
                event,
                tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::Focused(_)
            ) {
                if let Some(webview) = window.app_handle().get_webview_window("main") {
                    if let Err(error) = window_frame::observe(&webview) {
                        eprintln!("Cannot synchronize native window frame: {error}");
                    }
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                launch_window::quit(app);
            }
        })
        .build(context)
        .expect("无法启动 SFMCL-T")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested {
                api, code: None, ..
            } = event
            {
                if window_session::keep_alive(app) {
                    api.prevent_exit();
                }
            }
        });
}
