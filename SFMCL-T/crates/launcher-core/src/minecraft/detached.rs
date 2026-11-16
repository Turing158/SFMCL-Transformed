//! A short-lived bootstrap starts a separate game host, then exits before the
//! launcher reports success. The host owns Java, its pipes and the version lock;
//! no game handle or output pipe depends on the lifetime of the launcher UI.
use super::process::{ExitEvent, LaunchEvent, LaunchEvents};
use crate::{
    config::Settings,
    downloads::Status,
    jobs::{Job, JobSnapshot, Jobs},
    paths::{atomic_write, minecraft_root, safe_join},
};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const BOOTSTRAP: &str = "--sfmcl-game-bootstrap";
const HOST: &str = "--sfmcl-game-host";
const READY: &str = "SFMCL_GAME_READY ";
const POLL: Duration = Duration::from_millis(200);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Identity {
    pid: u32,
    created: u64,
    executable: PathBuf,
}

#[derive(Serialize, Deserialize)]
struct Request {
    session: PathBuf,
    java: String,
    args: Vec<String>,
    directory: PathBuf,
    settings: Settings,
    snapshot: JobSnapshot,
    redactions: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct State {
    host: Identity,
    game: Option<Identity>,
    snapshot: JobSnapshot,
    code: Option<i32>,
}

#[derive(Serialize, Deserialize)]
struct Hello {
    host: Option<Identity>,
    error: Option<String>,
}

fn read_state(session: &Path) -> Result<State> {
    Ok(serde_json::from_slice(&fs::read(
        session.join("state.json"),
    )?)?)
}

fn publish(session: &Path, state: &State, previous: &mut Vec<u8>) -> Result<()> {
    let bytes = serde_json::to_vec(state)?;
    if *previous != bytes {
        atomic_write(&session.join("state.json"), &bytes)?;
        *previous = bytes;
    }
    Ok(())
}

fn hello(value: Hello) -> Result<()> {
    let mut output = std::io::stdout().lock();
    writeln!(output, "{READY}{}", serde_json::to_string(&value)?)?;
    output.flush()?;
    Ok(())
}

fn command(mode: &str, executable: &Path) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new(executable);
    #[cfg(not(test))]
    command.arg(mode);
    #[cfg(test)]
    command
        .args([
            "--exact",
            "minecraft::detached::tests::helper_entry",
            "--nocapture",
        ])
        .env("SFMCL_T_TEST_GAME_HELPER", mode);
    command
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

// Give the background process a distinct executable name in Task Manager.
// Hard links avoid duplicating the launcher; a copy supports game data on a
// different volume. Versioned names let an existing game outlive an app update.
fn host_executable(data: &Path) -> Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let metadata = fs::metadata(&executable)?;
    let modified = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let directory = data.join("game-hosts");
    fs::create_dir_all(&directory)?;
    let target = directory.join(format!("MinecraftHost-{}-{modified}.exe", metadata.len()));
    if !target.exists() {
        if let Err(link_error) = fs::hard_link(&executable, &target) {
            // Another concurrent launch may have installed the same host.
            if !target.exists() {
                let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
                let mut result =
                    fs::copy(&executable, &temporary).and_then(|_| fs::rename(&temporary, &target));
                if result.is_err()
                    && fs::metadata(&target).is_ok_and(|file| file.len() == metadata.len())
                {
                    // A concurrent cross-volume launch installed this version
                    // while we copied it; use its complete executable.
                    result = Ok(());
                }
                let _ = fs::remove_file(&temporary);
                result.with_context(|| format!("无法准备游戏后台程序（硬链接：{link_error}）"))?;
            }
        }
    }
    ensure!(
        fs::metadata(&target)?.len() == metadata.len(),
        "游戏后台程序不完整"
    );
    for entry in fs::read_dir(&directory)?.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let owned_name = name
            .strip_prefix("MinecraftHost-")
            .and_then(|name| name.strip_suffix(".exe"))
            .is_some_and(|name| {
                name.split_once('-').is_some_and(|(size, time)| {
                    size.parse::<u64>().is_ok() && time.parse::<u128>().is_ok()
                })
            });
        if path != target && owned_name && entry.file_type().is_ok_and(|kind| kind.is_file()) {
            // Windows refuses to delete a mapped executable. Keep hosts still
            // serving games, and remove only old, unused versions we created.
            let _ = fs::remove_file(path);
        }
    }
    Ok(target)
}

fn bootstrap(request: &Request) -> Result<()> {
    let data = request
        .session
        .parent()
        .and_then(Path::parent)
        .context("游戏会话路径无效")?;
    let mut host = command(HOST, &host_executable(data)?).spawn()?;
    {
        let mut input = host.stdin.take().context("无法传递游戏参数")?;
        input.write_all(&serde_json::to_vec(request)?)?;
    }
    let mut output = std::io::BufReader::new(host.stdout.take().context("无法读取游戏启动状态")?);
    let mut line = String::new();
    loop {
        line.clear();
        ensure!(
            output.read_line(&mut line)? != 0,
            "游戏后台程序未报告启动状态"
        );
        if let Some((_, payload)) = line.split_once(READY) {
            let value: Hello = serde_json::from_str(payload)?;
            hello(value)?;
            // Dropping std::process::Child leaves the host running. Its parent
            // is now gone, so the game is outside the launcher's live tree.
            return Ok(());
        }
    }
}

/// Must run before the desktop app creates any window or WebView.
pub fn run_helper() -> bool {
    #[cfg(not(test))]
    let mode = std::env::args().nth(1).unwrap_or_default();
    #[cfg(test)]
    let mode = std::env::var("SFMCL_T_TEST_GAME_HELPER").unwrap_or_default();
    if mode != BOOTSTRAP && mode != HOST {
        return false;
    }
    let result = (|| -> Result<()> {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 2 * 1024 * 1024, "游戏启动参数过大");
        let request: Request = serde_json::from_slice(&bytes)?;
        let context = request
            .snapshot
            .launch
            .as_ref()
            .context("缺少游戏运行信息")?;
        ensure!(
            request.directory.is_absolute() && request.session.is_absolute(),
            "游戏路径必须为绝对路径"
        );
        let id = uuid::Uuid::parse_str(&request.snapshot.id)?.to_string();
        ensure!(
            request
                .session
                .file_name()
                .is_some_and(|name| name == id.as_str()),
            "游戏会话路径不匹配"
        );
        safe_join(
            &minecraft_root(Path::new(&context.directory)),
            format!("versions/{}", context.version_id),
        )?;
        if mode == BOOTSTRAP {
            bootstrap(&request)
        } else {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?
                .block_on(host(request))
        }
    })();
    if let Err(error) = result {
        let _ = hello(Hello {
            host: None,
            error: Some(format!("{error:#}")),
        });
    }
    true
}

async fn host(request: Request) -> Result<()> {
    let context = request
        .snapshot
        .launch
        .as_ref()
        .context("缺少游戏运行信息")?;
    let root = minecraft_root(Path::new(&context.directory));
    let lock_path = safe_join(
        &root,
        format!(".tmcl/locks/launch-{}.lock", context.version_id),
    )?;
    fs::create_dir_all(lock_path.parent().context("游戏锁路径无效")?)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    lock.try_lock_shared().context("游戏版本正在被独占操作")?;
    ensure!(!request.session.join("cancel").exists(), "启动已取消");
    let jobs = Jobs::default();
    let job = jobs.restore_launch(request.snapshot);
    let identity = Identity::read(std::process::id())?;
    let mut state = State {
        host: identity.clone(),
        game: None,
        snapshot: job.snapshot(),
        code: None,
    };
    let mut previous = Vec::new();
    publish(&request.session, &state, &mut previous)?;
    let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let running_job = job.clone();
    let runner = super::process::run_java_with_settings(
        &request.java,
        &request.args,
        &request.directory,
        running_job,
        &request.redactions,
        &request.settings,
        Some(events),
    );
    tokio::pin!(runner);
    let mut tick = tokio::time::interval(POLL);
    let mut announced = false;
    let result = loop {
        tokio::select! {
            biased;
            Some(event) = receiver.recv() => {
                if let LaunchEvent::Started { pid, .. } = event {
                    state.game = Identity::read(pid).ok();
                    state.snapshot = job.snapshot();
                    publish(&request.session, &state, &mut previous)?;
                    hello(Hello { host: Some(identity.clone()), error: None })?;
                    announced = true;
                }
            }
            result = &mut runner => break result,
            _ = tick.tick() => {
                if request.session.join("cancel").exists() {
                    job.cancel.cancel();
                }
                state.snapshot = job.snapshot();
                publish(&request.session, &state, &mut previous)?;
            }
        }
    };
    // Very short-lived programs can complete in the same poll that emits Started.
    if !announced {
        while let Ok(event) = receiver.try_recv() {
            if let LaunchEvent::Started { pid, .. } = event {
                state.game = Identity::read(pid).ok();
                hello(Hello {
                    host: Some(identity.clone()),
                    error: None,
                })?;
                announced = true;
                break;
            }
        }
    }
    state.code = result.as_ref().ok().copied();
    job.finish(&result.map(|_| ()));
    state.snapshot = job.snapshot();
    publish(&request.session, &state, &mut previous)?;
    if !announced {
        hello(Hello {
            host: None,
            error: state.snapshot.error.clone(),
        })?;
    }
    Ok(())
}

struct PendingLaunch {
    session: PathBuf,
    committed: bool,
}
impl Drop for PendingLaunch {
    fn drop(&mut self) {
        if !self.committed {
            let _ = atomic_write(&self.session.join("cancel"), b"");
        }
    }
}

pub async fn run_game(
    data: &Path,
    java: &str,
    args: &[String],
    directory: &Path,
    job: Arc<Job>,
    redactions: &[String],
    settings: &Settings,
    events: Option<LaunchEvents>,
) -> Result<i32> {
    let session = data.join("game-processes").join(&job.snapshot().id);
    fs::create_dir_all(&session)?;
    let mut pending = PendingLaunch {
        session: session.clone(),
        committed: false,
    };
    let request = Request {
        session: session.clone(),
        java: java.into(),
        args: args.into(),
        directory: directory.into(),
        settings: settings.clone(),
        snapshot: job.snapshot(),
        redactions: redactions.into(),
    };
    let mut bootstrap =
        tokio::process::Command::from(command(BOOTSTRAP, &std::env::current_exe()?))
            .kill_on_drop(true)
            .spawn()
            .context("无法启动游戏后台程序")?;
    let handshake = tokio::time::timeout(Duration::from_secs(30), async {
        {
            let mut input = bootstrap.stdin.take().context("无法传递游戏参数")?;
            input.write_all(&serde_json::to_vec(&request)?).await?;
            input.shutdown().await?;
        }
        let mut output = BufReader::new(bootstrap.stdout.take().context("无法读取游戏启动状态")?);
        let mut line = String::new();
        let value = loop {
            line.clear();
            ensure!(
                output.read_line(&mut line).await? != 0,
                "游戏后台程序未报告启动状态"
            );
            if let Some((_, payload)) = line.split_once(READY) {
                break serde_json::from_str::<Hello>(payload)?;
            }
        };
        ensure!(
            bootstrap.wait().await?.success(),
            "游戏启动中间进程异常退出"
        );
        if let Some(error) = value.error {
            bail!(error);
        }
        value.host.context("游戏后台程序未报告进程信息")
    });
    let started = tokio::select! {
        biased;
        _ = job.cancel.cancelled() => bail!(job.cancellation_message()),
        result = handshake => result.context("游戏后台程序启动超时")??,
    };
    let state = read_state(&session)?;
    ensure!(state.host == started, "游戏后台进程身份发生变化");
    pending.committed = true;
    job.set_launch_running(true);
    if let Some(events) = &events {
        let _ = events.send(LaunchEvent::Started {
            action: settings.launcher_action.clone(),
            restore: settings.restore_launcher,
            pid: state.game.as_ref().map_or(0, |game| game.pid),
        });
    }
    monitor(session, started, job, events).await
}

async fn monitor(
    session: PathBuf,
    identity: Identity,
    job: Arc<Job>,
    events: Option<LaunchEvents>,
) -> Result<i32> {
    let _exit = ExitEvent {
        events,
        job: job.clone(),
    };
    let mut cancellation_sent = false;
    loop {
        if job.cancel.is_cancelled() && !cancellation_sent {
            atomic_write(&session.join("cancel"), b"")?;
            cancellation_sent = true;
        }
        let state = read_state(&session)?;
        ensure!(state.host == identity, "游戏后台进程身份发生变化");
        let status = state.snapshot.status;
        let error = state.snapshot.error.clone();
        job.sync_launch(state.snapshot);
        if status.terminal() {
            if status == Status::Completed {
                return Ok(state.code.unwrap_or(0));
            }
            bail!(error.unwrap_or_else(|| "游戏进程已停止".into()));
        }
        if !identity.alive() {
            // The final atomic state may have been published just after our read.
            let final_state = read_state(&session)?;
            if final_state.snapshot.status.terminal() {
                continue;
            }
            bail!("游戏后台程序异常退出，请查看游戏日志");
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Reattach only to registered games and a host with the same creation time and
/// executable. PID reuse must never turn an unrelated process into a game task.
pub struct RecoveredGame {
    session: PathBuf,
    host: Identity,
    job: Arc<Job>,
}
impl RecoveredGame {
    pub async fn watch(self) {
        let result = monitor(self.session, self.host, self.job.clone(), None)
            .await
            .map(|_| ());
        self.job.finish(&result);
    }
}

pub fn recover(data: &Path, settings: &Settings, jobs: &Arc<Jobs>) -> Result<Vec<RecoveredGame>> {
    let directory = data.join("game-processes");
    let mut recovered = Vec::new();
    if !directory.is_dir() {
        return Ok(recovered);
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let session = entry.path();
        let Ok(state) = read_state(&session) else {
            continue;
        };
        let Some(context) = &state.snapshot.launch else {
            continue;
        };
        if uuid::Uuid::parse_str(&state.snapshot.id).is_err()
            || session
                .file_name()
                .is_none_or(|name| name != state.snapshot.id.as_str())
            || settings
                .registered_game_root(Path::new(&context.directory))
                .is_err()
            || !state.host.alive()
            || state.snapshot.status.terminal()
        {
            continue;
        }
        let job = jobs.restore_launch(state.snapshot);
        recovered.push(RecoveredGame {
            session,
            host: state.host,
            job,
        });
    }
    Ok(recovered)
}

impl Identity {
    fn read(pid: u32) -> Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::{Foundation::*, System::Threading::*};
        unsafe {
            let raw = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            );
            ensure!(
                !raw.is_null(),
                "无法查询游戏进程：{}",
                std::io::Error::last_os_error()
            );
            let handle = OwnedHandle::from_raw_handle(raw);
            ensure!(
                WaitForSingleObject(handle.as_raw_handle(), 0) == WAIT_TIMEOUT,
                "游戏进程已退出"
            );
            let mut created: FILETIME = std::mem::zeroed();
            let mut exited = created;
            let mut kernel = created;
            let mut user = created;
            ensure!(
                GetProcessTimes(raw, &mut created, &mut exited, &mut kernel, &mut user) != 0,
                "无法查询游戏进程创建时间"
            );
            let mut buffer = vec![0u16; 32768];
            let mut length = buffer.len() as u32;
            ensure!(
                QueryFullProcessImageNameW(raw, 0, buffer.as_mut_ptr(), &mut length) != 0,
                "无法查询游戏程序路径"
            );
            use std::os::windows::ffi::OsStringExt;
            Ok(Self {
                pid,
                created: ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64,
                executable: std::ffi::OsString::from_wide(&buffer[..length as usize]).into(),
            })
        }
    }
    fn alive(&self) -> bool {
        Self::read(self.pid).is_ok_and(|identity| identity == *self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::GameDirectory, jobs::LaunchContext};

    const TEST_LAUNCHER: &str = "test-launcher";

    struct Fixture {
        temp: tempfile::TempDir,
        settings: Settings,
    }
    impl Fixture {
        fn new(name: &str) -> Self {
            let base = std::env::var_os("SFMCL_T_DETACHED_TEST_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../target/tmp/detached-process-tests")
                });
            fs::create_dir_all(&base).unwrap();
            let temp = tempfile::Builder::new()
                .prefix(name)
                .tempdir_in(base)
                .unwrap();
            let directory = temp.path().join("game with spaces");
            fs::create_dir_all(&directory).unwrap();
            let settings = Settings {
                active_dir: directory.to_string_lossy().into(),
                game_dirs: vec![GameDirectory {
                    name: "test".into(),
                    path: directory.to_string_lossy().into(),
                }],
                ..Default::default()
            };
            Self { temp, settings }
        }
        fn job(&self, jobs: &Jobs) -> Arc<Job> {
            let job = jobs.create(
                crate::jobs::JobKind::Launch,
                "启动 test".into(),
                &["游戏运行"],
            );
            job.set_launch_context(LaunchContext {
                version_id: "test".into(),
                game_version: "1.21.4".into(),
                directory: self.settings.active_dir.clone(),
                player_name: "Alex".into(),
                offline_lan: false,
                running: false,
            });
            job
        }
        fn request(&self, job: &Job, script: &str) -> Request {
            Request {
                session: self
                    .temp
                    .path()
                    .join("game-processes")
                    .join(job.snapshot().id),
                java: "powershell.exe".into(),
                args: vec!["-NoProfile".into(), "-Command".into(), script.into()],
                directory: PathBuf::from(&self.settings.active_dir),
                settings: self.settings.clone(),
                snapshot: job.snapshot(),
                redactions: vec!["token-secret".into()],
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // Also runs on assertions/timeouts: no test game or mapped helper
            // executable may be left behind in the recorded scratch directory.
            if let Ok(entries) = fs::read_dir(self.temp.path().join("game-processes")) {
                let sessions: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
                for session in &sessions {
                    let _ = atomic_write(&session.join("cancel"), b"");
                }
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                while std::time::Instant::now() < deadline
                    && sessions.iter().any(|session| {
                        read_state(session).is_ok_and(|state| {
                            state.host.pid != std::process::id() && state.host.alive()
                        })
                    })
                {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }

    #[test]
    fn helper_entry() {
        let Ok(mode) = std::env::var("SFMCL_T_TEST_GAME_HELPER") else {
            return;
        };
        if mode != TEST_LAUNCHER {
            assert!(run_helper());
            return;
        }
        let mut bytes = Vec::new();
        std::io::stdin().read_to_end(&mut bytes).unwrap();
        let request: Request = serde_json::from_slice(&bytes).unwrap();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let jobs = Jobs::default();
                let job = jobs.restore_launch(request.snapshot);
                let session = request.session.clone();
                let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
                tokio::spawn(async move {
                    run_game(
                        request.session.parent().unwrap().parent().unwrap(),
                        &request.java,
                        &request.args,
                        &request.directory,
                        job,
                        &request.redactions,
                        &request.settings,
                        Some(events),
                    )
                    .await
                    .unwrap();
                });
                assert!(matches!(
                    receiver.recv().await,
                    Some(LaunchEvent::Started { .. })
                ));
                hello(Hello {
                    host: Some(read_state(&session).unwrap().host),
                    error: None,
                })
                .unwrap();
                // Reproduce Tauri's actual exit, including skipped Rust destructors.
                std::process::exit(0);
            });
    }

    async fn wait_state(session: &Path, check: impl Fn(&State) -> bool) -> State {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Ok(state) = read_state(session) {
                    if check(&state) {
                        break state;
                    }
                }
                tokio::time::sleep(POLL).await;
            }
        })
        .await
        .unwrap()
    }

    async fn start(
        request: Request,
    ) -> (
        tokio::task::JoinHandle<Result<i32>>,
        Arc<Job>,
        tokio::sync::mpsc::UnboundedReceiver<LaunchEvent>,
    ) {
        let jobs = Jobs::default();
        let job = jobs.restore_launch(request.snapshot);
        let running_job = job.clone();
        let (events, receiver) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let result = run_game(
                request.session.parent().unwrap().parent().unwrap(),
                &request.java,
                &request.args,
                &request.directory,
                running_job.clone(),
                &request.redactions,
                &request.settings,
                Some(events),
            )
            .await;
            running_job.finish(
                &result
                    .as_ref()
                    .map(|_| ())
                    .map_err(|error| anyhow::anyhow!("{error:#}")),
            );
            result
        });
        (task, job, receiver)
    }

    #[tokio::test]
    async fn game_survives_launcher_exit_and_reopened_launcher_can_manage_it() {
        let fixture = Fixture::new("survive-");
        let job = fixture.job(&Jobs::default());
        let request = fixture.request(&job, "Write-Output 'before token-secret'; Start-Sleep -Milliseconds 1500; [Console]::Error.WriteLine('after token-secret'); Start-Sleep -Seconds 60");
        let session = request.session.clone();
        let mut launcher = tokio::process::Command::from(command(
            TEST_LAUNCHER,
            &std::env::current_exe().unwrap(),
        ))
        .kill_on_drop(true)
        .spawn()
        .unwrap();
        let launcher_pid = launcher.id().unwrap();
        {
            let mut input = launcher.stdin.take().unwrap();
            input
                .write_all(&serde_json::to_vec(&request).unwrap())
                .await
                .unwrap();
        }
        let mut output = BufReader::new(launcher.stdout.take().unwrap());
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                line.clear();
                assert_ne!(output.read_line(&mut line).await.unwrap(), 0);
                if line.contains(READY) {
                    break;
                }
            }
            assert!(launcher.wait().await.unwrap().success());
        })
        .await
        .unwrap();
        assert!(Identity::read(launcher_pid).is_err());
        let state = wait_state(&session, |state| {
            state
                .snapshot
                .log
                .iter()
                .any(|line| line.contains("after [REDACTED]"))
        })
        .await;
        assert!(state.host.alive());
        assert!(state.game.as_ref().unwrap().alive());
        assert!(state
            .host
            .executable
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("MinecraftHost-"));
        let system = sysinfo::System::new_all();
        let host = system
            .process(sysinfo::Pid::from_u32(state.host.pid))
            .unwrap();
        assert_ne!(host.parent().unwrap().as_u32(), launcher_pid);
        assert!(system.process(host.parent().unwrap()).is_none());
        assert_eq!(
            system
                .process(sysinfo::Pid::from_u32(state.game.as_ref().unwrap().pid))
                .unwrap()
                .parent()
                .unwrap()
                .as_u32(),
            state.host.pid
        );
        assert!(
            !String::from_utf8(fs::read(session.join("state.json")).unwrap())
                .unwrap()
                .contains("token-secret")
        );
        let reopened = Arc::new(Jobs::default());
        let recovered = recover(fixture.temp.path(), &fixture.settings, &reopened).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(reopened.running_launches().len(), 1);
        let monitors: Vec<_> = recovered
            .into_iter()
            .map(|game| tokio::spawn(game.watch()))
            .collect();
        reopened.cancel(&job.snapshot().id).unwrap();
        for monitor in monitors {
            tokio::time::timeout(Duration::from_secs(10), monitor)
                .await
                .unwrap()
                .unwrap();
        }
        assert!(reopened.running_launches().is_empty());
        assert_eq!(reopened.snapshots()[0].status, Status::Cancelled);
        assert!(!state.game.unwrap().alive());
    }

    #[tokio::test]
    async fn simultaneous_games_keep_independent_cancellation_and_version_locks() {
        let fixture = Fixture::new("parallel-");
        let jobs = Jobs::default();
        let first = fixture.request(&fixture.job(&jobs), "Start-Sleep -Seconds 60");
        let second = fixture.request(&fixture.job(&jobs), "Start-Sleep -Seconds 60");
        let second_session = second.session.clone();
        let (first_task, first_job, mut first_events) = start(first).await;
        let (second_task, second_job, mut second_events) = start(second).await;
        for receiver in [&mut first_events, &mut second_events] {
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(15), receiver.recv())
                    .await
                    .unwrap(),
                Some(LaunchEvent::Started { .. })
            ));
        }
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(
                minecraft_root(Path::new(&fixture.settings.active_dir))
                    .join(".tmcl/locks/launch-test.lock"),
            )
            .unwrap();
        assert!(lock.try_lock().is_err());
        first_job.cancel.cancel();
        assert!(tokio::time::timeout(Duration::from_secs(10), first_task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert!(read_state(&second_session).unwrap().game.unwrap().alive());
        assert!(lock.try_lock().is_err());
        second_job.cancel.cancel();
        assert!(tokio::time::timeout(Duration::from_secs(10), second_task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if lock.try_lock().is_ok() {
                    break;
                }
                tokio::time::sleep(POLL).await;
            }
        })
        .await
        .unwrap();
        assert!(matches!(
            first_events.recv().await,
            Some(LaunchEvent::Exited)
        ));
        assert!(matches!(
            second_events.recv().await,
            Some(LaunchEvent::Exited)
        ));
    }

    #[tokio::test]
    async fn short_lived_games_and_spawn_failure_report_correct_lifecycle() {
        let fixture = Fixture::new("exit-");
        for code in [0, 7] {
            let job = fixture.job(&Jobs::default());
            let request =
                fixture.request(&job, &format!("Write-Output 'quoted value'; exit {code}"));
            let (task, job, mut events) = start(request).await;
            let result = tokio::time::timeout(Duration::from_secs(15), task)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(result.is_ok(), code == 0, "{result:?}");
            assert!(matches!(
                events.recv().await,
                Some(LaunchEvent::Started { .. })
            ));
            assert!(matches!(events.recv().await, Some(LaunchEvent::Exited)));
            assert!(events.recv().await.is_none());
            assert!(!job.snapshot().launch.unwrap().running);
            assert!(job.snapshot().log.iter().any(|line| line == "quoted value"));
            if code != 0 {
                assert!(job.snapshot().error.unwrap().contains("7"));
            }
        }
        let job = fixture.job(&Jobs::default());
        let mut request = fixture.request(&job, "");
        request.java = "nonexistent-sfmcl-java.exe".into();
        let (task, _, mut events) = start(request).await;
        assert!(tokio::time::timeout(Duration::from_secs(15), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert!(events.recv().await.is_none());
    }

    #[tokio::test]
    async fn cancellation_before_handover_does_not_leave_a_running_game() {
        let fixture = Fixture::new("cancel-start-");
        let job = fixture.job(&Jobs::default());
        let request = fixture.request(&job, "Start-Sleep -Seconds 60");
        let session = request.session.clone();
        job.cancel.cancel();
        let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let result = run_game(
            fixture.temp.path(),
            &request.java,
            &request.args,
            &request.directory,
            job,
            &request.redactions,
            &request.settings,
            Some(events),
        )
        .await;
        assert!(result.is_err());
        assert!(receiver.recv().await.is_none());
        assert!(session.join("cancel").is_file());
    }

    #[test]
    fn recovery_rejects_reused_pid_and_unregistered_games() {
        let fixture = Fixture::new("identity-");
        let job = fixture.job(&Jobs::default());
        job.set_launch_running(true);
        let session = fixture
            .temp
            .path()
            .join("game-processes")
            .join(job.snapshot().id);
        let mut state = State {
            host: Identity::read(std::process::id()).unwrap(),
            game: None,
            snapshot: job.snapshot(),
            code: None,
        };
        state.host.created += 1;
        publish(&session, &state, &mut Vec::new()).unwrap();
        assert!(recover(
            fixture.temp.path(),
            &fixture.settings,
            &Arc::new(Jobs::default())
        )
        .unwrap()
        .is_empty());
        state.host = Identity::read(std::process::id()).unwrap();
        state.snapshot.launch.as_mut().unwrap().directory = fixture
            .temp
            .path()
            .join("unregistered")
            .to_string_lossy()
            .into();
        publish(&session, &state, &mut Vec::new()).unwrap();
        assert!(recover(
            fixture.temp.path(),
            &fixture.settings,
            &Arc::new(Jobs::default())
        )
        .unwrap()
        .is_empty());
    }
}
