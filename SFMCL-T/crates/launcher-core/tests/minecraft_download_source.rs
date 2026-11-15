use serde_json::json;
use sfmcl_t_core::{
    config::{ConfigStore, Settings},
    downloads::DownloadManager,
    jobs::{JobKind, Jobs},
    minecraft::{
        download_source::{MinecraftDownloadSource, BMCL, MANIFEST},
        installer::Installer,
    },
};
use sha1::{Digest, Sha1};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[test]
fn download_source_defaults_persists_and_rejects_unknown_sources() {
    let old: Settings = serde_json::from_str("{}").unwrap();
    assert_eq!(old.minecraft_download_source, MinecraftDownloadSource::Auto);
    let temp = tempfile::tempdir().unwrap();
    let store = ConfigStore::open(temp.path()).unwrap();
    for source in [
        MinecraftDownloadSource::Bmclapi,
        MinecraftDownloadSource::Official,
    ] {
        store
            .update(|settings| settings.minecraft_download_source = source)
            .unwrap();
        assert_eq!(
            ConfigStore::open(temp.path())
                .unwrap()
                .get()
                .minecraft_download_source,
            source
        );
    }
    assert!(
        serde_json::from_value::<Settings>(json!({"minecraftDownloadSource":"unknown"})).is_err()
    );
}

#[test]
fn bmclapi_maps_modern_legacy_library_and_asset_endpoints() {
    for (official, path) in [
        (MANIFEST, "/mc/game/version_manifest_v2.json"),
        (
            "https://piston-meta.mojang.com/v1/packages/hash/1.21.4.json",
            "/v1/packages/hash/1.21.4.json",
        ),
        (
            "https://piston-data.mojang.com/v1/objects/hash/client.jar",
            "/v1/objects/hash/client.jar",
        ),
        (
            "https://launchermeta.mojang.com/mc/game/version_manifest.json",
            "/mc/game/version_manifest.json",
        ),
        (
            "http://launcher.mojang.com/v1/objects/hash/client.jar",
            "/v1/objects/hash/client.jar",
        ),
        (
            "https://libraries.minecraft.net/org/example/lib.jar",
            "/maven/org/example/lib.jar",
        ),
        (
            "http://resources.download.minecraft.net/ab/abcdef",
            "/assets/ab/abcdef",
        ),
        (
            "https://piston-data.mojang.com/v1/objects/hash/client%20mappings.txt?key=a%2Fb#part",
            "/v1/objects/hash/client%20mappings.txt?key=a%2Fb#part",
        ),
    ] {
        assert_eq!(
            MinecraftDownloadSource::Bmclapi.url(official),
            format!("{BMCL}{path}")
        );
        assert_eq!(MinecraftDownloadSource::Official.url(official), official);
    }
    for unrelated in [
        "https://maven.fabricmc.net/net/fabricmc/loader.jar",
        "https://maven.minecraftforge.net/net/minecraftforge/forge.jar",
        "https://bmclapi2.bangbang93.com/maven/example.jar",
        "https://libraries.minecraft.net.example.org/example.jar",
        "https://example.org/download?url=https://piston-data.mojang.com/file",
        "file:///piston-meta.mojang.com/file",
        "",
    ] {
        assert_eq!(MinecraftDownloadSource::Bmclapi.url(unrelated), unrelated);
    }
}

#[tokio::test]
async fn installation_and_repair_resolution_use_selected_source_and_preserve_hashes() {
    let temp = tempfile::tempdir().unwrap();
    let hash = "abcdef0123456789abcdef0123456789abcdef01";
    let index = json!({"objects":{"test":{"hash":hash,"size":7}}}).to_string();
    let index_sha1 = hex::encode(Sha1::digest(index.as_bytes()));
    let requests = Arc::new(AtomicUsize::new(0));
    let index_requests = requests.clone();
    let index_response = index.clone();
    let app = axum::Router::new().route(
        "/index.json",
        axum::routing::get(move || {
            index_requests.fetch_add(1, Ordering::SeqCst);
            let index = index_response.clone();
            async move { index }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let index_url = format!("http://{}/index.json", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let settings = Arc::new(ConfigStore::open(&temp.path().join("config")).unwrap());
    let jobs = Arc::new(Jobs::default());
    let installer = Installer {
        downloads: DownloadManager::open(&temp.path().join("downloads"), 2).unwrap(),
        jobs: jobs.clone(),
        client: reqwest::Client::new(),
        settings: settings.clone(),
    };
    let version = json!({
        "id":"1.21.4",
        "downloads":{"client":{"url":"https://piston-data.mojang.com/v1/objects/hash/client.jar","sha1":hash,"size":7}},
        "libraries":[{"name":"org.example:lib:1","downloads":{"artifact":{"path":"org/example/lib/1/lib-1.jar","url":"https://libraries.minecraft.net/org/example/lib/1/lib-1.jar","sha1":hash,"size":7}}}],
        "logging":{"client":{"file":{"id":"client.xml","url":"https://launcher.mojang.com/v1/objects/hash/client.xml","sha1":hash,"size":7}}},
        "assetIndex":{"id":"test","url":index_url,"sha1":index_sha1.to_uppercase(),"sha512":hex::encode(sha2::Sha512::digest(index.as_bytes())),"size":index.len()}
    });
    let original = version.clone();
    for (source, kind) in [
        (MinecraftDownloadSource::Bmclapi, JobKind::Install),
        (MinecraftDownloadSource::Official, JobKind::Repair),
        (MinecraftDownloadSource::Auto, JobKind::Launch),
    ] {
        settings
            .update(|settings| settings.minecraft_download_source = source)
            .unwrap();
        let job = jobs.create(kind, "resolve test".into(), &["resolve"]);
        let files = installer
            .resolve_files(&temp.path().join("game"), &version, &job)
            .await
            .unwrap();
        assert_eq!(files.len(), 4);
        for (path, url) in [
            ("versions/1.21.4/1.21.4.jar", "https://piston-data.mojang.com/v1/objects/hash/client.jar"),
            ("libraries/org/example/lib/1/lib-1.jar", "https://libraries.minecraft.net/org/example/lib/1/lib-1.jar"),
            ("assets/log_configs/client.xml", "https://launcher.mojang.com/v1/objects/hash/client.xml"),
            ("assets/objects/ab/abcdef0123456789abcdef0123456789abcdef01", "https://resources.download.minecraft.net/ab/abcdef0123456789abcdef0123456789abcdef01"),
        ] {
            let file = files.iter().find(|file| file.path == path).unwrap();
            assert_eq!(file.url, source.url(url));
            assert_eq!(file.sha1.as_deref(), Some(hash));
            assert_eq!(file.size, Some(7));
        }
        assert_eq!(version, original);
        assert!(job.snapshot().download_id.is_none());
        assert!(installer.downloads.snapshots().await.is_empty());
        assert_eq!(
            std::fs::read_dir(temp.path().join("downloads"))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(
            std::fs::read(temp.path().join("game/assets/indexes/test.json")).unwrap(),
            index.as_bytes()
        );
    }
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn asset_index_refetches_invalid_cache_and_falls_back_without_download_records() {
    let temp = tempfile::tempdir().unwrap();
    let index = json!({"objects":{}}).to_string();
    let response = index.clone();
    let app = axum::Router::new()
        .route("/bad.json", axum::routing::get(|| async { "corrupt" }))
        .route(
            "/index.json",
            axum::routing::get(move || {
                let response = response.clone();
                async move { response }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let settings = Arc::new(ConfigStore::open(&temp.path().join("config")).unwrap());
    settings
        .update(|s| s.minecraft_download_source = MinecraftDownloadSource::Official)
        .unwrap();
    let installer = Installer {
        downloads: DownloadManager::open(&temp.path().join("downloads"), 2).unwrap(),
        jobs: Arc::new(Jobs::default()),
        client: reqwest::Client::new(),
        settings,
    };
    let root = temp.path().join("game");
    let cache = root.join("assets/indexes/test.json");
    std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
    std::fs::write(&cache, b"old corrupt cache").unwrap();
    let url = format!("{base}/index.json");
    installer
        .sources()
        .register(&url, vec![format!("{base}/bad.json"), url.clone()]);
    let version = json!({
        "id":"test",
        "assetIndex":{"id":"test","url":url,"sha1":hex::encode(Sha1::digest(index.as_bytes())),"size":index.len()}
    });
    let job = installer
        .jobs
        .create(JobKind::Repair, "resolve test".into(), &["resolve"]);
    assert!(installer
        .resolve_files(&root, &version, &job)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(std::fs::read(&cache).unwrap(), index.as_bytes());

    // Invalid network metadata must fail without replacing the installed index.
    for (key, value, expected) in [
        ("sha1", json!("0".repeat(40)), "SHA-1"),
        ("sha512", json!("0".repeat(128)), "SHA-512"),
        ("size", json!(index.len() + 1), "长度校验失败"),
    ] {
        let mut invalid = version.clone();
        invalid["assetIndex"][key] = value;
        let error = installer
            .resolve_files(&root, &invalid, &job)
            .await
            .unwrap_err();
        assert!(error.to_string().contains(expected), "{error:#}");
        assert_eq!(std::fs::read(&cache).unwrap(), index.as_bytes());
    }
    assert!(job.snapshot().download_id.is_none());
    assert!(installer.downloads.snapshots().await.is_empty());
    assert_eq!(
        std::fs::read_dir(temp.path().join("downloads"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(
        std::fs::read_dir(cache.parent().unwrap()).unwrap().count(),
        1
    );
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn cancelling_asset_index_requests_reports_the_workflow_without_download_tasks() {
    let temp = tempfile::tempdir().unwrap();
    let started = Arc::new(tokio::sync::Notify::new());
    let request_started = started.clone();
    let app = axum::Router::new().route(
        "/index.json",
        axum::routing::get(move || {
            request_started.notify_one();
            std::future::pending::<String>()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/index.json", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let installer = Arc::new(Installer {
        downloads: DownloadManager::open(&temp.path().join("downloads"), 2).unwrap(),
        jobs: Arc::new(Jobs::default()),
        client: reqwest::Client::new(),
        settings: Arc::new(ConfigStore::open(&temp.path().join("config")).unwrap()),
    });
    for (kind, expected) in [
        (JobKind::Install, "安装已取消"),
        (JobKind::Repair, "修复已取消"),
        (JobKind::Launch, "启动已取消"),
    ] {
        let job = installer
            .jobs
            .create(kind, "resolve test".into(), &["resolve"]);
        let resolver = installer.clone();
        let resolving_job = job.clone();
        let root = temp.path().join("game");
        let version = json!({"id":"test","assetIndex":{"id":"test","url":url}});
        let resolving = tokio::spawn(async move {
            resolver
                .resolve_files(&root, &version, &resolving_job)
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), started.notified())
            .await
            .unwrap();
        assert!(installer.downloads.snapshots().await.is_empty());
        assert!(job.snapshot().download_id.is_none());
        job.cancel.cancel();
        let error = tokio::time::timeout(std::time::Duration::from_secs(3), resolving)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error.to_string(), expected);
        assert!(!temp.path().join("game/assets/indexes/test.json").exists());
    }
    assert_eq!(
        std::fs::read_dir(temp.path().join("downloads"))
            .unwrap()
            .count(),
        0
    );
    server.abort();
    let _ = server.await;
}
