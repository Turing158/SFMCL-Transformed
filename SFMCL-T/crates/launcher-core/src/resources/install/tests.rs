use super::*;
use crate::resources::community::ResourceKind;
use serde_json::json;
use sha1::{Digest, Sha1};
use std::{
    collections::BTreeMap,
    fs,
    io::{Cursor, Write},
};
use tokio_util::sync::CancellationToken;

fn scratch() -> tempfile::TempDir {
    match std::env::var_os("SFMCL_MOD_TEST_ROOT") {
        Some(path) => tempfile::Builder::new()
            .prefix("case-")
            .tempdir_in(path)
            .unwrap(),
        None => tempfile::tempdir().unwrap(),
    }
}
fn target(game: &Path) -> Target {
    Target {
        root: game.into(),
        version_id: "test".into(),
        game: game.into(),
        game_version: "1.20.1".into(),
        loader: "Fabric".into(),
        environment: "test".into(),
    }
}
fn dep(project: &str, version: Option<&str>) -> Dependency {
    Dependency {
        project: Some(project.into()),
        version: version.map(str::to_owned),
        filename: None,
    }
}
fn candidate(project: &str, version: &str, required: Vec<Dependency>) -> Candidate {
    Candidate {
        id: version.into(),
        project: project.into(),
        name: project.into(),
        version: version.into(),
        date: "2026-11-24".into(),
        changelog: String::new(),
        primary: true,
        stable: true,
        client_supported: true,
        game_versions: vec!["1.20.1".into()],
        loaders: vec!["Fabric".into()],
        file: DownloadSpec {
            path: format!("{project}-{version}.jar"),
            url: "https://example.com/mod.jar".into(),
            size: None,
            sha1: Some("a".repeat(40)),
            sha512: None,
        },
        required,
        incompatible: vec![],
    }
}
#[derive(Default)]
struct Fake {
    versions: BTreeMap<String, Vec<Candidate>>,
}
impl Fake {
    fn new(candidates: Vec<Candidate>) -> Self {
        let mut versions = BTreeMap::<String, Vec<Candidate>>::new();
        for candidate in candidates {
            versions
                .entry(candidate.project.clone())
                .or_default()
                .push(candidate);
        }
        Self { versions }
    }
}
impl Catalog for Fake {
    fn project<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<ProjectMeta>> {
        Box::pin(async move {
            Ok(ProjectMeta {
                name: id.into(),
                kind: ResourceKind::Mod,
                client_supported: true,
            })
        })
    }
    fn version<'a>(
        &'a self,
        project: Option<&'a str>,
        id: &'a str,
    ) -> BoxFuture<'a, Result<Candidate>> {
        Box::pin(async move {
            self.versions
                .values()
                .flatten()
                .find(|candidate| {
                    candidate.id == id && project.is_none_or(|project| candidate.project == project)
                })
                .cloned()
                .context("找不到指定前置版本")
        })
    }
    fn versions<'a>(
        &'a self,
        project: &'a str,
        _kind: ResourceKind,
    ) -> BoxFuture<'a, Result<Vec<Candidate>>> {
        Box::pin(async move { Ok(self.versions.get(project).cloned().unwrap_or_default()) })
    }
}

#[tokio::test]
async fn nested_shared_and_cyclic_dependencies_install_once() {
    let fake = Fake::new(vec![
        candidate("main", "main1", vec![dep("a", None), dep("b", None)]),
        candidate("a", "a1", vec![dep("shared", None)]),
        candidate("b", "b1", vec![dep("shared", None)]),
        candidate("shared", "s1", vec![dep("a", None)]),
    ]);
    let result = resolver::resolve(
        &fake,
        &target(Path::new("test")),
        &Inventory { files: vec![] },
        HashMap::new(),
        "main",
        "main1",
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.len(), 4);
    assert!(result[0].item.main);
}

#[tokio::test]
async fn incompatible_pins_block_instead_of_deduplicating_away_constraints() {
    let fake = Fake::new(vec![
        candidate(
            "main",
            "m1",
            vec![dep("lib", Some("l1")), dep("lib", Some("l2"))],
        ),
        candidate("lib", "l1", vec![]),
        candidate("lib", "l2", vec![]),
    ]);
    let result = resolver::resolve(
        &fake,
        &target(Path::new("test")),
        &Inventory { files: vec![] },
        HashMap::new(),
        "main",
        "m1",
        None,
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("不同版本"));
}

#[tokio::test]
async fn backtracks_to_a_version_whose_transitive_pins_can_be_satisfied() {
    let fake = Fake::new(vec![
        candidate(
            "main",
            "m1",
            vec![dep("lib", Some("l1")), dep("branch", None)],
        ),
        candidate("branch", "bad", vec![dep("lib", Some("l2"))]),
        candidate("branch", "good", vec![dep("lib", Some("l1"))]),
        candidate("lib", "l1", vec![]),
        candidate("lib", "l2", vec![]),
    ]);
    let result = resolver::resolve(
        &fake,
        &target(Path::new("test")),
        &Inventory { files: vec![] },
        HashMap::new(),
        "main",
        "m1",
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        result
            .iter()
            .find(|s| s.item.project_id == "branch")
            .unwrap()
            .candidate
            .id,
        "good"
    );
}

fn existing(disabled: bool) -> (Inventory, HashMap<String, Candidate>) {
    let path = if disabled {
        "mods/.disabled/library.jar"
    } else {
        "mods/renamed-library.jar"
    };
    (
        Inventory {
            files: vec![LocalFile {
                path: path.into(),
                sha1: "a".repeat(40),
                fingerprint: 0,
                disabled,
                mod_ids: vec!["lib".into()],
            }],
        },
        HashMap::from([(path.into(), candidate("lib", "l1", vec![]))]),
    )
}

#[tokio::test]
async fn existing_compatible_dependency_is_reused_even_after_renaming() {
    let mut main = candidate("main", "m1", vec![dep("lib", None)]);
    main.file.sha1 = Some("b".repeat(40));
    let fake = Fake::new(vec![main, candidate("lib", "l2", vec![])]);
    let (inventory, installed) = existing(false);
    let result = resolver::resolve(
        &fake,
        &target(Path::new("test")),
        &inventory,
        installed,
        "main",
        "m1",
        None,
    )
    .await
    .unwrap();
    let lib = result.iter().find(|s| s.item.project_id == "lib").unwrap();
    assert_eq!(lib.item.status, "installed");
    assert_eq!(lib.candidate.id, "l1");
}

#[tokio::test]
async fn disabled_dependency_requires_enabling_existing_file() {
    let mut main = candidate("main", "m1", vec![dep("lib", None)]);
    main.file.sha1 = Some("b".repeat(40));
    let fake = Fake::new(vec![main]);
    let (inventory, installed) = existing(true);
    let result = resolver::resolve(
        &fake,
        &target(Path::new("test")),
        &inventory,
        installed,
        "main",
        "m1",
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        result.iter().find(|s| !s.item.main).unwrap().item.status,
        "disabled"
    );
}

#[tokio::test]
async fn existing_wrong_version_is_a_conflict_not_an_extra_install() {
    let mut main = candidate("main", "m1", vec![dep("lib", Some("l2"))]);
    main.file.sha1 = Some("b".repeat(40));
    let mut newer = candidate("lib", "l2", vec![]);
    newer.file.sha1 = Some("c".repeat(40));
    let fake = Fake::new(vec![main, newer]);
    let (inventory, installed) = existing(false);
    let error = resolver::resolve(
        &fake,
        &target(Path::new("test")),
        &inventory,
        installed,
        "main",
        "m1",
        None,
    )
    .await
    .unwrap_err();
    assert!(format!("{error:#}").contains("不满足要求"));
}

#[tokio::test]
async fn duplicate_existing_files_and_loader_mismatch_block() {
    let mut main = candidate("main", "m1", vec![dep("lib", None)]);
    main.file.sha1 = Some("b".repeat(40));
    let fake = Fake::new(vec![main.clone()]);
    let (mut inventory, mut installed) = existing(false);
    let mut duplicate = inventory.files[0].clone();
    duplicate.path = "mods/duplicate.jar".into();
    inventory.files.push(duplicate.clone());
    installed.insert(duplicate.path.clone(), candidate("lib", "l1", vec![]));
    assert!(resolver::resolve(
        &fake,
        &target(Path::new("test")),
        &inventory,
        installed,
        "main",
        "m1",
        None,
    )
    .await
    .is_err());
    main.loaders = vec!["Forge".into()];
    let fake = Fake::new(vec![main]);
    assert!(resolver::resolve(
        &fake,
        &target(Path::new("test")),
        &Inventory { files: vec![] },
        HashMap::new(),
        "main",
        "m1",
        None,
    )
    .await
    .is_err());
}

#[tokio::test]
async fn explicit_incompatibility_with_installed_mod_blocks() {
    let mut main = candidate("main", "m1", vec![]);
    main.file.sha1 = Some("b".repeat(40));
    main.incompatible.push(dep("lib", None));
    let fake = Fake::new(vec![main]);
    let (inventory, installed) = existing(false);
    let error = resolver::resolve(
        &fake,
        &target(Path::new("test")),
        &inventory,
        installed,
        "main",
        "m1",
        None,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("不兼容"));
}

#[tokio::test]
async fn version_only_dependency_and_missing_filename_reference() {
    let fake = Fake::new(vec![
        candidate(
            "main",
            "m1",
            vec![Dependency {
                project: None,
                version: Some("l1".into()),
                filename: None,
            }],
        ),
        candidate("lib", "l1", vec![]),
    ]);
    assert_eq!(
        resolver::resolve(
            &fake,
            &target(Path::new("test")),
            &Inventory { files: vec![] },
            HashMap::new(),
            "main",
            "m1",
            None,
        )
        .await
        .unwrap()
        .len(),
        2
    );
    let fake = Fake::new(vec![candidate(
        "main",
        "m1",
        vec![Dependency {
            project: None,
            version: None,
            filename: Some("missing.jar".into()),
        }],
    )]);
    assert!(resolver::resolve(
        &fake,
        &target(Path::new("test")),
        &Inventory { files: vec![] },
        HashMap::new(),
        "main",
        "m1",
        None,
    )
    .await
    .unwrap_err()
    .to_string()
    .contains("手动安装"));
}

fn jar(id: &str) -> Vec<u8> {
    mod_jar(id, "1.0")
}
fn mod_jar(id: &str, version: &str) -> Vec<u8> {
    fabric_jar(json!({"id": id, "name": id, "version": version}))
}
fn fabric_jar(metadata: serde_json::Value) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file("fabric.mod.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(&serde_json::to_vec(&metadata).unwrap())
        .unwrap();
    zip.finish().unwrap().into_inner()
}

#[path = "update_tests.rs"]
mod update_tests;
fn write_jar(root: &Path, path: &str, bytes: &[u8]) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}
fn selection(id: &str, bytes: &[u8]) -> Selection {
    let mut value = candidate(id, "v1", vec![]);
    value.file.sha1 = Some(hex::encode(Sha1::digest(bytes)));
    value.file.size = Some(bytes.len() as u64);
    Selection {
        candidate: value,
        item: PlanItem {
            project_id: id.into(),
            version_id: "v1".into(),
            name: id.into(),
            version: "1.0".into(),
            kind: ResourceKind::Mod,
            status: "install".into(),
            path: format!("mods/{id}.jar"),
            main: true,
        },
        existing: None,
    }
}

#[test]
fn commit_installs_complete_group_and_preserves_existing_files() {
    let game = scratch();
    let stage = scratch();
    write_jar(game.path(), "mods/old.jar", &jar("old"));
    let expected = Inventory::read(game.path()).unwrap();
    let selections = ["main", "lib"].map(|id| {
        let bytes = jar(id);
        write_jar(stage.path(), &format!("mods/{id}.jar"), &bytes);
        selection(id, &bytes)
    });
    transaction::commit(
        &target(game.path()),
        &expected,
        &selections,
        None,
        stage.path(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(Inventory::read(game.path()).unwrap().files.len(), 3);
    assert!(game.path().join("mods/old.jar").exists());
    assert!(!stage.path().join("recovery.json").exists());
}

#[test]
fn hash_failure_cancellation_and_inventory_change_never_publish_partial_group() {
    let game = scratch();
    let stage = scratch();
    let bytes = jar("main");
    write_jar(stage.path(), "mods/main.jar", &bytes);
    let selection = selection("main", &bytes);
    let expected = Inventory::read(game.path()).unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(transaction::commit(
        &target(game.path()),
        &expected,
        &[selection.clone()],
        None,
        stage.path(),
        &cancel
    )
    .is_err());
    let mut invalid = selection.clone();
    invalid.candidate.file.sha1 = Some("f".repeat(40));
    assert!(transaction::commit(
        &target(game.path()),
        &expected,
        &[invalid],
        None,
        stage.path(),
        &CancellationToken::new()
    )
    .is_err());
    assert!(!game.path().join("mods/main.jar").exists());
    write_jar(game.path(), "mods/new-user-mod.jar", &jar("user"));
    assert!(transaction::commit(
        &target(game.path()),
        &expected,
        &[selection],
        None,
        stage.path(),
        &CancellationToken::new()
    )
    .is_err());
    assert!(!game.path().join("mods/main.jar").exists());
}

#[test]
fn commit_detects_same_mod_under_different_filename_and_enables_without_copy() {
    let game = scratch();
    let stage = scratch();
    let bytes = jar("lib");
    write_jar(game.path(), "mods/.disabled/renamed.jar", &bytes);
    let expected = Inventory::read(game.path()).unwrap();
    let existing = expected.files[0].clone();
    let mut selected = selection("lib", &bytes);
    selected.item.status = "disabled".into();
    selected.item.path = existing.path.clone();
    selected.existing = Some(existing);
    transaction::commit(
        &target(game.path()),
        &expected,
        &[selected],
        None,
        stage.path(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert!(game.path().join("mods/renamed.jar").exists());
    assert!(!game.path().join("mods/.disabled/renamed.jar").exists());
    write_jar(stage.path(), "mods/lib.jar", &bytes);
    let expected = Inventory::read(game.path()).unwrap();
    assert!(transaction::commit(
        &target(game.path()),
        &expected,
        &[selection("lib", &bytes)],
        None,
        stage.path(),
        &CancellationToken::new()
    )
    .is_err());
    assert!(!game.path().join("mods/lib.jar").exists());
}

#[test]
fn directory_lock_prevents_concurrent_install_and_launch() {
    let game = scratch();
    let first = transaction::lock(game.path()).unwrap();
    assert!(transaction::lock(game.path()).is_err());
    assert!(launch_guard(game.path()).is_err());
    drop(first);
    assert!(launch_guard(game.path()).is_ok());
}

#[test]
fn ended_failed_launch_does_not_block_installation_but_running_shared_game_does() {
    let game = scratch();
    let root = crate::paths::minecraft_root(game.path());
    let jobs = Jobs::default();
    let job = jobs.create(JobKind::Launch, "test".into(), &["launch"]);
    job.set_launch_context(crate::jobs::LaunchContext {
        version_id: "other".into(),
        game_version: "1.20.1".into(),
        directory: game.path().to_string_lossy().into_owned(),
        player_name: "test".into(),
        offline_lan: false,
        running: true,
    });
    assert!(launch_uses_game(&job.snapshot(), &root));
    assert!(!launch_uses_game(
        &job.snapshot(),
        &root.join("versions/isolated")
    ));
    job.set_launch_running(false);
    job.finish(&Err(anyhow::anyhow!("startup failed")));
    assert!(!launch_uses_game(&job.snapshot(), &root));
}

#[cfg(windows)]
#[test]
fn occupied_source_rolls_back_previously_published_files() {
    use std::os::windows::fs::OpenOptionsExt;
    let game = scratch();
    let stage = scratch();
    let first = jar("first");
    let second = jar("second");
    write_jar(stage.path(), "mods/first.jar", &first);
    write_jar(stage.path(), "mods/second.jar", &second);
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(stage.path().join("mods/second.jar"))
        .unwrap();
    let result = transaction::commit(
        &target(game.path()),
        &Inventory::read(game.path()).unwrap(),
        &[selection("first", &first), selection("second", &second)],
        None,
        stage.path(),
        &CancellationToken::new(),
    );
    assert!(result.is_err());
    assert!(!game.path().join("mods/first.jar").exists());
    assert!(!game.path().join("mods/second.jar").exists());
    assert!(stage.path().join("mods/first.jar").exists());
    drop(held);
}

#[tokio::test]
async fn failed_file_batch_retries_the_same_install_without_publishing_early() {
    failed_batch(false).await;
}

#[tokio::test]
async fn failed_update_download_then_cancel_keeps_the_original_disabled_jar() {
    failed_batch(true).await;
}

async fn failed_batch(update: bool) {
    use axum::{http::StatusCode, response::IntoResponse, routing::get, Router};
    use std::sync::atomic::{AtomicBool, Ordering};
    let game = scratch();
    let data = scratch();
    fs::create_dir_all(game.path().join("versions/test")).unwrap();
    fs::write(game.path().join("versions/test/test.json"), serde_json::to_vec(&json!({"id":"test", "clientVersion":"1.20.1", "libraries":[{"name":"net.fabricmc:fabric-loader:0.16.9"}]})).unwrap()).unwrap();
    let settings = Arc::new(crate::config::ConfigStore::open(data.path()).unwrap());
    let target = Target::resolve(game.path().into(), "test", &settings.get()).unwrap();
    let original = jar("main");
    let old_path = target.game.join("mods/.disabled/original.jar");
    if update {
        write_jar(&target.game, "mods/.disabled/original.jar", &original);
    }
    let main = mod_jar("main", "2.0");
    let lib = jar("lib");
    let failing = Arc::new(AtomicBool::new(true));
    let router = Router::new()
        .route(
            "/main",
            get({
                let bytes = main.clone();
                move || {
                    let bytes = bytes.clone();
                    async move { bytes }
                }
            }),
        )
        .route(
            "/lib",
            get({
                let bytes = lib.clone();
                let flag = failing.clone();
                move || {
                    let bytes = bytes.clone();
                    let flag = flag.clone();
                    async move {
                        if flag.load(Ordering::SeqCst) {
                            (StatusCode::SERVICE_UNAVAILABLE, Vec::new()).into_response()
                        } else {
                            bytes.into_response()
                        }
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut main_selection = selection("main", &main);
    main_selection.candidate.file.url = format!("http://{address}/main");
    let mut lib_selection = selection("lib", &lib);
    lib_selection.item.main = false;
    lib_selection.candidate.file.url = format!("http://{address}/lib");
    let installer = ModInstaller::default();
    let inventory = Inventory::read(&target.game).unwrap();
    let replacing = inventory.files.first().cloned();
    installer.prepared.lock().unwrap().insert(
        "token".into(),
        Prepared {
            target: target.clone(),
            inventory,
            selections: vec![main_selection, lib_selection],
            replacing,
            created: Instant::now(),
        },
    );
    let downloads = DownloadManager::open(&data.path().join("downloads"), 2).unwrap();
    let jobs = Arc::new(Jobs::default());
    let id = installer
        .start(
            "token",
            target.clone(),
            vec![],
            downloads.clone(),
            jobs.clone(),
            settings,
            Arc::new(|url| Box::pin(async move { Ok(url) })),
        )
        .await
        .unwrap();
    let batch = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Some(batch) = downloads
                .snapshots()
                .await
                .into_iter()
                .find(|batch| batch.status == Status::Failed)
            {
                break batch;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    assert!(!target.game.join("mods/main.jar").exists());
    assert!(!target.game.join("mods/lib.jar").exists());
    assert_eq!(
        jobs.get(&id).unwrap().snapshot().download_id.as_deref(),
        Some(batch.id.as_str())
    );
    if update {
        assert_eq!(fs::read(&old_path).unwrap(), original);
        jobs.cancel(&id).unwrap();
    } else {
        failing.store(false, Ordering::SeqCst);
        downloads.resume(&batch.id).await.unwrap();
    }
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let status = jobs.get(&id).unwrap().snapshot().status;
            if matches!(
                status,
                Status::Completed | Status::Failed | Status::Cancelled
            ) && jobs.get(&id).unwrap().snapshot().download_id.is_none()
            {
                assert_eq!(
                    status,
                    if update {
                        Status::Cancelled
                    } else {
                        Status::Completed
                    },
                    "{:?}",
                    jobs.get(&id).unwrap().snapshot().error
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    if update {
        let inventory = Inventory::read(&target.game).unwrap();
        assert_eq!(inventory.files.len(), 1);
        assert!(inventory.files[0].disabled);
        assert_eq!(fs::read(&old_path).unwrap(), original);
    } else {
        assert_eq!(Inventory::read(&target.game).unwrap().files.len(), 2);
    }
    assert!(downloads.snapshots().await.is_empty());
    server.abort();
    let _ = server.await;
}
