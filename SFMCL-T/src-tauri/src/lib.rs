mod commands;
mod curseforge_download;
use std::sync::Arc;
use tauri::Manager;

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum StartupPhase {
    Loading,
    Error,
    Ready,
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
                window.set_shadow(false)?;
                window.set_resizable(false)?;
                window.set_min_size(None::<tauri::LogicalSize<f64>>)?;
                // Keep the real viewport while the invisible React tree lays out.
                window.set_size(tauri::LogicalSize::new(864.0, 591.0))?;
                window.center()?;
            }
            StartupPhase::Error => {
                window.set_shadow(false)?;
                window.set_resizable(false)?;
                window.set_min_size(None::<tauri::LogicalSize<f64>>)?;
                window.set_size(tauri::LogicalSize::new(400.0, 332.0))?;
                window.center()?;
            }
            StartupPhase::Ready => {
                window.set_resizable(true)?;
                // Enabling resize changes the Win32 client inset. Restore the
                // intended viewport before the frontend's final layout check.
                window.set_size(tauri::LogicalSize::new(864.0, 591.0))?;
                window.set_min_size(Some(tauri::LogicalSize::new(850.0, 591.0)))?;
            }
            StartupPhase::Shown => {
                // On Windows 11 the native shadow also enables rounded corners.
                // Restore it only after the frontend has finished fading in.
                let size = window.inner_size()?;
                let position = window.inner_position()?;
                window.set_shadow(true)?;
                // The native frame changes the client inset. Keep the rendered
                // content at the same size and screen position across the change.
                window.set_size(size)?;
                let inner = window.inner_position()?;
                let outer = window.outer_position()?;
                window.set_position(tauri::PhysicalPosition::new(
                    position.x - (inner.x - outer.x),
                    position.y - (inner.y - outer.y),
                ))?;
            }
        }
        Ok(())
    };
    update().map_err(|error| error.to_string())
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
    let context = tauri::generate_context!();
    #[cfg(windows)]
    let context = with_bundled_webview2(context);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let directory = sfmcl_t_core::brand::data_directory(
                &app.path().app_data_dir()?,
                sfmcl_t_core::brand::environment("DATA_DIR"),
            );
            let webview_directory = directory.join("webview");
            let runtime = commands::Runtime::new(directory)?;
            let settings = runtime.settings.get();
            let hardware = settings.hardware_acceleration;
            let appearance =
                serde_json::json!({ "theme": settings.theme, "accent": settings.accent });
            app.manage(Arc::new(runtime));
            let mut window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
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
            .initialization_script(format!("window.__SFMCL_T_APPEARANCE__ = {appearance};"))
            .on_page_load(|window, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    if let Err(error) = window.show() {
                        eprintln!("Cannot show startup window: {error}");
                    }
                }
            })
            .data_directory(webview_directory)
            .inner_size(864.0, 591.0)
            .center();
            if !hardware {
                window = window.additional_browser_args("--disable-gpu");
            }
            window.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::request, startup_window])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                let runtime = app.state::<Arc<commands::Runtime>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = runtime.downloads.pause_all().await {
                        eprintln!("Cannot pause downloads: {error}");
                    }
                    app.exit(0);
                });
            }
        })
        .run(context)
        .expect("无法启动 SFMCL-T");
}
