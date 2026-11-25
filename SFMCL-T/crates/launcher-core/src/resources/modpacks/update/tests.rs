use super::*;
use sha1::{Digest, Sha1};
use std::io::Write;

fn scratch() -> tempfile::TempDir {
    let parent =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp/modpack-update-tests");
    std::fs::create_dir_all(&parent).unwrap();
    tempfile::Builder::new()
        .prefix("case-")
        .tempdir_in(parent)
        .unwrap()
}
fn put(root: &Path, path: &str, bytes: &[u8]) {
    atomic_write(&root.join(path), bytes).unwrap();
}
fn maps(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
    entries
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}
fn profile(root: &Path, id: &str, version: &str) {
    put(root,&format!("{id}.json"),&serde_json::to_vec(&json!({"id":id,"jar":id,"clientVersion":"1.20.1","libraries":[],"tmclModpack":{"name":"Test","version":version}})).unwrap());
    put(root, &format!("{id}.jar"), b"client");
}
fn record(root: &Path, id: &str, version: &str) {
    record_install(
        root,
        &ModpackRequest {
            root: root.into(),
            name: id.into(),
            token: None,
            file: None,
            include_optional: false,
            origin: None,
        },
        &PackInfo {
            format: "Modrinth".into(),
            name: "Test".into(),
            localized_name: None,
            version: version.into(),
            minecraft: "1.20.1".into(),
            loader: None,
            optional_files: vec![],
            file_count: 0,
        },
        &CancellationToken::new(),
        BTreeSet::new(),
    )
    .unwrap();
}
fn runtime(directory: &Path) -> Arc<Installer> {
    Arc::new(Installer {
        settings: Arc::new(crate::config::ConfigStore::open(&directory.join("data")).unwrap()),
        downloads: crate::downloads::DownloadManager::open(&directory.join("downloads"), 2)
            .unwrap(),
        jobs: Arc::new(crate::jobs::Jobs::default()),
        client: crate::http_client().unwrap(),
    })
}
fn zipped(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (path, bytes) in entries {
        archive
            .start_file(*path, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(bytes).unwrap();
    }
    archive.finish().unwrap().into_inner()
}
fn mod_jar(version: &str) -> Vec<u8> {
    zipped(&[(
        "fabric.mod.json",
        serde_json::to_vec(&json!({"id":"example","version":version,"name":"Example"})).unwrap(),
    )])
}
fn pack_archive(format: &str, version: &str, base: &str) -> Vec<u8> {
    let manifest = if format == "modrinth" {
        {
            let optional = zipped(&[(
                "fabric.mod.json",
                serde_json::to_vec(&json!({"id":"optional","version":version,"name":"Optional"}))
                    .unwrap(),
            )]);
            json!({"formatVersion":1,"game":"minecraft","name":"Test","versionId":version,"dependencies":{"minecraft":"1.20.1"},"files":[{"path":"mods/optional.jar","env":{"client":"optional","server":"unsupported"},"hashes":{"sha1":hex::encode(Sha1::digest(&optional))},"fileSize":optional.len(),"downloads":[format!("{base}/optional/{version}")]}]})
        }
    } else {
        json!({"manifestType":"minecraftModpack","manifestVersion":1,"name":"Test","version":version,"minecraft":{"version":"1.20.1","modLoaders":[]},"files":[],"overrides":"overrides"})
    };
    let mut entries = vec![
        (
            if format == "modrinth" {
                "modrinth.index.json"
            } else {
                "manifest.json"
            },
            serde_json::to_vec(&manifest).unwrap(),
        ),
        (
            "overrides/config/a",
            if version == "1" {
                b"old".to_vec()
            } else {
                b"new".to_vec()
            },
        ),
    ];
    if version == "1" {
        entries.push(("overrides/config/removed", b"old".to_vec()));
        entries.push(("overrides/mods/mod-1.jar", mod_jar("1")));
    } else {
        entries.push(("overrides/config/add", b"new".to_vec()));
        entries.push(("overrides/mods/mod-2.jar", mod_jar("2")));
    }
    zipped(&entries)
}
async fn finished(installer: &Installer, id: &str) -> crate::jobs::JobSnapshot {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let snapshot = installer.jobs.get(id).unwrap().snapshot();
            if snapshot.status.terminal() {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn both_platforms_validate_download_install_update_legacy_and_disabled_renames() {
    use axum::{routing::get, Json, Router};
    let temp = scratch();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let base = format!("http://{address}");
    let jar = b"fixture client".to_vec();
    let version = json!({"id":"1.20.1","mainClass":"net.minecraft.client.main.Main","type":"release","libraries":[],"arguments":{"game":[]},"downloads":{"client":{"url":format!("{base}/jar"),"sha1":hex::encode(Sha1::digest(&jar)),"size":jar.len()}}});
    let manifest = json!({"versions":[{"id":"1.20.1","type":"release","url":format!("{base}/version")}],"latest":{"release":"1.20.1"}});
    let mut router = Router::new()
        .route(
            "/manifest",
            get(move || {
                let v = manifest.clone();
                async move { Json(v) }
            }),
        )
        .route(
            "/version",
            get(move || {
                let v = version.clone();
                async move { Json(v) }
            }),
        )
        .route(
            "/jar",
            get(move || {
                let v = jar.clone();
                async move { v }
            }),
        );
    for version in ["1", "2"] {
        let bytes = zipped(&[(
            "fabric.mod.json",
            serde_json::to_vec(&json!({"id":"optional","version":version,"name":"Optional"}))
                .unwrap(),
        )]);
        router = router.route(
            &format!("/optional/{version}"),
            get(move || {
                let bytes = bytes.clone();
                async move { bytes }
            }),
        );
    }
    let ambiguous = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mr_ambiguous = ambiguous.clone();
    let cf_ambiguous = ambiguous.clone();
    router = router
        .route(
            "/mr/search",
            get(move || {
                let flag = mr_ambiguous.clone();
                async move {
                    let mut hits = vec![
                        json!({"project_id":"project","title":"Test","project_type":"modpack"}),
                    ];
                    if flag.load(std::sync::atomic::Ordering::Relaxed) {
                        hits.push(
                            json!({"project_id":"another","title":"Test","project_type":"modpack"}),
                        );
                    }
                    Json(json!({"total_hits":hits.len(),"hits":hits}))
                }
            }),
        )
        .route(
            "/cf/search",
            get(move || {
                let flag = cf_ambiguous.clone();
                async move {
                    let mut projects =
                        vec![json!({"id":42,"name":"Test","gameId":432,"classId":4471})];
                    if flag.load(std::sync::atomic::Ordering::Relaxed) {
                        projects.push(json!({"id":43,"name":"Test","gameId":432,"classId":4471}));
                    }
                    Json(json!({"data":projects,"pagination":{"totalCount":2}}))
                }
            }),
        );
    let mr_project = json!({"id":"project","project_type":"modpack","client_side":"required"});
    let cf_project = json!({"data":{"id":42,"classId":4471,"gameId":432}});
    router = router
        .route(
            "/mr/project",
            get(move || {
                let v = mr_project.clone();
                async move { Json(v) }
            }),
        )
        .route(
            "/cf/project",
            get(move || {
                let v = cf_project.clone();
                async move { Json(v) }
            }),
        );
    let mut mappings = vec![
        (
            "https://api.modrinth.com/v2/project/project".to_string(),
            "/mr/project".to_string(),
        ),
        (
            "https://api.curseforge.com/v1/mods/42".to_string(),
            "/cf/project".to_string(),
        ),
    ];
    for (url, params, endpoint) in [
        (
            "https://api.modrinth.com/v2/search",
            vec![
                ("query", "Test".to_string()),
                ("facets", json!([["project_type:modpack"]]).to_string()),
                ("offset", "0".into()),
                ("limit", "20".into()),
                ("index", "relevance".into()),
            ],
            "/mr/search",
        ),
        (
            "https://api.curseforge.com/v1/mods/search",
            vec![
                ("gameId", "432".into()),
                ("classId", "4471".into()),
                ("searchFilter", "Test".into()),
                ("index", "0".into()),
                ("pageSize", "20".into()),
                ("sortField", "2".into()),
                ("sortOrder", "desc".into()),
            ],
            "/cf/search",
        ),
    ] {
        let mut url = reqwest::Url::parse(url).unwrap();
        url.query_pairs_mut().extend_pairs(params);
        mappings.push((url.to_string(), endpoint.into()));
    }
    for format in ["modrinth", "curseforge"] {
        let mut versions = vec![];
        for pack_version in ["1", "2"] {
            let bytes = pack_archive(format, pack_version, &base);
            let sha = hex::encode(Sha1::digest(&bytes));
            let size = bytes.len();
            let endpoint = format!("/{format}/{pack_version}/pack");
            let url = format!("{base}{endpoint}");
            router = router.route(
                &endpoint,
                get(move || {
                    let b = bytes.clone();
                    async move { b }
                }),
            );
            let value = if format == "modrinth" {
                json!({"id":pack_version,"project_id":"project","version_number":pack_version,"name":pack_version,"date_published":format!("2026-11-2{pack_version}"),"version_type":"release","game_versions":["1.20.1"],"loaders":[],"files":[{"primary":true,"filename":format!("pack-{pack_version}.mrpack"),"url":url,"size":size,"hashes":{"sha1":sha}}]})
            } else {
                json!({"id":pack_version.parse::<u64>().unwrap(),"modId":42,"displayName":pack_version,"fileDate":format!("2026-11-2{pack_version}"),"releaseType":1,"fileName":format!("pack-{pack_version}.zip"),"fileLength":size,"downloadUrl":url,"hashes":[{"algo":1,"value":sha}],"gameVersions":["1.20.1"],"isServerPack":false})
            };
            versions.push(value.clone());
            let endpoint = format!("/{format}/{pack_version}/metadata");
            let response = if format == "modrinth" {
                value
            } else {
                json!({"data":value})
            };
            router = router.route(
                &endpoint,
                get(move || {
                    let v = response.clone();
                    async move { Json(v) }
                }),
            );
            mappings.push((
                if format == "modrinth" {
                    format!("https://api.modrinth.com/v2/version/{pack_version}")
                } else {
                    format!("https://api.curseforge.com/v1/mods/42/files/{pack_version}")
                },
                endpoint,
            ));
        }
        if format == "curseforge" {
            versions.push(json!({"id":99,"isServerPack":true}));
        }
        let response = if format == "modrinth" {
            json!(versions)
        } else {
            json!({"data":versions,"pagination":{"totalCount":3}})
        };
        let endpoint = format!("/{format}/versions");
        router = router.route(
            &endpoint,
            get(move || {
                let v = response.clone();
                async move { Json(v) }
            }),
        );
        mappings.push((
            if format == "modrinth" {
                "https://api.modrinth.com/v2/project/project/version".into()
            } else {
                "https://api.curseforge.com/v1/mods/42/files?pageSize=50&index=0".into()
            },
            endpoint,
        ));
    }
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    for format in ["modrinth", "curseforge"] {
        let directory = temp.path().join(format);
        std::fs::create_dir_all(&directory).unwrap();
        let installer = runtime(&directory);
        installer.downloads.sources().register(
            crate::minecraft::installer::MANIFEST,
            vec![format!("{base}/manifest")],
        );
        let sources = Arc::new(crate::download_sources::SourceSelector::default());
        for (url, endpoint) in &mappings {
            let mut original = reqwest::Url::parse(url).unwrap();
            if original.query().is_none() {
                original
                    .query_pairs_mut()
                    .extend_pairs(std::iter::empty::<(&str, &str)>());
            }
            sources.register(original.as_str(), vec![format!("{base}{endpoint}")]);
        }
        let community = Arc::new(
            Community::new(Arc::new(
                crate::vault::Vault::open_with_service_directory(
                    &directory.join("vault"),
                    directory.join("services"),
                )
                .unwrap(),
            ))
            .unwrap()
            .with_sources(sources),
        );
        let releases = community
            .modpack_releases(
                format,
                if format == "modrinth" {
                    "project"
                } else {
                    "42"
                },
            )
            .await
            .unwrap();
        assert_eq!(releases.len(), 2);
        assert_eq!(releases[0].id, "2");
        let origin = |version: &str| Origin {
            source: format.into(),
            project_id: if format == "modrinth" {
                "project".into()
            } else {
                "42".into()
            },
            version_id: version.into(),
        };
        let root = directory.join("game");
        let target = root.join("versions/Pack");
        let packs = Arc::new(Modpacks::default());
        let resolver: UrlResolver = Arc::new(|url| Box::pin(async move { Ok(url) }));
        let id = packs
            .start(
                ModpackRequest {
                    root: root.clone(),
                    name: "Pack".into(),
                    token: None,
                    file: None,
                    include_optional: format == "modrinth",
                    origin: Some(origin("1")),
                },
                installer.clone(),
                community.clone(),
                resolver.clone(),
            )
            .await
            .unwrap();
        let result = finished(&installer, &id).await;
        assert_eq!(result.status, Status::Completed, "{:?}", result.error);
        assert_eq!(
            record::read(&target)
                .unwrap()
                .unwrap()
                .origin
                .unwrap()
                .version_id,
            "1"
        );
        let known = discover(&root, "Pack", &community).await.unwrap();
        assert_eq!(known.status, "online");
        assert_eq!(known.target_origin.unwrap().version_id, "2");
        put(&target, "config/a", b"user");
        put(&target, "custom/a", b"custom");
        put(&target, "options.txt", b"options");
        put(&target, "saves/world/level.dat", b"world");
        std::fs::rename(
            target.join("mods/mod-1.jar"),
            target.join("mods/mod-1.jar.disabled"),
        )
        .unwrap();
        let legacy = true;
        if legacy {
            std::fs::remove_file(target.join(record::RECORD)).unwrap();
        }
        ambiguous.store(true, std::sync::atomic::Ordering::Relaxed);
        let duplicate = discover(&root, "Pack", &community).await.unwrap();
        assert_eq!(duplicate.status, "local");
        assert!(duplicate.message.contains("多个同名"));
        ambiguous.store(false, std::sync::atomic::Ordering::Relaxed);
        let online = discover(&root, "Pack", &community).await.unwrap();
        assert_eq!(online.status, "online");
        assert_eq!(online.current_origin.as_ref().unwrap().version_id, "1");
        assert!(online.infer_optional);
        let id = packs
            .prepare_update(
                PrepareRequest {
                    root: root.clone(),
                    id: "Pack".into(),
                    token: None,
                    origin: online.target_origin,
                    current_token: None,
                    current_origin: online.current_origin,
                    include_optional: online.include_optional,
                    current_include_optional: false,
                    infer_optional: online.infer_optional,
                },
                installer.clone(),
                community.clone(),
                resolver,
            )
            .await
            .unwrap();
        let result = finished(&installer, &id).await;
        assert_eq!(result.status, Status::Completed, "{:?}", result.error);
        let plan = packs.updates.plan(&id).unwrap();
        assert!(!plan.baseline_missing);
        assert!(
            plan.items
                .iter()
                .find(|r| r.path == "config/a")
                .unwrap()
                .conflict
        );
        let renamed = plan
            .items
            .iter()
            .find(|r| r.path == "mods/mod-2.jar")
            .unwrap();
        assert_eq!(renamed.destination_path, "mods/mod-2.jar.disabled");
        let id = packs
            .updates
            .start(
                ApplyRequest {
                    root: root.clone(),
                    id: "Pack".into(),
                    token: id,
                    decisions: maps(&[("config/a", "keep")]),
                    new_name: None,
                },
                installer.clone(),
            )
            .unwrap();
        let result = finished(&installer, &id).await;
        assert_eq!(result.status, Status::Completed, "{:?}", result.error);
        assert_eq!(std::fs::read(target.join("config/a")).unwrap(), b"user");
        assert_eq!(std::fs::read(target.join("custom/a")).unwrap(), b"custom");
        assert_eq!(
            std::fs::read(target.join("options.txt")).unwrap(),
            b"options"
        );
        assert!(target.join("mods/mod-2.jar.disabled").is_file());
        assert!(!target.join("mods/mod-2.jar").exists());
        assert!(!target.join("mods/mod-1.jar.disabled").exists());
        assert!(!target.join("config/removed").exists());
        assert!(target.join("config/add").is_file());
        assert_eq!(
            record::read(&target).unwrap().unwrap().files["config/a"],
            hex::encode(Sha1::digest(b"new"))
        );
        assert!(installer.downloads.snapshots().await.is_empty());
        if format == "modrinth" {
            let r = record::read(&target).unwrap().unwrap();
            assert!(r.include_optional);
            assert!(r.optional_files.contains("mods/optional.jar"));
            assert_eq!(
                r.files["mods/optional.jar"],
                hex::encode(Sha1::digest(zipped(&[(
                    "fabric.mod.json",
                    serde_json::to_vec(&json!({"id":"optional","version":"2","name":"Optional"}))
                        .unwrap()
                )])))
            );
        }
        let latest = discover(&root, "Pack", &community).await.unwrap();
        assert_eq!(latest.status, "upToDate");
        assert!(latest.target_origin.is_none());
    }
    server.abort();
}
#[test]
fn three_way_diff_preserves_changes_deletions_disabled_and_unknown_files() {
    let old = maps(&[
        ("config/a", "old"),
        ("config/b", "old"),
        ("mods/off.jar", "old"),
        ("config/deleted", "old"),
        ("config/removed", "old"),
    ]);
    let new = maps(&[
        ("config/a", "new"),
        ("config/b", "old"),
        ("mods/off.jar", "new"),
        ("config/deleted", "old"),
        ("config/add", "new"),
    ]);
    let local = maps(&[
        ("config/a", "user"),
        ("config/b", "user"),
        ("mods/off.jar.disabled", "old"),
        ("config/removed", "old"),
        ("custom/user", "user"),
    ]);
    let rows = diff(&old, &new, &local, "Pack");
    let row = |p: &str| rows.iter().find(|r| r.path == p).unwrap();
    assert!(row("config/a").conflict);
    assert_eq!(row("config/b").action, "keep");
    assert_eq!(row("config/deleted").action, "keep");
    assert_eq!(row("config/removed").action, "remove");
    assert_eq!(row("config/add").action, "add");
    assert_eq!(row("mods/off.jar").local_path, "mods/off.jar.disabled");
    assert!(!row("mods/off.jar").conflict);
    assert_eq!(row("custom/user").action, "keep");
}
#[test]
fn install_record_keeps_author_hashes_and_excludes_personal_runtime() {
    let temp = scratch();
    let root = temp.path();
    profile(root, "Pack", "1");
    put(root, "config/a", b"author");
    put(root, "saves/world/level.dat", b"world");
    put(root, "options.txt", b"options");
    put(root, "natives/a.dll", b"native");
    record(root, "Pack", "1");
    put(root, "config/a", b"user");
    let r = record::read(root).unwrap().unwrap();
    assert_eq!(r.files.len(), 1);
    assert_eq!(r.files["config/a"], hex::encode(Sha1::digest(b"author")));
    assert_ne!(
        r.files["config/a"],
        record::hash(&root.join("config/a"), &CancellationToken::new())
            .unwrap()
            .unwrap()
    );
}
#[test]
fn commits_changes_and_restores_without_touching_world_or_options() {
    let temp = scratch();
    let root = temp.path().join("game");
    let target = root.join("versions/Pack");
    let stage = temp.path().join("new");
    profile(&target, "Pack", "1");
    put(&target, "config/a", b"old");
    put(&target, "config/removed", b"remove");
    put(&target, "saves/world/level.dat", b"world");
    put(&target, "options.txt", b"user");
    record(&target, "Pack", "1");
    profile(&stage, "Pack", "2");
    put(&stage, "config/a", b"new");
    put(&stage, "config/add", b"added");
    record(&stage, "Pack", "2");
    let cancel = CancellationToken::new();
    let expected = record::snapshot(&target, &cancel).unwrap();
    let desired = record::snapshot(&stage, &cancel).unwrap();
    let backup =
        transaction::commit(&root, "Pack", &stage, &expected, &desired, true, &cancel).unwrap();
    assert_eq!(std::fs::read(target.join("config/a")).unwrap(), b"new");
    assert!(!target.join("config/removed").exists());
    assert_eq!(
        std::fs::read(backup.join("saves/world/level.dat")).unwrap(),
        b"world"
    );
    assert_eq!(std::fs::read(target.join("options.txt")).unwrap(), b"user");
    let item = transaction::history(&root, "Pack").unwrap()[0].clone();
    transaction::restore(&root, "Pack", item["id"].as_str().unwrap()).unwrap();
    assert_eq!(std::fs::read(target.join("config/a")).unwrap(), b"old");
    assert!(target.join("config/removed").is_file());
    assert!(!target.join("config/add").exists());
    assert_eq!(
        std::fs::read(target.join("saves/world/level.dat")).unwrap(),
        b"world"
    );
}
#[test]
fn stale_preview_cancel_and_modified_backup_are_rejected() {
    let temp = scratch();
    let root = temp.path().join("game");
    let target = root.join("versions/Pack");
    let stage = temp.path().join("new");
    profile(&target, "Pack", "1");
    put(&target, "config/a", b"old");
    record(&target, "Pack", "1");
    profile(&stage, "Pack", "2");
    put(&stage, "config/a", b"new");
    record(&stage, "Pack", "2");
    let cancel = CancellationToken::new();
    let before = record::snapshot(&target, &cancel).unwrap();
    let after = record::snapshot(&stage, &cancel).unwrap();
    put(&target, "config/a", b"changed");
    assert!(transaction::commit(&root, "Pack", &stage, &before, &after, false, &cancel).is_err());
    put(&target, "config/a", b"old");
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        transaction::commit(&root, "Pack", &stage, &before, &after, false, &cancelled).is_err()
    );
    let backup =
        transaction::commit(&root, "Pack", &stage, &before, &after, false, &cancel).unwrap();
    put(&target, "config/a", b"after-game-edit");
    assert!(
        transaction::restore(&root, "Pack", backup.file_name().unwrap().to_str().unwrap()).is_err()
    );
    assert_eq!(
        std::fs::read(target.join("config/a")).unwrap(),
        b"after-game-edit"
    );
}
#[test]
fn interrupted_update_blocks_launch_and_recovers_partial_commit() {
    let temp = scratch();
    let root = temp.path().join("game");
    let target = root.join("versions/Pack");
    profile(&target, "Pack", "1");
    put(&target, "config/a", b"old");
    let backup = root.join(".tmcl/modpack-updates/Pack/interrupted");
    put(&backup, "files/config/a", b"old");
    put(&target, "config/a", b"new");
    put(&backup,"recovery.json",&serde_json::to_vec(&json!({"versionId":"Pack","state":"applying","savesBackup":false,"changes":[{"path":"config/a","before":hex::encode(Sha1::digest(b"old")),"after":hex::encode(Sha1::digest(b"new"))}]})).unwrap());
    assert!(ensure_ready(&root, "Pack").is_err());
    transaction::restore(&root, "Pack", "interrupted").unwrap();
    assert_eq!(std::fs::read(target.join("config/a")).unwrap(), b"old");
    ensure_ready(&root, "Pack").unwrap();
}
#[test]
fn locks_exclude_launch_install_and_record_paths_cannot_escape() {
    let temp = scratch();
    let root = temp.path().join("game");
    let target = root.join("versions/Pack");
    profile(&target, "Pack", "1");
    let guard = operation_guard(&root, "Pack").unwrap();
    assert!(operation_guard(&root, "Pack").is_err());
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join(".tmcl/locks/launch-Pack.lock"))
        .unwrap();
    assert!(file.try_lock_shared().is_err());
    drop(guard);
    file.try_lock_shared().unwrap();
    drop(file);
    record(&target, "Pack", "1");
    let mut r = record::read(&target).unwrap().unwrap();
    r.files.insert("../outside".into(), "0".repeat(40));
    put(&target, record::RECORD, &serde_json::to_vec(&r).unwrap());
    assert!(record::read(&target).is_err());
}
fn ready(temp: &Path, legacy: bool) -> Ready {
    let root = temp.join("game");
    let target = root.join("versions/Pack");
    profile(&target, "Pack", "1");
    put(&target, "config/a", b"old");
    put(&target, "config/removed", b"removed");
    put(&target, "options.txt", b"personal");
    put(&target, "saves/world/level.dat", b"world");
    if !legacy {
        record(&target, "Pack", "1");
    }
    let work = tempfile::tempdir_in(temp).unwrap();
    let next = work.path().join("new/game/versions/Pack");
    profile(&next, "Pack", "2");
    put(&next, "config/a", b"new");
    put(&next, "config/add", b"added");
    record(&next, "Pack", "2");
    let new = record::read(&next).unwrap().unwrap();
    let cancel = CancellationToken::new();
    let expected = record::snapshot(&target, &cancel).unwrap();
    let baseline = record::read(&target).unwrap();
    let items = diff(
        &baseline
            .as_ref()
            .map(|r| r.files.clone())
            .unwrap_or_default(),
        &new.files,
        &expected,
        "Pack",
    );
    let expected_record = record::hash(&target.join(record::RECORD), &cancel).unwrap();
    Ready {
        work,
        root,
        id: "Pack".into(),
        expected,
        expected_record,
        created: Instant::now(),
        plan: Plan {
            token: "plan".into(),
            current: json!({"minecraft":"1.20.1","version":"1"}),
            target: new,
            items,
            baseline_missing: legacy,
            warnings: vec![],
        },
    }
}
#[tokio::test]
async fn applies_real_files_keeps_local_conflict_and_author_baseline() {
    let temp = scratch();
    let mut r = ready(temp.path(), false);
    let target = r.root.join("versions/Pack");
    put(&target, "config/a", b"user");
    r.expected = record::snapshot(&target, &CancellationToken::new()).unwrap();
    r.plan.items = diff(
        &record::read(&target).unwrap().unwrap().files,
        &r.plan.target.files,
        &r.expected,
        "Pack",
    );
    let installer = runtime(temp.path());
    let job = installer.jobs.create(
        JobKind::ModpackUpdate,
        "update".into(),
        &["check", "merge", "mods", "commit"],
    );
    apply(
        r,
        ApplyRequest {
            root: temp.path().join("game"),
            id: "Pack".into(),
            token: "plan".into(),
            new_name: None,
            decisions: maps(&[("config/a", "keep")]),
        },
        installer,
        job,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(target.join("config/a")).unwrap(), b"user");
    assert!(!target.join("config/removed").exists());
    assert!(target.join("config/add").is_file());
    assert_eq!(
        record::read(&target).unwrap().unwrap().files["config/a"],
        hex::encode(Sha1::digest(b"new"))
    );
    assert_eq!(
        std::fs::read(target.join("options.txt")).unwrap(),
        b"personal"
    );
}
#[tokio::test]
async fn legacy_instance_requires_new_name_and_migrates_world_without_old_pack_files() {
    let temp = scratch();
    let r = ready(temp.path(), true);
    let target = r.root.join("versions/Pack");
    let installer = runtime(temp.path());
    let updates = Updates::default();
    updates.ready.lock().unwrap().insert("plan".into(), r);
    assert!(updates
        .start(
            ApplyRequest {
                root: temp.path().join("game"),
                id: "Pack".into(),
                token: "plan".into(),
                new_name: None,
                decisions: BTreeMap::new()
            },
            installer.clone()
        )
        .is_err());
    let r = updates.ready.lock().unwrap().remove("plan").unwrap();
    let job = installer.jobs.create(
        JobKind::ModpackUpdate,
        "update".into(),
        &["check", "merge", "mods", "commit"],
    );
    apply(
        r,
        ApplyRequest {
            root: temp.path().join("game"),
            id: "Pack".into(),
            token: "plan".into(),
            new_name: Some("NewPack".into()),
            decisions: BTreeMap::new(),
        },
        installer,
        job,
    )
    .await
    .unwrap();
    let new = temp.path().join("game/versions/NewPack");
    assert_eq!(
        std::fs::read(new.join("saves/world/level.dat")).unwrap(),
        b"world"
    );
    assert_eq!(std::fs::read(new.join("config/a")).unwrap(), b"new");
    assert!(!new.join("config/removed").exists());
    assert_eq!(std::fs::read(target.join("config/a")).unwrap(), b"old");
    assert!(new.join("NewPack.jar").is_file());
    assert_eq!(
        versions::resolve(&temp.path().join("game"), "NewPack").unwrap()["id"],
        "NewPack"
    );
}
