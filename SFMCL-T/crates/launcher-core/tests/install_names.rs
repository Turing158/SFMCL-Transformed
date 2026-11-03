use axum::{routing::get, Json, Router};
use serde_json::{json, Value};
use sfmcl_t_core::{
    config::ConfigStore,
    downloads::{DownloadManager, Status},
    jobs::Jobs,
    minecraft::{
        download_source::MinecraftDownloadSource,
        installer::{InstallRequest, Installer, MANIFEST},
        versions,
    },
};
use sha1::{Digest, Sha1};
use std::{sync::Arc, time::Duration};

#[tokio::test]
async fn installation_uses_the_selected_name_for_files_profiles_and_tasks() {
    // Exercise the shared installation pipeline with local metadata and client
    // bytes. Loader-specific installation is covered by its own tests.
    let client_bytes = b"installation name fixture";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server_url = format!("http://{}", listener.local_addr().unwrap());
    let manifest = json!({"versions": [{
        "id": "1.20.1", "url": format!("{server_url}/version"),
    }]});
    let version = json!({
        "id": "1.20.1", "mainClass": "fixture.Main", "libraries": [],
        "downloads": {"client": {
            "url": format!("{server_url}/client.jar"),
            "size": client_bytes.len(), "sha1": hex::encode(Sha1::digest(client_bytes)),
        }},
    });
    let app = Router::new()
        .route(
            "/manifest",
            get(move || {
                let manifest = manifest.clone();
                async move { Json(manifest) }
            }),
        )
        .route(
            "/version",
            get(move || {
                let version = version.clone();
                async move { Json(version) }
            }),
        )
        .route(
            "/client.jar",
            get(move || async move { client_bytes.as_slice() }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("game");
    let downloads = DownloadManager::open(&temp.path().join("downloads"), 2).unwrap();
    downloads
        .sources()
        .register(MANIFEST, vec![format!("{server_url}/manifest")]);
    let settings = Arc::new(ConfigStore::open(&temp.path().join("config")).unwrap());
    settings
        .update(|settings| settings.minecraft_download_source = MinecraftDownloadSource::Official)
        .unwrap();
    let installer = Arc::new(Installer {
        downloads,
        jobs: Arc::new(Jobs::default()),
        client: reqwest::Client::new(),
        settings,
    });
    for name in [
        "1.20.1-forge-47.2.18",
        "1.20.1-neoforge-47.1.105",
        "1.20.1-fabric-0.16.10",
        "1.20.1-quilt-0.27.0",
        "1.20.1-optifine_1.20.1_HD_U_I6",
        "我的 Fabric",
    ] {
        let id = installer
            .start(InstallRequest {
                minecraft: "1.20.1".into(),
                name: name.into(),
                root: root.clone(),
                loader: None,
                optifine: None,
                fabric_api: None,
            })
            .await
            .unwrap();
        let job = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let job = installer
                    .jobs
                    .snapshots()
                    .into_iter()
                    .find(|job| job.id == id)
                    .unwrap();
                if job.status.terminal() {
                    break job;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(job.status, Status::Completed, "{name}: {:?}", job.error);
        assert_eq!(job.title, format!("安装 {name}"));
        let directory = root.join("versions").join(name);
        assert_eq!(
            std::fs::read(directory.join(format!("{name}.jar"))).unwrap(),
            client_bytes
        );
        let profile: Value =
            serde_json::from_slice(&std::fs::read(directory.join(format!("{name}.json"))).unwrap())
                .unwrap();
        assert_eq!(profile["id"], name);
        assert_eq!(profile["jar"], name);
        assert_eq!(profile["clientVersion"], "1.20.1");
        assert!(versions::scan(&root)
            .unwrap()
            .iter()
            .any(|version| version.id == name));
        assert!(installer.downloads.snapshots().await.iter().any(|task| {
            task.title == format!("{name} · 游戏文件") && task.status == Status::Completed
        }));
    }
    assert!(!root.join("versions/1.20.1").exists());
    server.abort();
}
