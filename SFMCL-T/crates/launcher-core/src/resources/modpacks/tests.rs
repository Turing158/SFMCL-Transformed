use super::*;
use serde_json::{json, Value};
use sha1::Digest;
use std::io::Write;

fn write_json(root: &Path, path: &str, value: Value) {
    atomic_write(&root.join(path), &serde_json::to_vec(&value).unwrap()).unwrap();
}
fn modrinth(files: Value) -> Value {
    json!({"formatVersion":1,"game":"minecraft","name":"示例整合包","versionId":"1.0","dependencies":{"minecraft":"1.20.1","fabric-loader":"0.16.9"},"files":files})
}
fn modrinth_file(path: &str, env: &str) -> Value {
    json!({"path":path,"env":{"client":env},"hashes":{"sha1":"0123456789012345678901234567890123456789"},"downloads":["https://example.com/file.jar","https://example.org/file.jar"],"fileSize":12})
}
fn zip(root: &Path, name: &str, entries: &[(&str, Vec<u8>)]) -> PathBuf {
    let path = root.join(name);
    let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    for (name, bytes) in entries {
        writer
            .start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
    path
}
#[test]
fn modrinth_wrapped_root_client_optional_and_override_precedence() {
    let temp = tempfile::tempdir().unwrap();
    write_json(
        temp.path(),
        "wrapped/modrinth.index.json",
        modrinth(json!([
            modrinth_file("mods/required.jar", "required"),
            modrinth_file("mods/optional.jar", "optional"),
            modrinth_file("mods/server.jar", "unsupported")
        ])),
    );
    write_json(
        temp.path(),
        "wrapped/overrides/config/manifest.json",
        json!({"configuration":true}),
    );
    atomic_write(
        &temp.path().join("wrapped/overrides/config/a.txt"),
        b"common",
    )
    .unwrap();
    atomic_write(
        &temp.path().join("wrapped/client-overrides/config/a.txt"),
        b"client",
    )
    .unwrap();
    atomic_write(
        &temp.path().join("wrapped/server-overrides/config/a.txt"),
        b"server",
    )
    .unwrap();
    let pack = parser::parse(temp.path(), &CancellationToken::new()).unwrap();
    assert_eq!(pack.info.format, "Modrinth");
    assert_eq!(pack.info.minecraft, "1.20.1");
    assert_eq!(pack.info.loader.unwrap().kind, "Fabric");
    assert_eq!(pack.files.len(), 2);
    assert_eq!(pack.info.optional_files, vec!["mods/optional.jar"]);
    let destination = tempfile::tempdir().unwrap();
    for content in pack.contents {
        copy_contents(
            &content,
            destination.path(),
            "Test",
            false,
            &HashSet::new(),
            &CancellationToken::new(),
        )
        .unwrap();
    }
    assert_eq!(
        std::fs::read(destination.path().join("config/a.txt")).unwrap(),
        b"client"
    );
}
#[test]
fn rejects_manifest_conflicts_unknown_components_and_unsafe_paths() {
    let temp = tempfile::tempdir().unwrap();
    for path in [
        "../outside.jar",
        "/absolute.jar",
        "C:\\outside.jar",
        "mods/CON.jar",
        "mods/a:stream",
        "mods//a.jar",
    ] {
        write_json(
            temp.path(),
            "modrinth.index.json",
            modrinth(json!([modrinth_file(path, "required")])),
        );
        assert!(
            parser::parse(temp.path(), &CancellationToken::new()).is_err(),
            "{path}"
        );
    }
    write_json(
        temp.path(),
        "modrinth.index.json",
        modrinth(json!([
            modrinth_file("mods/A.jar", "required"),
            modrinth_file("mods/a.jar", "required")
        ])),
    );
    assert!(parser::parse(temp.path(), &CancellationToken::new()).is_err());
    let mut invalid = modrinth(json!([]));
    invalid["dependencies"]["quilt-loader"] = json!("0.28");
    write_json(temp.path(), "modrinth.index.json", invalid);
    assert!(parser::parse(temp.path(), &CancellationToken::new()).is_err());
    write_json(temp.path(), "modrinth.index.json", modrinth(json!([])));
    write_json(
        temp.path(),
        "other/modrinth.index.json",
        modrinth(json!([])),
    );
    assert!(parser::parse(temp.path(), &CancellationToken::new()).is_err());
}
#[test]
fn curseforge_loader_primary_and_custom_overrides() {
    let temp = tempfile::tempdir().unwrap();
    let mut value = json!({"manifestType":"minecraftModpack","manifestVersion":1,"name":"CF","version":"2","minecraft":{"version":"1.20.1","modLoaders":[{"id":"forge-47.3.0","primary":true}]},"overrides":"custom","files":[{"projectID":42,"fileID":99,"required":false}]});
    write_json(temp.path(), "manifest.json", value.clone());
    write_json(temp.path(), "custom/config/manifest.json", json!({}));
    let pack = parser::parse(temp.path(), &CancellationToken::new()).unwrap();
    assert_eq!(pack.info.loader.unwrap().version, "47.3.0");
    assert!(pack.files[0].optional);
    assert_eq!(pack.contents.len(), 1);
    value["minecraft"]["modLoaders"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"fabric-0.16.9","primary":true}));
    write_json(temp.path(), "manifest.json", value);
    assert!(parser::parse(temp.path(), &CancellationToken::new()).is_err());
}
#[test]
fn mcbbs_validates_local_hash_and_supports_file_api_and_curse_entries() {
    let temp = tempfile::tempdir().unwrap();
    atomic_write(&temp.path().join("overrides/config/test.txt"), b"hello").unwrap();
    let sha = "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d";
    write_json(
        temp.path(),
        "mcbbs.packmeta",
        json!({"manifestType":"minecraftModpack","manifestVersion":2,"name":"MCBBS","addons":[{"id":"game","version":"1.20.1"},{"id":"fabric","version":"0.16.9"}],"fileApi":"https://example.com/pack","files":[{"type":"addon","path":"config/test.txt","hash":sha},{"type":"addon","path":"mods/hello world.jar","hash":sha},{"type":"curse","projectID":42,"fileID":99}]}),
    );
    let pack = parser::parse(temp.path(), &CancellationToken::new()).unwrap();
    assert_eq!(pack.files.len(), 2);
    assert_eq!(pack.verified.len(), 1);
    match &pack.files[0].source {
        FileSource::Download { spec, .. } => assert_eq!(
            spec.url,
            "https://example.com/pack/overrides/mods/hello%20world.jar"
        ),
        _ => panic!("wrong source"),
    }
    atomic_write(&temp.path().join("overrides/config/test.txt"), b"corrupt").unwrap();
    assert!(parser::parse(temp.path(), &CancellationToken::new()).is_err());
}
#[test]
fn prism_components_and_custom_patches() {
    let temp = tempfile::tempdir().unwrap();
    write_json(
        temp.path(),
        "mmc-pack.json",
        json!({"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.21.1"},{"uid":"net.neoforged","version":"21.1.1"},{"uid":"org.lwjgl3","version":"3.3.3"}]}),
    );
    atomic_write(&temp.path().join("instance.cfg"), b"name=Prism Test\n").unwrap();
    atomic_write(&temp.path().join(".minecraft/config/test.txt"), b"hello").unwrap();
    let pack = parser::parse(temp.path(), &CancellationToken::new()).unwrap();
    assert_eq!(pack.info.name, "Prism Test");
    assert_eq!(pack.info.loader.unwrap().kind, "NeoForge");
    write_json(temp.path(), "patches/net.minecraft.json", json!({}));
    assert!(parser::parse(temp.path(), &CancellationToken::new()).is_err());
}
#[test]
fn zip_signature_not_extension_and_archive_escape_rejection() {
    let temp = tempfile::tempdir().unwrap();
    let valid = zip(
        temp.path(),
        "pack.bin",
        &[(
            "wrapped/modrinth.index.json",
            serde_json::to_vec(&modrinth(json!([]))).unwrap(),
        )],
    );
    let destination = tempfile::tempdir().unwrap();
    archive::extract(&valid, destination.path(), &CancellationToken::new()).unwrap();
    assert_eq!(
        parser::parse(destination.path(), &CancellationToken::new())
            .unwrap()
            .info
            .format,
        "Modrinth"
    );
    for entries in [
        vec![("../outside.txt", vec![1])],
        vec![("a.txt", vec![1]), ("A.txt", vec![2])],
    ] {
        let invalid = zip(temp.path(), "invalid.zip", &entries);
        let out = tempfile::tempdir().unwrap();
        assert!(archive::extract(&invalid, out.path(), &CancellationToken::new()).is_err());
    }
}
#[test]
fn tar_and_gzip_support_wrapped_exports_and_reject_links() {
    let temp = tempfile::tempdir().unwrap();
    let bytes = serde_json::to_vec(&modrinth(json!([]))).unwrap();
    let mut builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder
        .append_data(&mut header, "wrapped/modrinth.index.json", bytes.as_slice())
        .unwrap();
    let tar = builder.into_inner().unwrap();
    std::fs::write(temp.path().join("pack.tar"), &tar).unwrap();
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(&tar).unwrap();
    std::fs::write(temp.path().join("pack.bin"), gzip.finish().unwrap()).unwrap();
    for name in ["pack.tar", "pack.bin"] {
        let out = tempfile::tempdir().unwrap();
        archive::extract(
            &temp.path().join(name),
            out.path(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(
            parser::parse(out.path(), &CancellationToken::new())
                .unwrap()
                .info
                .format,
            "Modrinth"
        );
    }
    let mut builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_size(0);
    header.set_mode(0o777);
    header.set_cksum();
    builder
        .append_link(&mut header, "link", "../outside")
        .unwrap();
    std::fs::write(temp.path().join("link.tar"), builder.into_inner().unwrap()).unwrap();
    let out = tempfile::tempdir().unwrap();
    assert!(archive::extract(
        &temp.path().join("link.tar"),
        out.path(),
        &CancellationToken::new()
    )
    .is_err());
}

fn client(root: &Path) {
    write_json(
        root,
        ".minecraft/versions/1.20.1/1.20.1.json",
        json!({"id":"1.20.1","mainClass":"net.minecraft.client.main.Main","libraries":[],"arguments":{"game":[]}}),
    );
    write_json(
        root,
        ".minecraft/versions/Pack/Pack.json",
        json!({"id":"Pack","inheritsFrom":"1.20.1","mainClass":"example.Client","arguments":{"game":["--demo"]}}),
    );
    atomic_write(
        &root.join(".minecraft/versions/1.20.1/1.20.1.jar"),
        b"client jar",
    )
    .unwrap();
    atomic_write(&root.join(".minecraft/config/common.txt"), b"common").unwrap();
    atomic_write(
        &root.join(".minecraft/versions/Pack/config/common.txt"),
        b"instance",
    )
    .unwrap();
}
#[test]
fn client_directory_merges_inheritance_and_finds_parent_jar() {
    let temp = tempfile::tempdir().unwrap();
    client(temp.path());
    let pack = parser::parse(temp.path(), &CancellationToken::new()).unwrap();
    assert_eq!(pack.info.minecraft, "1.20.1");
    assert_eq!(pack.info.name, "Pack");
    assert_eq!(pack.imported.unwrap()["mainClass"], "example.Client");
    assert!(pack.imported_jar.unwrap().ends_with("1.20.1.jar"));
    atomic_write(
        &temp.path().join(".minecraft/versions/Pack/Pack.jar"),
        b"patched client",
    )
    .unwrap();
    assert!(parser::parse(temp.path(), &CancellationToken::new())
        .unwrap()
        .imported_jar
        .unwrap()
        .ends_with("Pack.jar"));
    write_json(
        temp.path(),
        ".minecraft/versions/Other/Other.json",
        json!({"id":"Other","mainClass":"example.Client"}),
    );
    assert!(parser::parse(temp.path(), &CancellationToken::new()).is_err());
}
fn runtime(directory: &Path) -> (Arc<Installer>, Arc<Community>) {
    let settings = Arc::new(crate::config::ConfigStore::open(&directory.join("data")).unwrap());
    let downloads =
        crate::downloads::DownloadManager::open(&directory.join("downloads"), 2).unwrap();
    let installer = Arc::new(Installer {
        settings,
        downloads,
        jobs: Arc::new(crate::jobs::Jobs::default()),
        client: crate::http_client().unwrap(),
    });
    let community = Arc::new(
        Community::new(Arc::new(
            crate::vault::Vault::open(&directory.join("vault")).unwrap(),
        ))
        .unwrap(),
    );
    (installer, community)
}
async fn finished(installer: &Installer, id: &str) -> crate::jobs::JobSnapshot {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let job = installer
                .jobs
                .snapshots()
                .into_iter()
                .find(|j| j.id == id)
                .unwrap();
            if job.status.terminal() {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn installs_directory_atomically_with_isolation_and_no_profile_pollution() {
    let temp = tempfile::tempdir().unwrap();
    client(&temp.path().join("source"));
    let root = temp.path().join("target");
    let (installer, community) = runtime(temp.path());
    let modpacks = Arc::new(Modpacks::default());
    let inspection = modpacks.inspect(&temp.path().join("source")).unwrap();
    let resolver: UrlResolver = Arc::new(|url| Box::pin(async move { Ok(url) }));
    let id = modpacks
        .start(
            ModpackRequest {
                root: root.clone(),
                name: "Installed".into(),
                token: Some(inspection.token),
                file: None,
                include_optional: false,
            },
            installer.clone(),
            community.clone(),
            resolver.clone(),
        )
        .await
        .unwrap();
    let job = finished(&installer, &id).await;
    assert_eq!(job.status, Status::Completed, "{:?}", job.error);
    let instance = root.join("versions/Installed");
    assert_eq!(
        std::fs::read(instance.join("config/common.txt")).unwrap(),
        b"instance"
    );
    assert_eq!(
        std::fs::read(instance.join("Installed.jar")).unwrap(),
        b"client jar"
    );
    assert!(!instance.join("1.20.1.json").exists());
    let profile = versions::resolve(&root, "Installed").unwrap();
    assert_eq!(profile["tmclModpack"]["isolated"], true);
    assert!(profile["inheritsFrom"].is_null());
    let mut global = installer.settings.get();
    global.isolation = false;
    assert!(
        crate::minecraft::version_settings::resolve(&root, "Installed", &global)
            .unwrap()
            .isolation
    );
    let inspection = modpacks.inspect(&temp.path().join("source")).unwrap();
    assert!(modpacks
        .start(
            ModpackRequest {
                root: root.clone(),
                name: "Installed".into(),
                token: Some(inspection.token),
                file: None,
                include_optional: false
            },
            installer.clone(),
            community,
            resolver
        )
        .await
        .is_err());
    assert_eq!(
        std::fs::read(instance.join("config/common.txt")).unwrap(),
        b"instance"
    );
}
#[tokio::test]
async fn failure_and_cancellation_leave_no_visible_instance() {
    let temp = tempfile::tempdir().unwrap();
    client(&temp.path().join("source"));
    let root = temp.path().join("target");
    let (installer, community) = runtime(temp.path());
    let modpacks = Arc::new(Modpacks::default());
    let resolver: UrlResolver = Arc::new(|url| Box::pin(async move { Ok(url) }));
    // A reserved instance configuration must fail without publishing the profile.
    atomic_write(
        &temp
            .path()
            .join("source/.minecraft/versions/Pack/Broken.json"),
        b"{}",
    )
    .unwrap();
    let inspection = modpacks.inspect(&temp.path().join("source")).unwrap();
    let id = modpacks
        .start(
            ModpackRequest {
                root: root.clone(),
                name: "Broken".into(),
                token: Some(inspection.token),
                file: None,
                include_optional: false,
            },
            installer.clone(),
            community.clone(),
            resolver.clone(),
        )
        .await
        .unwrap();
    assert_eq!(finished(&installer, &id).await.status, Status::Failed);
    assert!(!root.join("versions/Broken").exists());
    let request = ModpackRequest {
        root: root.clone(),
        name: "Cancelled".into(),
        token: None,
        file: Some(DownloadSpec {
            url: "https://example.com/pack.zip".into(),
            path: "pack.zip".into(),
            size: None,
            sha1: None,
            sha512: None,
        }),
        include_optional: false,
    };
    let pending: UrlResolver =
        Arc::new(|_| Box::pin(async { std::future::pending::<Result<String>>().await }));
    let id = modpacks
        .start(request, installer.clone(), community, pending)
        .await
        .unwrap();
    installer.jobs.cancel(&id).unwrap();
    assert_eq!(finished(&installer, &id).await.status, Status::Cancelled);
    assert!(!root.join("versions/Cancelled").exists());
}
#[test]
fn reserved_targets_and_cancelled_extraction_are_rejected() {
    for path in [
        ".tmcl/settings.json",
        "versions/a.json",
        "libraries/a.jar",
        "assets/index.json",
        "natives/a.dll",
        "Instance.json",
        "Instance.jar",
    ] {
        assert!(reserved(path, "Instance").is_err(), "{path}");
    }
    let temp = tempfile::tempdir().unwrap();
    let source = zip(temp.path(), "pack.zip", &[("a.txt", vec![1])]);
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(archive::extract(&source, &temp.path().join("out"), &cancel).is_err());
}

#[test]
fn seven_zip_and_rar_decoders_and_encryption_rejection() {
    let temp = tempfile::tempdir().unwrap();
    let mut writer = sevenz_rust::SevenZWriter::new(
        std::fs::File::create(temp.path().join("pack.bin")).unwrap(),
    )
    .unwrap();
    let mut entry = sevenz_rust::SevenZArchiveEntry::new();
    entry.name = "wrapped/modrinth.index.json".into();
    let data = serde_json::to_vec(&modrinth(json!([]))).unwrap();
    writer
        .push_archive_entry(entry, Some(data.as_slice()))
        .unwrap();
    writer.finish().unwrap();
    let out = tempfile::tempdir().unwrap();
    archive::extract(
        &temp.path().join("pack.bin"),
        out.path(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(
        parser::parse(out.path(), &CancellationToken::new())
            .unwrap()
            .info
            .format,
        "Modrinth"
    );
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/modpacks");
    let out = tempfile::tempdir().unwrap();
    archive::extract(
        &fixtures.join("stored.rar"),
        out.path(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(
        std::fs::read(out.path().join("VERSION")).unwrap(),
        b"unrar-0.4.0"
    );
    let out = tempfile::tempdir().unwrap();
    assert!(archive::extract(
        &fixtures.join("encrypted.rar"),
        out.path(),
        &CancellationToken::new()
    )
    .is_err());
}

#[tokio::test]
async fn online_archive_download_installs_the_detected_client_format() {
    let temp = tempfile::tempdir().unwrap();
    client(&temp.path().join("source"));
    let entries = archive::files(&temp.path().join("source"), &CancellationToken::new())
        .unwrap()
        .into_iter()
        .map(|file| {
            (
                file.strip_prefix(temp.path().join("source"))
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
                std::fs::read(file).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    let archive = zip(
        temp.path(),
        "online.zip",
        &entries
            .iter()
            .map(|(name, bytes)| (name.as_str(), bytes.clone()))
            .collect::<Vec<_>>(),
    );
    let body = std::fs::read(archive).unwrap();
    let sha1 = hex::encode(sha1::Sha1::digest(&body));
    let size = body.len() as u64;
    let app = axum::Router::new().route(
        "/pack",
        axum::routing::get(move || {
            let body = body.clone();
            async move { body }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (installer, community) = runtime(temp.path());
    let packs = Arc::new(Modpacks::default());
    let root = temp.path().join("target");
    let resolver: UrlResolver = Arc::new(|url| Box::pin(async move { Ok(url) }));
    let id = packs
        .start(
            ModpackRequest {
                root: root.clone(),
                name: "Online".into(),
                token: None,
                file: Some(DownloadSpec {
                    url: format!("http://{address}/pack"),
                    path: "download.mrpack".into(),
                    size: Some(size),
                    sha1: Some(sha1),
                    sha512: None,
                }),
                include_optional: false,
            },
            installer.clone(),
            community,
            resolver,
        )
        .await
        .unwrap();
    let job = finished(&installer, &id).await;
    server.abort();
    assert_eq!(job.status, Status::Completed, "{:?}", job.error);
    assert_eq!(
        std::fs::read(root.join("versions/Online/config/common.txt")).unwrap(),
        b"instance"
    );
    assert_eq!(
        versions::resolve(&root, "Online").unwrap()["tmclModpack"]["format"],
        "客户端目录"
    );
    assert!(installer.downloads.snapshots().await.is_empty());
}

#[tokio::test]
async fn mirrors_fallback_and_manual_file_hash_validation_continue_workflow() {
    let temp = tempfile::tempdir().unwrap();
    let body = b"original dependency".to_vec();
    let bytes = body.clone();
    let app = axum::Router::new()
        .route(
            "/good",
            axum::routing::get(move || {
                let body = bytes.clone();
                async move { body }
            }),
        )
        .route(
            "/bad",
            axum::routing::get(|| async { axum::http::StatusCode::NOT_FOUND }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (installer, _) = runtime(temp.path());
    let path = "versions/Test/mods/file.jar";
    let good = format!("http://{address}/good");
    let bad = format!("http://{address}/bad");
    let spec = DownloadSpec {
        url: bad.clone(),
        path: path.into(),
        size: Some(body.len() as u64),
        sha1: Some(hex::encode(sha1::Sha1::digest(&body))),
        sha512: None,
    };
    let mirrors = HashMap::from([(path.to_owned(), vec![bad.clone(), good])]);
    let job = installer
        .jobs
        .create(JobKind::Modpack, "mirrors".into(), &["download"]);
    tokio::time::timeout(
        Duration::from_secs(10),
        download_contents(
            &installer,
            &job,
            &temp.path().join("mirror"),
            "Test",
            vec![spec.clone()],
            &mirrors,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        std::fs::read(temp.path().join("mirror").join(path)).unwrap(),
        body
    );
    let job = installer
        .jobs
        .create(JobKind::Modpack, "manual".into(), &["download"]);
    let manual_root = temp.path().join("manual");
    let working = installer.clone();
    let task_job = job.clone();
    let task_root = manual_root.clone();
    let task = tokio::spawn(async move {
        download_contents(
            &working,
            &task_job,
            &task_root,
            "Test",
            vec![spec],
            &HashMap::new(),
        )
        .await
    });
    let download = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(id) = job.snapshot().download_id {
                if installer.downloads.snapshot(&id).await.unwrap().status == Status::Failed {
                    break id;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    let selected = temp.path().join("supplied.jar");
    std::fs::write(&selected, b"corrupt").unwrap();
    assert!(installer
        .downloads
        .supply_file(&download, path, &selected)
        .await
        .is_err());
    assert!(!manual_root.join(path).exists());
    std::fs::write(&selected, &body).unwrap();
    installer
        .downloads
        .supply_file(&download, path, &selected)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read(manual_root.join(path)).unwrap(), body);
    server.abort();
}
