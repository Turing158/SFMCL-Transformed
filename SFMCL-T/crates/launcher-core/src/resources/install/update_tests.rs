use super::*;
use axum::{
    routing::{get, post},
    Json, Router,
};
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn named_instances_resolve_the_game_version_and_actual_loader() {
    let game = scratch();
    for (id, value) in [
        ("1.20.1", json!({"id":"1.20.1"})),
        (
            "loader",
            json!({"id":"loader","inheritsFrom":"1.20.1","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.9"}]}),
        ),
        ("instance", json!({"id":"instance","inheritsFrom":"loader"})),
        (
            "patched",
            json!({"id":"patched","patches":[{"id":"game","version":"1.21.1"},{"id":"neoforge","version":"21.1.1"}]}),
        ),
    ] {
        write_jar(
            game.path(),
            &format!("versions/{id}/{id}.json"),
            value.to_string().as_bytes(),
        );
    }
    for (id, mc, loader) in [
        ("instance", "1.20.1", "Fabric"),
        ("patched", "1.21.1", "NeoForge"),
    ] {
        let target =
            Target::resolve(game.path().into(), id, &crate::config::Settings::default()).unwrap();
        assert_eq!(
            (target.game_version.as_str(), target.loader.as_str()),
            (mc, loader)
        );
    }
}

#[test]
fn replaces_only_the_selected_jar_in_each_enabled_or_disabled_location() {
    for (path, disabled) in [
        ("mods/custom.jar", false),
        ("mods/.disabled/custom.jar", true),
        ("mods/custom.jar.disabled", true),
    ] {
        let game = scratch();
        let stage = scratch();
        let old = jar("main");
        let new = mod_jar("main", "2.0");
        write_jar(game.path(), path, &old);
        write_jar(stage.path(), "mods/main.jar", &new);
        let expected = Inventory::read(game.path()).unwrap();
        let old_file = &expected.files[0];
        let selected = selection("main", &new);
        let commit = |selected: &Selection, cancel: &CancellationToken| {
            transaction::commit(
                &target(game.path()),
                &expected,
                std::slice::from_ref(selected),
                Some(old_file),
                stage.path(),
                cancel,
            )
        };
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(commit(&selected, &cancel).is_err());
        assert_eq!(fs::read(game.path().join(path)).unwrap(), old);
        let mut invalid = selected.clone();
        invalid.candidate.file.sha1 = Some("f".repeat(40));
        assert!(commit(&invalid, &CancellationToken::new()).is_err());
        assert_eq!(Inventory::read(game.path()).unwrap(), expected);
        commit(&selected, &CancellationToken::new()).unwrap();
        let resources = local::scan(game.path(), "mod").unwrap();
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0].version, "2.0");
        assert_eq!(resources[0].disabled, disabled);
        assert_eq!(fs::read(game.path().join(path)).unwrap(), new);
    }
}

#[cfg(windows)]
#[test]
fn occupied_original_rolls_back_new_and_reenabled_dependencies() {
    use std::os::windows::fs::OpenOptionsExt;
    let game = scratch();
    let stage = scratch();
    for path in [
        "mods/main.jar",
        "mods/.disabled/main.jar",
        "mods/main.jar.disabled",
    ] {
        let old = jar("main");
        write_jar(game.path(), path, &old);
        write_jar(game.path(), "mods/.disabled/dep.jar", &jar("dep"));
        let inventory = Inventory::read(game.path()).unwrap();
        let main = inventory.files.iter().find(|f| f.path == path).unwrap();
        let dep = inventory
            .files
            .iter()
            .find(|f| f.path.ends_with("/dep.jar"))
            .unwrap();
        let mut enable = selection("dep", &jar("dep"));
        enable.item.main = false;
        enable.item.path = dep.path.clone();
        enable.existing = Some(dep.clone());
        let new = mod_jar("main", "2.0");
        write_jar(stage.path(), "mods/main.jar", &new);
        write_jar(stage.path(), "mods/lib.jar", &jar("lib"));
        let mut lib = selection("lib", &jar("lib"));
        lib.item.main = false;
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(game.path().join(path))
            .unwrap();
        let error = transaction::commit(
            &target(game.path()),
            &inventory,
            &[selection("main", &new), enable, lib],
            Some(main),
            stage.path(),
            &CancellationToken::new(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("无法替换原模组"), "{error:#}");
        assert_eq!(Inventory::read(game.path()).unwrap(), inventory);
        assert_eq!(fs::read(game.path().join(path)).unwrap(), old);
        drop(lock);
        fs::remove_file(game.path().join(path)).unwrap();
    }
}

#[test]
fn server_only_jar_cannot_replace_the_original_client_mod() {
    let game = scratch();
    let stage = scratch();
    let path = "mods/main.jar";
    write_jar(game.path(), path, &jar("main"));
    let inventory = Inventory::read(game.path()).unwrap();
    let bytes = fabric_jar(json!({"id":"main","version":"2.0","environment":"server"}));
    write_jar(stage.path(), path, &bytes);
    let error = transaction::commit(
        &target(game.path()),
        &inventory,
        &[selection("main", &bytes)],
        Some(&inventory.files[0]),
        stage.path(),
        &CancellationToken::new(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("仅服务端"));
    assert_eq!(inventory, Inventory::read(game.path()).unwrap());
}

fn mr_version(project: &str, id: &str, version: &str, day: u8, bytes: &[u8], url: &str) -> Value {
    json!({"id":id, "name":version, "project_id":project, "version_number":version,
        "date_published":format!("2026-01-{day:02}T12:00:00Z"), "version_type":"release", "changelog":"Fixed startup", "game_versions":["1.20.1"], "loaders":["fabric"], "files":[{"filename":format!("{project}.jar"), "primary":true, "url":url, "hashes":{"sha1":hex::encode(Sha1::digest(bytes))}, "size":bytes.len()}]})
}

#[tokio::test]
async fn curseforge_prefers_saved_source_requires_full_hash_and_reads_release_notes() {
    let game = scratch();
    let bytes = jar("main");
    let sha = hex::encode(Sha1::digest(&bytes));
    let path = game.path().join("mods/main.jar");
    write_jar(game.path(), "mods/main.jar", &bytes);
    let local =
        crate::resources::community::install_metadata::mod_identity(game.path(), &path).unwrap();
    let mut target = target(game.path());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let old = json!({"id":11,"modId":42,"displayName":"1.0","fileDate":"2026-01-01T00:00:00Z","hashes":[{"algo":1,"value":sha}],
        "gameVersions":["1.20.1","Fabric"],"releaseType":1,"fileName":"main.jar","downloadUrl":format!("{base}/old.jar")});
    let mut new = old.clone();
    new["id"] = json!(12);
    new["displayName"] = json!("2.0");
    new["fileDate"] = json!("2026-01-02T12:00:00+08:00");
    new["hashes"][0]["value"] = json!("b".repeat(40));
    let mut server_only = new.clone();
    server_only["id"] = json!(13);
    server_only["fileDate"] = json!("2026-01-03T00:00:00Z");
    server_only["gameVersions"] = json!(["1.20.1", "Fabric", "Server"]);
    let mode = Arc::new(AtomicUsize::new(0));
    let mr_calls = Arc::new(AtomicUsize::new(0));
    let router = Router::new()
        .route(
            "/fingerprints",
            post({
                let mode = mode.clone();
                let old = old.clone();
                move |Json(body): Json<Value>| {
                    assert_eq!(body, json!({"fingerprints":[local.fingerprint]}));
                    let mut matched = old.clone();
                    if mode.load(Ordering::SeqCst) == 4 {
                        matched["displayName"] = json!("2.0");
                        matched["releaseType"] = json!(2);
                    }
                    if mode.load(Ordering::SeqCst) == 2 {
                        matched["hashes"][0]["value"] = json!("c".repeat(40));
                    }
                    let mut exact = vec![json!({"file":matched})];
                    if mode.load(Ordering::SeqCst) == 3 {
                        let mut duplicate = old.clone();
                        duplicate["modId"] = json!(99);
                        exact.push(json!({"file":duplicate}));
                    }
                    async move { Json(json!({"data":{"exactMatches":exact}})) }
                }
            }),
        )
        .route(
            "/modrinth",
            post({
                let calls = mr_calls.clone();
                move || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    async { Json(json!({})) }
                }
            }),
        )
        .route(
            "/project",
            get(|| async {
                Json(json!({"data":{"id":42,"classId":6,"gameId":432,"name":"Main"}}))
            }),
        )
        .route(
            "/files",
            get({
                let mode = mode.clone();
                move || {
                    let files = if mode.load(Ordering::SeqCst) == 1 {
                        json!([old, server_only])
                    } else {
                        json!([old, new, server_only])
                    };
                    async move { Json(json!({"data":files})) }
                }
            }),
        )
        .route(
            "/log",
            get(|| async { Json(json!({"data":"<p>Release notes</p>"})) }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let sources = Arc::new(crate::download_sources::SourceSelector::default());
    for (url, endpoint) in [
        ("https://api.curseforge.com/v1/fingerprints/432?", "fingerprints"),
        ("https://api.curseforge.com/v1/mods/42?", "project"),
        ("https://api.curseforge.com/v1/mods/42/files?pageSize=50&index=0&gameVersion=1.20.1&modLoaderType=4","files"),
        ("https://api.curseforge.com/v1/mods/42/files?pageSize=50&index=0&gameVersion=1.20.1&modLoaderType=1","files"),
        ("https://api.curseforge.com/v1/mods/42/files/12/changelog?", "log"),
        ("https://api.modrinth.com/v2/version_files?", "modrinth"),
    ] { sources.register(url, vec![format!("{base}/{endpoint}")]); }
    let vault = Arc::new(
        crate::vault::Vault::open_with_service_directory(
            &game.path().join("vault"),
            game.path().join("services"),
        )
        .unwrap(),
    );
    let cache = game.path().join("mod-sources.json");
    Community::new(vault.clone())
        .unwrap()
        .with_mod_source_cache(cache.clone())
        .remember_mod_source(&sha, "curseforge");
    let community = Community::new(vault)
        .unwrap()
        .with_sources(sources)
        .with_mod_source_cache(cache);
    let installer = ModInstaller::default();
    let check = |target| installer.check_update(&community, target, path.clone());
    assert!(
        matches!(check(target.clone()).await.unwrap(), ModUpdate::Available { source, version, changelog, .. }
        if source=="curseforge" && version=="2.0" && changelog.contains("Release notes"))
    );
    mode.store(1, Ordering::SeqCst);
    target.environment += "changed";
    assert!(matches!(
        check(target.clone()).await.unwrap(),
        ModUpdate::Latest
    ));
    target.loader = "Forge".into();
    assert!(matches!(
        check(target.clone()).await.unwrap(),
        ModUpdate::NoCompatibleRelease
    ));
    assert_eq!(mr_calls.load(Ordering::SeqCst), 0);
    for scenario in [2, 3] {
        mode.store(scenario, Ordering::SeqCst);
        target.environment.push('x');
        assert!(matches!(
            check(target.clone()).await.unwrap(),
            ModUpdate::Unidentified
        ));
    }
    assert_eq!(mr_calls.load(Ordering::SeqCst), 2);
    target.loader = "Fabric".into();
    target.environment.push('x');
    mode.store(4, Ordering::SeqCst);
    assert!(
        matches!(check(target).await.unwrap(), ModUpdate::Available { current, version, .. }
        if current.contains("预发布版") && version == "2.0")
    );
    server.abort();
}

#[tokio::test]
async fn manual_check_matches_one_file_coalesces_and_previews_before_updating_shared_mods() {
    let game = scratch();
    let data = scratch();
    let settings = Arc::new(crate::config::ConfigStore::open(data.path()).unwrap());
    settings.update(|s| s.isolation = false).unwrap();
    for id in ["test", "other"] {
        write_jar(game.path(), &format!("versions/{id}/{id}.json"), json!({"id":id,"clientVersion":"1.20.1","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.9"}]}).to_string().as_bytes());
    }
    let target = Target::resolve(game.path().into(), "test", &settings.get()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let old = jar("main");
    let new = mod_jar("main", "2.0");
    let lib = jar("lib");
    let path = "mods/.disabled/renamed.jar";
    write_jar(&target.game, path, &old);
    write_jar(&target.game, "mods/unrelated.jar", &jar("unrelated"));
    let mut release = mr_version("main", "new", "2.0", 2, &new, &format!("{base}/new.jar"));
    release["dependencies"] =
        json!([{"dependency_type":"required","project_id":"lib","version_id":"library"}]);
    let current = mr_version("main", "old", "1.0", 1, &old, &format!("{base}/old.jar"));
    let library = mr_version("lib", "library", "1.0", 1, &lib, &format!("{base}/lib.jar"));
    let mut versions = vec![current.clone(), release.clone()];
    for (field, value) in [
        ("loaders", json!(["forge"])),
        ("game_versions", json!(["1.21"])),
        ("environment", json!("server")),
        ("version_type", json!("beta")),
        ("version_number", json!("0.9")),
    ] {
        let mut bad = mr_version(
            "main",
            "wrong",
            "3.0",
            9,
            &jar("bad"),
            "https://example.org/wrong.jar",
        );
        bad[field] = value;
        versions.push(bad);
    }
    let sources = Arc::new(crate::download_sources::SourceSelector::default());
    let register = |path: &str, params: &[(&str, &str)], endpoint: &str| {
        let mut url = reqwest::Url::parse(&format!("https://api.modrinth.com/v2/{path}")).unwrap();
        url.query_pairs_mut().extend_pairs(params);
        sources.register(url.as_str(), vec![format!("{base}/{endpoint}")]);
    };
    let queries = Arc::new(Mutex::new(Vec::new()));
    let log = queries.clone();
    let sha = hex::encode(Sha1::digest(&old));
    let mut router = Router::new().route(
        "/identify",
        post(move |Json(request): Json<Value>| {
            let response = json!({&sha: &current});
            log.lock().unwrap().push(request);
            async move { Json(response) }
        }),
    );
    register("version_files", &[], "identify");
    for (path, endpoint, params, response) in [
        (
            "project/main",
            "project",
            vec![],
            json!({"id":"main","title":"Main","project_type":"mod","client_side":"required"}),
        ),
        (
            "project/lib",
            "lib",
            vec![],
            json!({"id":"lib","title":"Library","project_type":"mod"}),
        ),
        ("version/new", "release", vec![], release),
        ("version/library", "library", vec![], library),
        (
            "project/main/version",
            "versions",
            vec![("game_versions", r#"["1.20.1"]"#)],
            json!(versions),
        ),
    ] {
        register(path, &params, endpoint);
        router = router.route(
            &format!("/{endpoint}"),
            get(move || {
                let value = response.clone();
                async move { Json(value) }
            }),
        );
    }
    let downloads_started = Arc::new(AtomicUsize::new(0));
    for (route, bytes) in [("/new.jar", new.clone()), ("/lib.jar", lib.clone())] {
        let calls = downloads_started.clone();
        router = router.route(
            route,
            get(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                let bytes = bytes.clone();
                async move { bytes }
            }),
        );
    }
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let community = Community::new(Arc::new(
        crate::vault::Vault::open_with_service_directory(
            &data.path().join("vault"),
            data.path().join("services"),
        )
        .unwrap(),
    ))
    .unwrap()
    .with_sources(sources);
    let installer = ModInstaller::default();
    let check = || installer.check_update(&community, target.clone(), target.game.join(path));
    let (first, second) = tokio::join!(check(), check());
    let ModUpdate::Available {
        token,
        current,
        version,
        changelog,
        ..
    } = first.unwrap()
    else {
        panic!("expected an update")
    };
    assert_eq!(
        (current.as_str(), version.as_str(), changelog.as_str()),
        ("1.0", "2.0", "Fixed startup")
    );
    for result in [second, check().await] {
        assert!(
            matches!(result.unwrap(), ModUpdate::Available {token: other,..} if token == other)
        );
    }
    assert_eq!(
        queries.lock().unwrap().as_slice(),
        &[json!({"algorithm":"sha1","hashes":[hex::encode(Sha1::digest(&old))]})]
    );
    let plan = installer
        .preview_update(&community, target.clone(), &token, &settings.get())
        .await
        .unwrap();
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    assert!(plan
        .items
        .iter()
        .any(|i| !i.main && i.name == "Library" && i.status == "install"));
    assert!(plan
        .warnings
        .iter()
        .any(|w| w.contains("other") && w.contains("test")));
    assert_eq!(downloads_started.load(Ordering::SeqCst), 0);
    installer.discard(&plan.token.unwrap());
    assert_eq!(fs::read(target.game.join(path)).unwrap(), old);
    let plan = installer
        .preview_update(&community, target.clone(), &token, &settings.get())
        .await
        .unwrap();
    let jobs = Arc::new(Jobs::default());
    let downloads = DownloadManager::open(&data.path().join("downloads"), 2).unwrap();
    let id = installer
        .start(
            &plan.token.unwrap(),
            target.clone(),
            vec![],
            downloads,
            jobs.clone(),
            settings,
            Arc::new(|url| Box::pin(async move { Ok(url) })),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let job = jobs.get(&id).unwrap().snapshot();
            assert!(job.error.is_none(), "{:?}", job.error);
            if job.status == Status::Completed {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fs::read(target.game.join(path)).unwrap(), new);
    assert_eq!(fs::read(target.game.join("mods/lib.jar")).unwrap(), lib);
    assert!(!target.game.join("mods/main.jar").exists());
    assert!(installer
        .preview_update(
            &community,
            target,
            &token,
            &crate::config::Settings::default()
        )
        .await
        .is_err());
    server.abort();
}
