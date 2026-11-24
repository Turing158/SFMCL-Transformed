use super::*;
use crate::jobs::{JobKind, LaunchContext};
use std::sync::Arc;

const MISSING: &str =
    "Mod 'Continuity' (continuity) requires any version of fabric-api, which is missing!";

fn job(jobs: &Jobs) -> Arc<Job> {
    let job = jobs.create(JobKind::Launch, "启动 test".into(), &["游戏运行"]);
    job.set_launch_context(LaunchContext {
        version_id: "test".into(),
        game_version: "1.20.1".into(),
        directory: "test".into(),
        player_name: "Alex".into(),
        offline_lan: false,
        running: true,
    });
    job
}

#[test]
fn diagnoses_supported_causes_and_does_not_guess_from_exit_codes() {
    for (log, category) in [
        ("java.lang.UnsupportedClassVersionError: version 65", "java"),
        ("游戏需要 Java 21，所选 Java 是 17", "java"),
        ("找不到 Java 21，请在设置中添加兼容 Java", "java"),
        (
            "Could not reserve enough space for object heap",
            "memory-allocation",
        ),
        ("java.lang.OutOfMemoryError: Java heap space", "memory"),
        ("DuplicateModsFoundException: duplicate", "duplicate-mods"),
        (MISSING, "missing-dependency"),
        (
            "Missing mandatory dependencies: fabric",
            "missing-dependency",
        ),
        (
            "Missing or unsupported mandatory dependencies",
            "dependency-version",
        ),
        ("Mixin apply failed: example", "mixin"),
        ("EXCEPTION_ACCESS_VIOLATION", "native"),
    ] {
        assert_eq!(analyze(log).unwrap().1.category, category, "{log}");
    }
    let report = analyze(MISSING).unwrap().1;
    assert_eq!(report.title, "缺少前置模组 Fabric API");
    assert!(report.description.contains("Continuity"));
    assert!(analyze("Exit code 1; optional dependency not installed").is_none());
    assert!(analyze("Mixin apply failed")
        .unwrap()
        .1
        .title
        .starts_with("疑似"));
}

#[test]
fn only_new_logs_are_used_and_more_specific_errors_override_mixin() {
    let temp = tempfile::tempdir().unwrap();
    let game = temp.path().join("game");
    fs::create_dir_all(game.join("logs")).unwrap();
    fs::create_dir_all(game.join("crash-reports")).unwrap();
    fs::write(game.join("logs/latest.log"), "UnsupportedClassVersionError").unwrap();
    fs::write(game.join("crash-reports/crash-old.txt"), "OutOfMemoryError").unwrap();
    let capture = Capture::new(&game, &[]);
    capture.line("Mixin apply failed");
    fs::write(game.join("logs/debug.log"), MISSING).unwrap();
    let jobs = Jobs::default();
    let job = job(&jobs);
    capture.finish(temp.path(), &job, 7);
    let report = job.snapshot().crash_report.unwrap();
    assert_eq!(report.category, "missing-dependency");
    assert_eq!(report.exit_code, Some(7));
    assert_eq!(
        report.log_path.as_ref().unwrap(),
        &game.join("logs/debug.log")
    );
    assert!(original_log(&report).is_some());
    fs::write(
        game.join("logs/debug.log"),
        "a different launch replaced the log",
    )
    .unwrap();
    assert!(original_log(&report).is_none());
    let evidence =
        fs::read_to_string(archived_log(temp.path(), &job.snapshot().id).unwrap()).unwrap();
    assert!(!evidence.contains("UnsupportedClassVersionError"));
    assert!(!evidence.contains("OutOfMemoryError"));
}

#[test]
fn keeps_early_errors_and_recent_output_with_bounded_redacted_storage() {
    let temp = tempfile::tempdir().unwrap();
    let capture = Capture::new(temp.path(), &["secret-value".into()]);
    capture.line(MISSING);
    capture.line("accessToken: other-secret secret-value");
    for _ in 0..6000 {
        capture.line(&"x".repeat(200));
    }
    capture.line("last line");
    let jobs = Jobs::default();
    let job = job(&jobs);
    capture.finish(temp.path(), &job, 1);
    assert_eq!(
        job.snapshot().crash_report.unwrap().category,
        "missing-dependency"
    );
    let evidence =
        fs::read_to_string(archived_log(temp.path(), &job.snapshot().id).unwrap()).unwrap();
    assert!(evidence.contains(MISSING));
    assert!(evidence.contains("last line"));
    assert!(!evidence.contains("secret-value"));
    assert!(!evidence.contains("other-secret"));
    assert!(evidence.len() < PART_LIMIT * 2 + 200);
}

#[test]
fn reports_survive_restart_and_acknowledgement_is_persistent() {
    let temp = tempfile::tempdir().unwrap();
    let jobs = Jobs::default();
    let original = job(&jobs);
    original.log("accessToken: private-token".into());
    startup_failure(temp.path(), &original, "找不到 Java 21", &[]);
    let recovered = Jobs::default();
    recover(temp.path(), &recovered);
    let restored = recovered.get(&original.snapshot().id).unwrap();
    assert_eq!(restored.snapshot().status, Status::Failed);
    assert!(!restored.snapshot().launch.unwrap().running);
    assert!(!restored.snapshot().crash_report.unwrap().acknowledged);
    assert!(!restored.snapshot().log.join("\n").contains("private-token"));
    acknowledge(temp.path(), &restored).unwrap();
    let reopened = Jobs::default();
    recover(temp.path(), &reopened);
    assert!(
        reopened.snapshots()[0]
            .crash_report
            .as_ref()
            .unwrap()
            .acknowledged
    );
    assert!(archived_log(temp.path(), "../escape").is_err());
}

#[test]
fn cancellation_and_download_failure_do_not_create_crash_reports() {
    let temp = tempfile::tempdir().unwrap();
    let jobs = Jobs::default();
    let cancelled = job(&jobs);
    cancelled.cancel.cancel();
    Capture::new(temp.path(), &[]).finish(temp.path(), &cancelled, 1);
    startup_failure(temp.path(), &cancelled, MISSING, &[]);
    assert!(cancelled.snapshot().crash_report.is_none());
    let download = job(&jobs);
    download.download("download".into(), Status::Failed);
    startup_failure(temp.path(), &download, "HTTP timeout", &[]);
    assert!(download.snapshot().crash_report.is_none());
    assert!(!temp.path().join("crash-analysis").exists());
}

#[test]
fn retention_keeps_recent_reports_and_preserves_unknown_files() {
    let temp = tempfile::tempdir().unwrap();
    let jobs = Jobs::default();
    let first = job(&jobs);
    startup_failure(temp.path(), &first, "找不到 Java 17", &[]);
    let first_dir = report_directory(temp.path(), &first.snapshot().id).unwrap();
    let mut saved: JobSnapshot =
        serde_json::from_slice(&fs::read(first_dir.join("report.json")).unwrap()).unwrap();
    saved.created_at = 1;
    fs::write(
        first_dir.join("report.json"),
        serde_json::to_vec(&saved).unwrap(),
    )
    .unwrap();
    fs::write(first_dir.join("user-note.txt"), b"keep").unwrap();
    for _ in 0..RETAIN_REPORTS {
        startup_failure(temp.path(), &job(&jobs), "找不到 Java 21", &[]);
    }
    assert_eq!(saved_reports(temp.path()).len(), RETAIN_REPORTS);
    assert_eq!(fs::read(first_dir.join("user-note.txt")).unwrap(), b"keep");
    assert!(!first_dir.join("report.json").exists());
}

#[cfg(windows)]
#[tokio::test]
async fn real_process_output_is_analyzed_only_on_unsuccessful_exit() {
    let temp = tempfile::tempdir().unwrap();
    for code in [0, 7] {
        let jobs = Jobs::default();
        let job = job(&jobs);
        let result = super::super::process::run_java_diagnosed(
            "cmd.exe",
            &[
                "/D".into(),
                "/C".into(),
                format!("echo java.lang.OutOfMemoryError: Java heap space & exit {code}"),
            ],
            temp.path(),
            job.clone(),
            &[],
            &Default::default(),
            None,
            Some(temp.path()),
        )
        .await;
        assert_eq!(result.is_ok(), code == 0);
        if code == 0 {
            assert!(job.snapshot().crash_report.is_none());
        } else {
            let report = job.snapshot().crash_report.unwrap();
            assert_eq!(report.category, "memory");
            assert_eq!(report.exit_code, Some(7));
        }
    }
}
