use super::*;
use crate::{
    downloads::{DownloadSpec, Status},
    jobs::{Job, JobKind},
    resources::install::Candidate,
};
use std::io::Read;

fn scratch() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp/modpack-export-tests");
    std::fs::create_dir_all(&root).unwrap();
    let root = std::fs::canonicalize(root).unwrap();
    #[cfg(windows)]
    let root = PathBuf::from(root.to_string_lossy().trim_start_matches(r"\\?\"));
    tempfile::Builder::new()
        .prefix("case-")
        .tempdir_in(root)
        .unwrap()
}
fn put(root: &Path, path: &str, bytes: &[u8]) {
    atomic_write(&root.join(path), bytes).unwrap();
}
fn target(root: &Path) -> ExportTarget {
    let root = root.join("game");
    put(&root, "versions/Pack/Pack.json", br#"{"id":"Pack","clientVersion":"1.20.1","mainClass":"net.minecraft.client.main.Main","libraries":[]}"#);
    ExportTarget::resolve(root, "Pack", &crate::config::Settings::default()).unwrap()
}
fn options() -> ExportOptions {
    ExportOptions {
        name: "中文整合包".into(),
        version: "1.2.3".into(),
        author: "作者".into(),
        summary: "说明\n第二行".into(),
    }
}
fn prepared(target: &ExportTarget, format: ExportFormat, consent: bool) -> PreparedPlan {
    let (files, _) = scan(target).unwrap();
    let files = files
        .iter()
        .filter(|f| f.selected)
        .map(|f| digest(target, f, &CancellationToken::new()).unwrap())
        .collect::<Vec<_>>();
    let paths = files
        .iter()
        .map(|f| f.file.path.clone())
        .collect::<Vec<_>>();
    let draft = ExportDraft {
        format,
        options: options(),
        paths: paths.clone(),
        direct_paths: if consent { paths } else { vec![] },
        downloads: vec![],
    };
    let (manifest, _, issues, direct) =
        writer::manifest(target, &files, &draft, &HashMap::new()).unwrap();
    assert!(issues.is_empty(), "{issues:?}");
    PreparedPlan {
        inspection: "scan".into(),
        target: target.clone(),
        files,
        direct,
        manifest,
        draft,
        cancel: CancellationToken::new(),
        created: Instant::now(),
    }
}
fn job() -> Arc<Job> {
    Jobs::default().create(
        JobKind::Other,
        "导出整合包".into(),
        &["校验源文件", "生成整合包", "校验导出文件", "保存整合包"],
    )
}
fn candidate(file: &HashedFile, path: &str, project: &str, id: &str) -> Candidate {
    Candidate {
        id: id.into(),
        project: project.into(),
        name: "Test".into(),
        version: "1.0".into(),
        date: "".into(),
        stable: true,
        changelog: String::new(),
        primary: true,
        client_supported: true,
        game_versions: vec!["1.20.1".into()],
        loaders: vec!["fabric".into()],
        required: vec![],
        incompatible: vec![],
        file: DownloadSpec {
            path: path.into(),
            url: "https://cdn.modrinth.com/data/project/versions/version/mod.jar".into(),
            size: Some(file.file.size),
            sha1: Some(file.sha1.clone()),
            sha512: Some(file.sha512.clone()),
        },
    }
}
fn community(root: &Path) -> Community {
    Community::new(Arc::new(
        crate::vault::Vault::open_with_service_directory(
            &root.join("vault"),
            root.join("services"),
        )
        .unwrap(),
    ))
    .unwrap()
}

#[test]
fn resolves_inheritance_and_exact_loader_versions() {
    let temp = scratch();
    let root = temp.path();
    put(
        root,
        "versions/1.20.1/1.20.1.json",
        br#"{"id":"1.20.1","libraries":[]}"#,
    );
    put(root, "versions/Base/Base.json", br#"{"id":"Base","inheritsFrom":"1.20.1","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.0"}]}"#);
    put(root, "versions/Pack/Pack.json", br#"{"id":"Pack","inheritsFrom":"Base","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.14"}]}"#);
    let mut settings = crate::config::Settings::default();
    settings.isolation = false;
    let target = ExportTarget::resolve(root.into(), "Pack", &settings).unwrap();
    assert_eq!(target.minecraft, "1.20.1");
    assert_eq!(
        target.loader.unwrap(),
        ExportLoader {
            kind: "Fabric".into(),
            version: "0.16.14".into()
        }
    );
    assert!(target.shared);
    put(
        root,
        "versions/Pack/Pack.json",
        br#"{
            "id":"Pack",
            "inheritsFrom":"1.20.1",
            "libraries":[
                {"name":"net.minecraftforge:forge:1.20.1-47.4.0"},
                {"name":"net.minecraftforge:fmlloader:1.20.1-47.3.10"}
            ]
        }"#,
    );
    assert_eq!(
        ExportTarget::resolve(root.into(), "Pack", &settings)
            .unwrap()
            .loader
            .unwrap()
            .version,
        "47.4.0"
    );
}

#[test]
fn scans_fmlloader_only_forge_profile_and_writes_exact_manifests() {
    let temp = scratch();
    let root = temp.path();
    put(
        root,
        "versions/Create-New-Horizon/Create-New-Horizon.json",
        br#"{
            "id":"Create-New-Horizon",
            "clientVersion":"1.20.1",
            "mainClass":"cpw.mods.bootstraplauncher.BootstrapLauncher",
            "libraries":[
                {"name":"cpw.mods:bootstraplauncher:1.1.2"},
                {"name":"net.minecraftforge:fmlloader:1.20.1-47.3.10"}
            ]
        }"#,
    );
    let target = ExportTarget::resolve(
        root.into(),
        "Create-New-Horizon",
        &crate::config::Settings::default(),
    )
    .unwrap();
    put(&target.game, "config/pack.toml", b"enabled = true");
    let inspection = ModpackExporter::default().inspect(target.clone()).unwrap();
    assert_eq!(inspection.minecraft, "1.20.1");
    assert_eq!(
        inspection.loader.unwrap(),
        ExportLoader {
            kind: "Forge".into(),
            version: "47.3.10".into(),
        }
    );
    assert!(inspection
        .files
        .iter()
        .any(|f| f.path == "config/pack.toml"));

    let modrinth = prepared(&target, ExportFormat::Modrinth, false).manifest;
    assert_eq!(modrinth["dependencies"]["forge"], "47.3.10");
    let curseforge = prepared(&target, ExportFormat::Curseforge, false).manifest;
    assert_eq!(
        curseforge["minecraft"]["modLoaders"],
        json!([{"id":"forge-47.3.10","primary":true}])
    );
}

#[test]
fn scans_neoforge_from_profile_metadata_and_writes_exact_manifests() {
    let temp = scratch();
    let root = temp.path();
    let settings = crate::config::Settings::default();
    for (mut profile, version) in [
        (
            json!({
                "clientVersion": "1.21.1",
                "arguments": {"game": ["--fml.neoForgeVersion", "21.1.230"]},
                "libraries": [{"name": "net.neoforged.fancymodloader:loader:4.0.42"}],
            }),
            "21.1.230",
        ),
        (
            json!({
                "patches": [
                    {"id": "game", "version": "1.21.1"},
                    {"id": "neoforge", "version": "21.1.213"},
                ],
                "libraries": [{"name": "net.neoforged.fancymodloader:loader:4.0.42"}],
            }),
            "21.1.213",
        ),
        (
            json!({
                "clientVersion": "1.21.1",
                "arguments": {"game": ["--fml.neoForgeVersion", "21.1.230"]},
                "libraries": [{"name": "net.neoforged:neoforge:21.1.240"}],
            }),
            "21.1.240",
        ),
    ] {
        profile["id"] = json!("Pack");
        profile["mainClass"] = json!("cpw.mods.bootstraplauncher.BootstrapLauncher");
        put(
            root,
            "versions/Pack/Pack.json",
            &serde_json::to_vec(&profile).unwrap(),
        );
        let target = ExportTarget::resolve(root.into(), "Pack", &settings).unwrap();
        let inspection = ModpackExporter::default().inspect(target.clone()).unwrap();
        assert_eq!(inspection.minecraft, "1.21.1");
        assert_eq!(
            inspection.loader.unwrap(),
            ExportLoader {
                kind: "NeoForge".into(),
                version: version.into(),
            }
        );

        let modrinth = prepared(&target, ExportFormat::Modrinth, false).manifest;
        assert_eq!(modrinth["dependencies"]["neoforge"], version);
        let curseforge = prepared(&target, ExportFormat::Curseforge, false).manifest;
        assert_eq!(
            curseforge["minecraft"]["modLoaders"],
            json!([{"id": format!("neoforge-{version}"), "primary": true}])
        );
    }
}

#[test]
fn rejects_unsupported_and_mixed_loaders() {
    let temp = scratch();
    let root = temp.path();
    for libraries in [
        json!([{"name":"optifine:OptiFine:1.20.1"}]),
        json!([{"name":"net.fabricmc:fabric-loader:0.16.14"},{"name":"net.minecraftforge:forge:1.20.1-47.4.0"}]),
    ] {
        put(
            root,
            "versions/Pack/Pack.json",
            &serde_json::to_vec(
                &json!({"id":"Pack","clientVersion":"1.20.1","libraries":libraries}),
            )
            .unwrap(),
        );
        assert!(
            ExportTarget::resolve(root.into(), "Pack", &crate::config::Settings::default())
                .is_err()
        );
    }
}

#[test]
fn scan_excludes_private_runtime_and_temporary_files_and_keeps_optional_choices() {
    let temp = scratch();
    let target = target(temp.path());
    for path in [
        "mods/enabled.jar",
        "mods/off.jar.disabled",
        "config/game.json",
        "defaultconfigs/a.toml",
        "kubejs/server_scripts/a.js",
        "resourcepacks/pack.zip",
        "shaderpacks/shader.zip",
        "saves/世界/level.dat",
        "screenshots/截图.png",
        "options.txt",
        "servers.dat",
        "logs/latest.log",
        ".tmcl/config.json",
        "launcher_accounts.json",
        "config/access_token.json",
        "config/a.tmp",
        "Pack.json",
        "Pack.jar",
        "assets/indexes/a.json",
    ] {
        put(&target.game, path, b"content");
    }
    let (files, warnings) = scan(&target).unwrap();
    assert!(files
        .iter()
        .any(|f| f.path == "mods/enabled.jar" && f.selected));
    assert!(files
        .iter()
        .any(|f| f.path == "mods/off.jar.disabled" && !f.selected));
    for file in &files {
        assert!(!snapshot::excluded(&file.path));
        assert!(file.path != "Pack.json" && file.path != "Pack.jar");
    }
    for path in [
        "resourcepacks/pack.zip",
        "saves/世界/level.dat",
        "screenshots/截图.png",
        "options.txt",
        "servers.dat",
    ] {
        assert!(files.iter().any(|f| f.path == path && !f.selected));
    }
    assert!(!warnings.is_empty());
}

#[test]
fn both_formats_round_trip_through_existing_importer_with_exact_contents() {
    let temp = scratch();
    let target = target(temp.path());
    put(&target.game, "config/中文.json", br#"{"enabled":true}"#);
    put(
        &target.game,
        "kubejs/server_scripts/main.js",
        b"ServerEvents.recipes(event => {});",
    );
    put(&target.game, "mods/custom.jar", b"custom mod content");
    for format in [ExportFormat::Modrinth, ExportFormat::Curseforge] {
        let plan = prepared(&target, format, true);
        let output = temp.path().join(format!("整合包.{}", format.extension()));
        writer::write(&plan, &output, &job(), false).unwrap();
        let inspection = super::super::Modpacks::default().inspect(&output).unwrap();
        assert_eq!(inspection.info.name, "中文整合包");
        assert_eq!(inspection.info.minecraft, "1.20.1");
        assert_eq!(inspection.info.version, "1.2.3");
        let extracted = temp.path().join(format!("extract-{}", format.extension()));
        super::super::archive::extract(&output, &extracted, &CancellationToken::new()).unwrap();
        let parsed = super::super::parser::parse(&extracted, &CancellationToken::new()).unwrap();
        assert_eq!(parsed.contents.len(), 1);
        for file in &plan.files {
            assert_eq!(
                std::fs::read(parsed.contents[0].join(&file.file.path)).unwrap(),
                std::fs::read(target.game.join(&file.file.path)).unwrap()
            );
        }
        assert!(!extracted.join("overrides/Pack.json").exists());
        assert!(std::fs::read_to_string(extracted.join("README.md"))
            .unwrap()
            .contains("作者"));
    }
}

#[test]
fn mrpack_records_exact_hashes_size_path_and_loader() {
    let temp = scratch();
    let mut target = target(temp.path());
    target.loader = Some(ExportLoader {
        kind: "Fabric".into(),
        version: "0.16.14".into(),
    });
    put(&target.game, "mods/renamed.jar", b"mod content");
    let files = scan(&target)
        .unwrap()
        .0
        .iter()
        .filter(|f| f.selected)
        .map(|f| digest(&target, f, &CancellationToken::new()).unwrap())
        .collect::<Vec<_>>();
    let draft = ExportDraft {
        format: ExportFormat::Modrinth,
        options: options(),
        paths: vec![files[0].file.path.clone()],
        direct_paths: vec![],
        downloads: vec![],
    };
    let matches = HashMap::from([(
        files[0].file.path.clone(),
        candidate(&files[0], "original.jar", "project", "exact-version"),
    )]);
    let (manifest, items, issues, direct) =
        writer::manifest(&target, &files, &draft, &matches).unwrap();
    assert!(issues.is_empty());
    assert!(direct.is_empty());
    assert_eq!(items[0].method, "reference");
    assert_eq!(manifest["files"][0]["path"], "mods/renamed.jar");
    assert_eq!(manifest["files"][0]["hashes"]["sha1"], files[0].sha1);
    assert_eq!(manifest["files"][0]["hashes"]["sha512"], files[0].sha512);
    assert_eq!(manifest["files"][0]["fileSize"], files[0].file.size);
    assert_eq!(manifest["dependencies"]["fabric-loader"], "0.16.14");
}

#[test]
fn curseforge_references_exact_ids_and_requires_consent_for_renames_and_duplicates() {
    let temp = scratch();
    let target = target(temp.path());
    put(&target.game, "mods/a.jar", b"same mod");
    put(&target.game, "mods/renamed.jar", b"same mod");
    let files = scan(&target)
        .unwrap()
        .0
        .iter()
        .filter(|f| f.selected)
        .map(|f| digest(&target, f, &CancellationToken::new()).unwrap())
        .collect::<Vec<_>>();
    let draft = ExportDraft {
        format: ExportFormat::Curseforge,
        options: options(),
        paths: files.iter().map(|f| f.file.path.clone()).collect(),
        direct_paths: vec![],
        downloads: vec![],
    };
    let matches = files
        .iter()
        .map(|f| (f.file.path.clone(), candidate(f, "mods/a.jar", "42", "99")))
        .collect();
    let (manifest, _, issues, _) = writer::manifest(&target, &files, &draft, &matches).unwrap();
    assert_eq!(
        manifest["files"][0],
        json!({"projectID":42,"fileID":99,"required":true})
    );
    assert_eq!(issues.len(), 1);
    let mut consent = draft.clone();
    consent.direct_paths = vec!["mods/renamed.jar".into()];
    let (_, _, issues, direct) = writer::manifest(&target, &files, &consent, &matches).unwrap();
    assert!(issues.is_empty());
    assert!(direct.contains("mods/renamed.jar"));
}

#[test]
fn modified_resource_is_never_replaced_by_cached_platform_original() {
    let temp = scratch();
    let target = target(temp.path());
    put(&target.game, "mods/a.jar", b"changed mod");
    let file = digest(
        &target,
        &scan(&target).unwrap().0[0],
        &CancellationToken::new(),
    )
    .unwrap();
    let mut remote = candidate(&file, "a.jar", "project", "version");
    remote.file.sha1 = Some("a".repeat(40));
    let draft = ExportDraft {
        format: ExportFormat::Modrinth,
        options: options(),
        paths: vec![file.file.path.clone()],
        direct_paths: vec![],
        downloads: vec![],
    };
    let (manifest, items, issues, _) = writer::manifest(
        &target,
        &[file.clone()],
        &draft,
        &HashMap::from([(file.file.path.clone(), remote)]),
    )
    .unwrap();
    assert!(manifest["files"].as_array().unwrap().is_empty());
    assert_eq!(items[0].method, "unresolved");
    assert_eq!(issues.len(), 1);
}

#[test]
fn custom_https_reference_uses_local_hash_and_rejects_credentials() {
    let temp = scratch();
    let target = target(temp.path());
    put(&target.game, "mods/custom.jar", b"custom");
    let file = digest(
        &target,
        &scan(&target).unwrap().0[0],
        &CancellationToken::new(),
    )
    .unwrap();
    let mut draft = ExportDraft {
        format: ExportFormat::Modrinth,
        options: options(),
        paths: vec![file.file.path.clone()],
        direct_paths: vec![],
        downloads: vec![ExportDownload {
            path: file.file.path.clone(),
            url: "https://github.com/test/mod/releases/download/1/mod.jar".into(),
        }],
    };
    assert!(
        writer::manifest(&target, &[file.clone()], &draft, &HashMap::new())
            .unwrap()
            .2
            .is_empty()
    );
    for url in [
        "http://example.com/a.jar",
        "https://user:secret@example.com/a.jar",
        "https://example.com/a.jar?token=secret",
        "file:///tmp/a.jar",
    ] {
        draft.downloads[0].url = url.into();
        assert!(writer::manifest(&target, &[file.clone()], &draft, &HashMap::new()).is_err());
    }
}

#[test]
fn cancellation_and_changed_source_preserve_existing_output_and_leave_no_temporary_archive() {
    let temp = scratch();
    let target = target(temp.path());
    put(&target.game, "config/a.txt", b"old");
    let plan = prepared(&target, ExportFormat::Modrinth, false);
    let output = temp.path().join("existing.mrpack");
    put(temp.path(), "existing.mrpack", b"existing output");
    let cancelled = job();
    cancelled.cancel.cancel();
    assert!(writer::write(&plan, &output, &cancelled, true).is_err());
    put(&target.game, "config/a.txt", b"new");
    assert!(writer::write(&plan, &output, &job(), true).is_err());
    assert_eq!(std::fs::read(output).unwrap(), b"existing output");
    assert!(!std::fs::read_dir(temp.path()).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".sfmcl-export-")));
}

#[test]
fn no_clobber_and_wrong_destination_are_rejected() {
    let temp = scratch();
    let target = target(temp.path());
    put(&target.game, "config/a.txt", b"configuration");
    let plan = prepared(&target, ExportFormat::Modrinth, false);
    let output = temp.path().join("pack.mrpack");
    writer::write(&plan, &output, &job(), false).unwrap();
    let original = std::fs::read(&output).unwrap();
    assert!(writer::write(&plan, &output, &job(), false).is_err());
    assert_eq!(std::fs::read(output).unwrap(), original);
    assert!(writer::destination(&target.game.join("pack.mrpack"), &plan, false).is_err());
    assert!(writer::destination(&temp.path().join("pack.zip"), &plan, false).is_err());
}

#[tokio::test]
async fn manager_saves_draft_binds_preview_and_completes_background_job() {
    let temp = scratch();
    let target = target(temp.path());
    put(&target.game, "config/a.txt", b"configuration");
    let exporter = Arc::new(ModpackExporter::default());
    let inspection = exporter.inspect(target.clone()).unwrap();
    let draft = ExportDraft {
        format: ExportFormat::Curseforge,
        options: options(),
        paths: inspection
            .files
            .iter()
            .filter(|f| f.selected)
            .map(|f| f.path.clone())
            .collect(),
        direct_paths: vec![],
        downloads: vec![],
    };
    exporter.save_draft(&target, &draft).unwrap();
    assert!(exporter.inspect(target.clone()).unwrap().draft.is_some());
    let plan = exporter
        .plan(
            ExportPlanRequest {
                inspection_token: inspection.token.clone(),
                draft: draft.clone(),
            },
            target.clone(),
            &community(temp.path()),
        )
        .await
        .unwrap();
    assert!(plan.issues.is_empty());
    let jobs = Arc::new(Jobs::default());
    let output = temp.path().join("pack.zip");
    let id = exporter
        .start(
            plan.token.as_ref().unwrap(),
            target.clone(),
            output.clone(),
            jobs.clone(),
            false,
        )
        .unwrap();
    exporter.discard(&inspection.token);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let state = jobs.get(&id).unwrap().snapshot();
            if state.status.terminal() {
                assert_eq!(state.status, Status::Completed, "{:?}", state.error);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(exporter.completed_path(&id).unwrap(), output);
    let mut zip =
        zip::ZipArchive::new(std::fs::File::open(exporter.completed_path(&id).unwrap()).unwrap())
            .unwrap();
    let mut bytes = vec![];
    zip.by_name("overrides/config/a.txt")
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, b"configuration");
    let fresh = exporter.inspect(target.clone()).unwrap();
    let mut changed = target.clone();
    changed.environment = "changed".into();
    assert!(exporter
        .plan(
            ExportPlanRequest {
                inspection_token: fresh.token.clone(),
                draft: draft.clone()
            },
            changed,
            &community(temp.path())
        )
        .await
        .is_err());
    exporter.discard(&fresh.token);
    assert!(exporter
        .plan(
            ExportPlanRequest {
                inspection_token: fresh.token,
                draft
            },
            target,
            &community(temp.path())
        )
        .await
        .is_err());
}

#[test]
fn rejects_extra_formats_paths_and_unsupported_curseforge_loader() {
    assert!(serde_json::from_str::<ExportFormat>("\"mcbbs\"").is_err());
    let temp = scratch();
    let mut target = target(temp.path());
    target.loader = Some(ExportLoader {
        kind: "Quilt".into(),
        version: "0.27.1".into(),
    });
    let draft = ExportDraft {
        format: ExportFormat::Curseforge,
        options: options(),
        paths: vec![],
        direct_paths: vec![],
        downloads: vec![],
    };
    assert!(!writer::manifest(&target, &[], &draft, &HashMap::new())
        .unwrap()
        .2
        .is_empty());
    let mut unsafe_draft = draft;
    unsafe_draft.paths = vec!["../secret".into()];
    assert!(ModpackExporter::default()
        .save_draft(&target, &unsafe_draft)
        .is_err());
}

#[tokio::test]
async fn manifest_references_and_embedded_mods_export_without_missing_dependency_warnings() {
    let temp = scratch();
    let target = target(temp.path());
    put(&target.game, "mods/a.jar", b"platform content");
    put(&target.game, "mods/library.jar", b"referenced library");
    put(&target.game, "mods/embedded.jar", b"embedded library");
    for format in [ExportFormat::Modrinth, ExportFormat::Curseforge] {
        let exporter = ModpackExporter::default();
        let inspection = exporter.inspect(target.clone()).unwrap();
        let files = inspection
            .files
            .iter()
            .map(|file| digest(&target, file, &CancellationToken::new()).unwrap())
            .collect::<Vec<_>>();
        let main = files
            .iter()
            .find(|file| file.file.path == "mods/a.jar")
            .unwrap();
        let library = files
            .iter()
            .find(|file| file.file.path == "mods/library.jar")
            .unwrap();
        let (source, main_project, main_id, library_project, library_id) = match format {
            ExportFormat::Modrinth => (
                "modrinth",
                "project",
                "exact-file",
                "library",
                "library-file",
            ),
            ExportFormat::Curseforge => ("curseforge", "42", "99", "43", "100"),
        };
        let mut matched = candidate(main, "mods/a.jar", main_project, main_id);
        for project in [library_project, "embedded-library", "nested-library"] {
            matched
                .required
                .push(crate::resources::install::Dependency {
                    project: Some(project.into()),
                    version: None,
                    filename: None,
                });
        }
        let state = exporter
            .inspections
            .lock()
            .unwrap()
            .get(&inspection.token)
            .cloned()
            .unwrap();
        state.matches.lock().unwrap().insert(
            source.into(),
            HashMap::from([
                ("mods/a.jar".into(), matched),
                (
                    "mods/library.jar".into(),
                    candidate(library, "mods/library.jar", library_project, library_id),
                ),
            ]),
        );
        let draft = ExportDraft {
            format,
            options: options(),
            paths: inspection
                .files
                .iter()
                .map(|file| file.path.clone())
                .collect(),
            direct_paths: vec!["mods/embedded.jar".into()],
            downloads: vec![],
        };
        let plan = exporter
            .plan(
                ExportPlanRequest {
                    inspection_token: inspection.token.clone(),
                    draft,
                },
                target.clone(),
                &community(temp.path()),
            )
            .await
            .unwrap();
        assert!(plan.issues.is_empty());
        assert_eq!(plan.warnings, inspection.warnings);
        assert_eq!(
            plan.items
                .iter()
                .filter(|item| item.method == "reference")
                .count(),
            2
        );
        assert_eq!(
            plan.items
                .iter()
                .filter(|item| item.method == "embedded")
                .count(),
            1
        );
        assert_eq!(plan.manifest["files"].as_array().unwrap().len(), 2);
        match format {
            ExportFormat::Modrinth => {
                for file in [main, library] {
                    let entry = plan.manifest["files"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|entry| entry["path"] == file.file.path)
                        .unwrap();
                    assert_eq!(entry["hashes"]["sha1"], file.sha1);
                    assert_eq!(entry["hashes"]["sha512"], file.sha512);
                    assert_eq!(entry["fileSize"], file.file.size);
                    assert_eq!(entry["downloads"].as_array().unwrap().len(), 1);
                }
            }
            ExportFormat::Curseforge => {
                let entries = plan.manifest["files"].as_array().unwrap();
                assert!(entries.contains(&json!({"projectID":42,"fileID":99,"required":true})));
                assert!(entries.contains(&json!({"projectID":43,"fileID":100,"required":true})));
            }
        }
        let prepared = exporter
            .plans
            .lock()
            .unwrap()
            .get(plan.token.as_ref().unwrap())
            .cloned()
            .unwrap();
        let output = temp
            .path()
            .join(format!("references.{}", format.extension()));
        writer::write(&prepared, &output, &job(), false).unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(output).unwrap()).unwrap();
        let manifest_name = match format {
            ExportFormat::Modrinth => "modrinth.index.json",
            ExportFormat::Curseforge => "manifest.json",
        };
        let manifest: Value =
            serde_json::from_reader(archive.by_name(manifest_name).unwrap()).unwrap();
        assert_eq!(manifest, plan.manifest);
        assert!(archive.by_name("overrides/mods/a.jar").is_err());
        assert!(archive.by_name("overrides/mods/library.jar").is_err());
        let mut bytes = Vec::new();
        archive
            .by_name("overrides/mods/embedded.jar")
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, b"embedded library");
    }
}

#[test]
fn source_content_changes_with_same_size_and_mtime_are_detected_by_hash() {
    let temp = scratch();
    let target = target(temp.path());
    put(&target.game, "config/a.txt", b"old");
    let plan = prepared(&target, ExportFormat::Modrinth, false);
    let path = target.game.join("config/a.txt");
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, b"new").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert!(snapshot::validate_files(&target, &plan.files, &CancellationToken::new()).is_err());
}

#[cfg(windows)]
#[test]
fn scan_skips_junctions_and_never_exports_files_outside_game() {
    let temp = scratch();
    let target = target(temp.path());
    let outside = temp.path().join("outside");
    put(&outside, "private.txt", b"secret");
    let link = target.game.join("linked");
    let result = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&outside)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout: {} stderr: {}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let files = scan(&target).unwrap().0;
    assert!(!files.iter().any(|f| f.path.contains("private")));
    std::fs::remove_dir(link).unwrap();
}

#[tokio::test]
async fn platform_lookup_matches_exact_file_and_batches_curseforge_destination_metadata() {
    use axum::{routing::post, Json, Router};
    let temp = scratch();
    let target = target(temp.path());
    put(&target.game, "mods/a.jar", b"platform file contents");
    let hashed = digest(
        &target,
        &scan(&target).unwrap().0[0],
        &CancellationToken::new(),
    )
    .unwrap();
    let hash = hashed.sha1.clone();
    let sha512 = hashed.sha512.clone();
    let size = hashed.file.size;
    let cf_hash = hash.clone();
    let router = Router::new()
        .route("/mr", post(move |Json(body): Json<Value>| { let hash = hash.clone(); let sha512 = sha512.clone(); async move {
            assert_eq!(body["algorithm"], "sha1"); assert_eq!(body["hashes"][0], hash);
            Json(json!({hash.clone():{"id":"exact-file","project_id":"project","name":"Platform Mod","version_number":"1.0","version_type":"release","game_versions":["1.20.1"],"loaders":["fabric"],"dependencies":[],"files":[{"filename":"unrelated.jar","url":"https://cdn.modrinth.com/other.jar","hashes":{"sha1":"a".repeat(40)},"size":2,"primary":true},{"filename":"a.jar","url":"https://cdn.modrinth.com/data/project/versions/exact-file/a.jar","hashes":{"sha1":hash,"sha512":sha512},"size":size}]}}))
        }}))
        .route("/fingerprints", post(move |Json(body): Json<Value>| { let hash = cf_hash.clone(); async move {
            assert_eq!(body["fingerprints"].as_array().unwrap().len(), 1);
            Json(json!({"data":{"exactMatches":[{"file":{"id":99,"modId":42,"displayName":"Platform Mod","fileName":"a.jar","fileLength":size,"downloadUrl":"https://edge.forgecdn.net/files/99/a.jar","releaseType":1,"gameVersions":["1.20.1","Fabric"],"hashes":[{"algo":1,"value":hash}],"dependencies":[]}}]}}))
        }}))
        .route("/projects", post(|Json(body): Json<Value>| async move { assert_eq!(body["modIds"], json!([42])); Json(json!({"data":[{"id":42,"gameId":432,"classId":6}]})) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let sources = Arc::new(crate::download_sources::SourceSelector::default());
    for (url, endpoint) in [
        ("https://api.modrinth.com/v2/version_files", "mr"),
        (
            "https://api.curseforge.com/v1/fingerprints/432",
            "fingerprints",
        ),
        ("https://api.curseforge.com/v1/mods", "projects"),
    ] {
        let mut original = reqwest::Url::parse(url).unwrap();
        original
            .query_pairs_mut()
            .extend_pairs(std::iter::empty::<(&str, &str)>());
        sources.register(
            original.as_str(),
            vec![format!("http://{address}/{endpoint}")],
        );
    }
    let community = community(temp.path()).with_sources(sources);
    let exporter = ModpackExporter::default();
    let inspection = exporter.inspect(target.clone()).unwrap();
    for format in [ExportFormat::Modrinth, ExportFormat::Curseforge] {
        let draft = ExportDraft {
            format,
            options: options(),
            paths: vec!["mods/a.jar".into()],
            direct_paths: vec![],
            downloads: vec![],
        };
        let plan = exporter
            .plan(
                ExportPlanRequest {
                    inspection_token: inspection.token.clone(),
                    draft,
                },
                target.clone(),
                &community,
            )
            .await
            .unwrap();
        assert!(
            plan.issues.is_empty(),
            "{:?} {:?}",
            plan.issues,
            plan.warnings
        );
        assert_eq!(plan.items[0].method, "reference");
        if format == ExportFormat::Modrinth {
            assert_eq!(plan.manifest["files"][0]["hashes"]["sha1"], hashed.sha1);
            assert_eq!(
                plan.manifest["files"][0]["downloads"][0],
                "https://cdn.modrinth.com/data/project/versions/exact-file/a.jar"
            );
        } else {
            assert_eq!(plan.manifest["files"][0]["projectID"], 42);
            assert_eq!(plan.manifest["files"][0]["fileID"], 99);
        }
    }
    server.abort();
}

#[test]
fn confirmed_overwrite_commits_valid_archive_after_verification() {
    let temp = scratch();
    let target = target(temp.path());
    put(&target.game, "config/a.txt", b"configuration");
    let plan = prepared(&target, ExportFormat::Modrinth, false);
    let output = temp.path().join("pack.mrpack");
    std::fs::write(&output, b"previous archive").unwrap();
    writer::write(&plan, &output, &job(), true).unwrap();
    assert!(super::super::Modpacks::default().inspect(&output).is_ok());
}

#[tokio::test]
async fn cancellation_during_compression_removes_temporary_archive_and_preserves_target() {
    let temp = scratch();
    let target = target(temp.path());
    let mut seed = 0x12345678_u32;
    let data = (0..8 * 1024 * 1024)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as u8
        })
        .collect::<Vec<_>>();
    put(&target.game, "config/large.bin", &data);
    let plan = prepared(&target, ExportFormat::Modrinth, false);
    let output = temp.path().join("pack.mrpack");
    std::fs::write(&output, b"previous archive").unwrap();
    let export_job = job();
    let worker_job = export_job.clone();
    let worker_output = output.clone();
    let worker = tokio::task::spawn_blocking(move || {
        writer::write(&plan, &worker_output, &worker_job, true)
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if export_job.snapshot().current_step >= 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    export_job.cancel.cancel();
    assert!(worker.await.unwrap().is_err());
    assert_eq!(std::fs::read(output).unwrap(), b"previous archive");
    assert!(!std::fs::read_dir(temp.path()).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".sfmcl-export-")));
}
