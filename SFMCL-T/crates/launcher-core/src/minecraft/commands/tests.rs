use super::*;
use crate::{
    config::Settings,
    jobs::{JobKind, Jobs, LaunchContext},
    minecraft::process::{run_java_with_settings, LaunchEvent},
};
use std::{fs, path::PathBuf, time::Duration};

struct Fixture {
    temp: tempfile::TempDir,
    job: Arc<Job>,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::var_os("SFMCL_T_COMMAND_TEST_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp/launch-command-tests")
            });
        fs::create_dir_all(&base).unwrap();
        let temp = tempfile::Builder::new()
            .prefix("命令测试 空格-")
            .tempdir_in(base)
            .unwrap();
        let job = Jobs::default().create(
            JobKind::Launch,
            "启动 test".into(),
            &["游戏运行", "退出后命令"],
        );
        job.set_launch_context(LaunchContext {
            version_id: "test-version".into(),
            game_version: "1.21.4".into(),
            directory: temp.path().to_string_lossy().into(),
            player_name: "O'Neil & echo injected".into(),
            offline_lan: false,
            running: false,
        });
        job.initialize_commands(true, true);
        Self { temp, job }
    }
    fn config(&self, command: &str) -> CommandSettings {
        CommandSettings {
            enabled: true,
            shell: CommandShell::Powershell,
            command: command.into(),
            timeout_seconds: 10,
            ..Default::default()
        }
    }
    async fn run(&self, config: &CommandSettings) -> Result<()> {
        execute(
            config,
            CommandPhase::PreLaunch,
            self.temp.path(),
            "Java path 空格",
            self.job.clone(),
            &["token-secret".into()],
            &self.job.cancel,
        )
        .await
        .map_err(|error| error.context(self.job.snapshot().log.join("\n")))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.job.cancel.cancel();
        self.job.command_cancel.cancel();
    }
}

#[test]
fn legacy_defaults_and_validation() {
    let settings: Settings = serde_json::from_str("{}").unwrap();
    assert!(!settings.pre_launch_command.enabled && !settings.post_exit_command.enabled);
    assert_eq!(settings.pre_launch_command.timeout_seconds, 60);
    assert_eq!(settings.post_exit_command.timeout_seconds, 300);
    let mut config = CommandSettings::default();
    config.enabled = true;
    assert!(config.validate().is_err());
    config.command = "echo ready".into();
    config.validate().unwrap();
    for timeout in [0, 3601] {
        config.timeout_seconds = timeout;
        assert!(config.validate().is_err());
    }
    config.timeout_seconds = 60;
    config.command = "x".repeat(65537);
    assert!(config.validate().is_err());
}

#[cfg(windows)]
#[tokio::test]
async fn powershell_preserves_unicode_paths_environment_and_redacts_logs() {
    let fixture = Fixture::new();
    let config = fixture.config("[IO.File]::WriteAllText((Join-Path $env:SFMCL_GAME_DIR '准备.txt'), ($env:SFMCL_PLAYER_NAME + '|' + $env:SFMCL_VERSION_ID + '|' + $env:SFMCL_SESSION_ID + '|' + $env:SFMCL_JAVA_PATH)); Write-Output 'token-secret'; Write-Output '中文输出'");
    fixture.run(&config).await.unwrap();
    assert_eq!(
        fs::read_to_string(fixture.temp.path().join("准备.txt")).unwrap(),
        format!(
            "O'Neil & echo injected|test-version|{}|Java path 空格",
            fixture.job.snapshot().id
        )
    );
    let log = fixture.job.snapshot().log.join("\n");
    assert!(!log.contains("token-secret"));
    assert!(log.contains("[REDACTED]") && log.contains("中文输出"));
    assert_eq!(
        fixture
            .job
            .snapshot()
            .command_runs
            .unwrap()
            .pre_launch
            .status,
        CommandStatus::Completed
    );
}

#[cfg(windows)]
#[tokio::test]
async fn cmd_multiline_and_relative_working_directory() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.temp.path().join("脚本 目录")).unwrap();
    let config = CommandSettings {
        enabled: true,
        shell: CommandShell::Cmd,
        command: "echo 第一行>结果.txt\nif exist 结果.txt (\n echo second>>结果.txt\n)\nexit /b 0"
            .into(),
        working_directory: "脚本 目录".into(),
        timeout_seconds: 10,
        ..Default::default()
    };
    fixture.run(&config).await.unwrap();
    let text = fs::read_to_string(fixture.temp.path().join("脚本 目录/结果.txt")).unwrap();
    assert!(text.contains("第一行") && text.contains("second"));
}

#[cfg(windows)]
#[tokio::test]
async fn failure_policy_and_powershell_errors() {
    let fixture = Fixture::new();
    for script in [
        "exit 7",
        "Get-Item -LiteralPath 'missing-sfmcl-command-file'",
        "cmd.exe /d /c exit 7",
    ] {
        let mut config = fixture.config(script);
        assert!(fixture
            .run(&config)
            .await
            .unwrap_err()
            .downcast_ref::<CommandFailure>()
            .is_some());
        assert_eq!(
            fixture
                .job
                .snapshot()
                .command_runs
                .unwrap()
                .pre_launch
                .status,
            CommandStatus::Failed
        );
        config.continue_on_failure = true;
        fixture.run(&config).await.unwrap();
        assert_eq!(
            fixture
                .job
                .snapshot()
                .command_runs
                .unwrap()
                .pre_launch
                .status,
            CommandStatus::Failed
        );
    }
}

#[cfg(windows)]
#[tokio::test]
async fn timeout_kills_command_tree_and_cancellation_never_continues_launch() {
    let fixture = Fixture::new();
    let mut config = fixture
        .config("Start-Sleep -Seconds 10; Set-Content -LiteralPath 'late.txt' -Value 'late'");
    config.timeout_seconds = 1;
    assert!(fixture
        .run(&config)
        .await
        .unwrap_err()
        .to_string()
        .contains("超时"));
    assert!(!fixture.temp.path().join("late.txt").exists());
    config.continue_on_failure = true;
    fixture.job.cancel.cancel();
    assert!(fixture.run(&config).await.is_err());
    assert_eq!(
        fixture
            .job
            .snapshot()
            .command_runs
            .unwrap()
            .pre_launch
            .status,
        CommandStatus::Cancelled
    );
}

#[cfg(windows)]
#[tokio::test]
async fn cancellation_terminates_spawned_descendants() {
    let fixture = Fixture::new();
    let child_script = fixture.temp.path().join("child.ps1");
    fs::write(
        &child_script,
        "$PID | Set-Content -LiteralPath 'child.pid'; Start-Sleep -Seconds 30",
    )
    .unwrap();
    let config = fixture.config("$script = Join-Path $env:SFMCL_GAME_DIR 'child.ps1'; Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-File', ('\"' + $script + '\"')) -WorkingDirectory $env:SFMCL_GAME_DIR; Start-Sleep -Seconds 30");
    let job = fixture.job.clone();
    let directory = fixture.temp.path().to_path_buf();
    let runner = tokio::spawn(async move {
        execute(
            &config,
            CommandPhase::PreLaunch,
            &directory,
            "java",
            job.clone(),
            &[],
            &job.cancel,
        )
        .await
    });
    let pid = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Ok(pid) = fs::read_to_string(fixture.temp.path().join("child.pid")) {
                break pid.trim().parse::<u32>().unwrap();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    fixture.job.cancel.cancel();
    assert!(runner.await.unwrap().is_err());
    let pid = pid.unwrap();
    let system = sysinfo::System::new_all();
    assert!(system.process(sysinfo::Pid::from_u32(pid)).is_none());
}

#[cfg(windows)]
#[tokio::test]
async fn post_exit_runs_for_normal_crash_and_cancel_and_never_for_spawn_failure() {
    for code in [0, 7] {
        let fixture = Fixture::new();
        let settings = Settings { post_exit_command: fixture.config("Add-Content -LiteralPath 'exit.txt' -Value ($env:SFMCL_EXIT_REASON + ':' + $env:SFMCL_EXIT_CODE)"), ..Default::default() };
        let result = run_java_with_settings(
            "cmd.exe",
            &["/D".into(), "/C".into(), format!("exit {code}")],
            fixture.temp.path(),
            fixture.job.clone(),
            &[],
            &settings,
            None,
        )
        .await;
        assert_eq!(result.is_ok(), code == 0);
        let text = fs::read_to_string(fixture.temp.path().join("exit.txt")).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(text.contains(if code == 0 { "normal:0" } else { "crashed:7" }));
    }
    let fixture = Fixture::new();
    let settings = Settings {
        post_exit_command: fixture
            .config("Add-Content -LiteralPath 'exit.txt' -Value $env:SFMCL_EXIT_REASON"),
        ..Default::default()
    };
    assert!(run_java_with_settings(
        "missing-sfmcl-command-java.exe",
        &[],
        fixture.temp.path(),
        fixture.job.clone(),
        &[],
        &settings,
        None
    )
    .await
    .is_err());
    assert!(!fixture.temp.path().join("exit.txt").exists());
    let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let job = fixture.job.clone();
    let directory = fixture.temp.path().to_path_buf();
    let runner = tokio::spawn(async move {
        run_java_with_settings(
            "powershell.exe",
            &[
                "-NoProfile".into(),
                "-Command".into(),
                "Start-Sleep -Seconds 30".into(),
            ],
            &directory,
            job,
            &[],
            &settings,
            Some(events),
        )
        .await
    });
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), receiver.recv())
            .await
            .unwrap(),
        Some(LaunchEvent::Started { .. })
    ));
    fixture.job.cancel.cancel();
    assert!(runner.await.unwrap().is_err());
    assert!(fs::read_to_string(fixture.temp.path().join("exit.txt"))
        .unwrap()
        .contains("cancelled"));
    assert_eq!(
        fixture
            .job
            .snapshot()
            .command_runs
            .unwrap()
            .post_exit
            .status,
        CommandStatus::Completed
    );
}

#[cfg(windows)]
#[tokio::test]
async fn exit_event_precedes_cleanup_and_cleanup_has_independent_stop_signal() {
    let fixture = Fixture::new();
    let settings = Settings { post_exit_command: fixture.config("Set-Content -LiteralPath 'cleanup-started.txt' -Value 'ready'; Start-Sleep -Seconds 30"), ..Default::default() };
    let job = fixture.job.clone();
    let directory = fixture.temp.path().to_path_buf();
    let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let runner = tokio::spawn(async move {
        run_java_with_settings(
            "cmd.exe",
            &["/D".into(), "/C".into(), "exit 0".into()],
            &directory,
            job,
            &[],
            &settings,
            Some(events),
        )
        .await
    });
    assert!(matches!(
        receiver.recv().await,
        Some(LaunchEvent::Started { .. })
    ));
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(3), receiver.recv())
            .await
            .unwrap(),
        Some(LaunchEvent::Exited)
    ));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !fixture.temp.path().join("cleanup-started.txt").exists() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    assert!(!fixture.job.snapshot().launch.unwrap().running);
    fixture.job.cancel_requested();
    assert!(!fixture.job.cancel.is_cancelled());
    assert!(fixture.job.command_cancel.is_cancelled());
    assert_eq!(runner.await.unwrap().unwrap(), 0);
    assert_eq!(
        fixture
            .job
            .snapshot()
            .command_runs
            .unwrap()
            .post_exit
            .status,
        CommandStatus::Cancelled
    );
}

#[cfg(windows)]
#[tokio::test]
async fn cleanup_failure_preserves_game_result() {
    let fixture = Fixture::new();
    let settings = Settings {
        post_exit_command: fixture.config("exit 9"),
        ..Default::default()
    };
    let result = run_java_with_settings(
        "cmd.exe",
        &["/D".into(), "/C".into(), "exit 0".into()],
        fixture.temp.path(),
        fixture.job.clone(),
        &[],
        &settings,
        None,
    )
    .await;
    fixture.job.finish(&result.map(|_| ()));
    let snapshot = fixture.job.snapshot();
    assert_eq!(snapshot.status, crate::downloads::Status::Completed);
    assert_eq!(snapshot.game_exit.unwrap().code, Some(0));
    assert_eq!(snapshot.command_runs.unwrap().post_exit.exit_code, Some(9));
    assert_eq!(snapshot.steps[1].status, crate::downloads::Status::Failed);
    assert!(snapshot.crash_report.is_none());
}

#[cfg(windows)]
#[tokio::test]
async fn installer_java_processes_do_not_receive_game_command_state() {
    let fixture = Fixture::new();
    let job = Jobs::default().create(JobKind::Install, "安装 test".into(), &["安装组件"]);
    super::super::process::run_java(
        "cmd.exe",
        &["/D".into(), "/C".into(), "exit 0".into()],
        fixture.temp.path(),
        job.clone(),
        &[],
    )
    .await
    .unwrap();
    assert!(job.snapshot().game_exit.is_none());
    assert!(job.snapshot().command_runs.is_none());
}

#[tokio::test]
async fn noisy_and_non_utf8_output_is_bounded_and_drained() {
    let fixture = Fixture::new();
    let bytes = vec![0xff; 100_000];
    pump(bytes.as_slice(), fixture.job.clone(), "命令", vec![]).await;
    assert!(fixture.job.snapshot().log[0].len() < 13000);
    let bytes = "line\n".repeat(1000);
    pump(bytes.as_bytes(), fixture.job.clone(), "命令", vec![]).await;
    assert!(fixture.job.snapshot().log.len() <= 201);
}
