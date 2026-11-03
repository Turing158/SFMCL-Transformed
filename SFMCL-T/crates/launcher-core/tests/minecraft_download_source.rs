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
use std::sync::Arc;

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
    let app = axum::Router::new().route(
        "/index.json",
        axum::routing::get(move || {
            let index = index.clone();
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
        "assetIndex":{"id":"test","url":index_url,"sha1":index_sha1}
    });
    let original = version.clone();
    for source in [
        MinecraftDownloadSource::Bmclapi,
        MinecraftDownloadSource::Official,
    ] {
        settings
            .update(|settings| settings.minecraft_download_source = source)
            .unwrap();
        let job = jobs.create(JobKind::Repair, "resolve test".into(), &["resolve"]);
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
    }
    server.abort();
}
