use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    routing::any,
    Router,
};
use sfmcl_t_core::{
    download_sources::{candidates, SourceSelector, MC_MIRROR},
    downloads::{DownloadManager, DownloadSpec, Status},
    minecraft::download_source::MinecraftDownloadSource,
};
use sha1::{Digest, Sha1};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

struct Server {
    url: String,
    requests: Arc<AtomicUsize>,
    probes: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
#[derive(Clone)]
struct ResponseState {
    bytes: Vec<u8>,
    delay: u64,
    api: bool,
    requests: Arc<AtomicUsize>,
    probes: Arc<AtomicUsize>,
}
impl Server {
    async fn start(bytes: &[u8], delay: u64) -> Self {
        Self::start_inner(bytes, delay, false).await
    }
    async fn start_inner(bytes: &[u8], delay: u64, api: bool) -> Self {
        let requests = Arc::new(AtomicUsize::new(0));
        let probes = Arc::new(AtomicUsize::new(0));
        let state = ResponseState {
            bytes: bytes.into(),
            delay,
            api,
            requests: requests.clone(),
            probes: probes.clone(),
        };
        let app = Router::new()
            .route(
                "/{*path}",
                any(
                    |State(state): State<ResponseState>,
                     method: Method,
                     headers: HeaderMap,
                     body: Bytes| async move {
                        state.requests.fetch_add(1, Ordering::SeqCst);
                        if state.api
                            && (method != Method::POST
                                || headers
                                    .get("x-api-key")
                                    .is_none_or(|key| key != "test-only-credential")
                                || body.as_ref() != br#"{"fingerprints":[123]}"#)
                        {
                            return (StatusCode::FORBIDDEN, vec![]);
                        }
                        if headers
                            .get("range")
                            .is_some_and(|value| value == "bytes=0-65535")
                        {
                            state.probes.fetch_add(1, Ordering::SeqCst);
                        }
                        tokio::time::sleep(Duration::from_millis(state.delay)).await;
                        (StatusCode::OK, state.bytes)
                    },
                ),
            )
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            url,
            requests,
            probes,
            task,
        }
    }
    fn file(&self, path: &str) -> String {
        format!("{}/{}", self.url, path)
    }
}

#[test]
fn mc_mirror_maps_files_without_using_reformatted_version_metadata() {
    for (original, path) in [
        (
            "https://libraries.minecraft.net/org/example/library.jar",
            "/libraries/org/example/library.jar",
        ),
        (
            "https://resources.download.minecraft.net/ab/abcdef",
            "/assets/objects/ab/abcdef",
        ),
        (
            "https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.14/a.jar",
            "/fabric/maven/net/fabricmc/fabric-loader/0.16.14/a.jar",
        ),
        (
            "https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-loader/0.26.4/a.jar",
            "/quilt/maven/org/quiltmc/quilt-loader/0.26.4/a.jar",
        ),
    ] {
        let mirror = format!("{MC_MIRROR}{path}");
        assert!(candidates(original).contains(&mirror), "{original}");
        assert!(candidates(&mirror).contains(&original.into()), "{mirror}");
    }
    for url in [
        sfmcl_t_core::minecraft::download_source::MANIFEST,
        "https://piston-meta.mojang.com/v1/packages/hash/1.20.1.json",
        "https://maven.quiltmc.org/repository/snapshot/org/quiltmc/a.jar",
        "https://us-west-01.mc-mirror.com.example.org/libraries/a.jar",
    ] {
        assert!(candidates(url)
            .iter()
            .all(|url| !url.starts_with(MC_MIRROR) || url.contains(".example.org")));
    }
}

#[tokio::test]
async fn mc_mirror_registration_supports_renamed_versions_repair_and_source_modes() {
    let sources = SourceSelector::default();
    let version = serde_json::json!({
        "id": "My Fabric", "jar": "My Fabric", "clientVersion": "1.20.1",
        "downloads": {"client": {"url": "https://piston-data.mojang.com/v1/objects/hash/client.jar", "sha1": "official-hash"}},
        "assetIndex": {"id": "5", "url": "https://piston-meta.mojang.com/v1/packages/hash/5.json"},
        "logging": {"client": {"file": {"id": "client.xml", "url": "https://launcher.mojang.com/v1/objects/hash/client.xml"}}},
    });
    let original = version.clone();
    sources.register_minecraft(&version);
    for (official, path) in [
        (
            version["downloads"]["client"]["url"].as_str().unwrap(),
            "/versions/1.20.1/client.jar",
        ),
        (
            version["assetIndex"]["url"].as_str().unwrap(),
            "/assets/indexes/5.json",
        ),
        (
            version["logging"]["client"]["file"]["url"]
                .as_str()
                .unwrap(),
            "/logging/client.xml",
        ),
    ] {
        let urls = sources.candidates(official);
        assert_eq!(urls[0], official);
        assert!(urls.contains(&format!("{MC_MIRROR}{path}")));
        for alias in &urls {
            assert_eq!(sources.candidates(alias), urls);
        }
    }
    assert_eq!(version, original);
    let official = version["downloads"]["client"]["url"].as_str().unwrap();
    let mirror = format!("{MC_MIRROR}/versions/1.20.1/client.jar");
    let urls = vec![official.into(), mirror.clone()];
    let client = reqwest::Client::new();
    let cancel = CancellationToken::new();
    sources.set_mode(MinecraftDownloadSource::Official);
    assert_eq!(
        sources.order(&client, &urls, &cancel).await.unwrap()[0],
        official
    );
    sources.set_mode(MinecraftDownloadSource::Bmclapi);
    assert_eq!(
        sources.order(&client, &urls, &cancel).await.unwrap()[0],
        mirror
    );
    let external = "http://127.0.0.1/index.json";
    let external_version =
        serde_json::json!({"id": "1.20.1", "assetIndex": {"id":"5", "url":external}});
    sources.register_minecraft(&external_version);
    assert_eq!(sources.candidates(external), vec![external.to_string()]);
}

#[test]
fn maps_supported_sources_without_rewriting_unrelated_urls() {
    for (official, expected) in [
        (
            "https://maven.minecraftforge.net/net/minecraftforge/forge/1/forge.jar",
            "https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/1/forge.jar",
        ),
        (
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.1/neoforge.jar",
            "https://neoforged.forgecdn.net/releases/net/neoforged/neoforge/21.1.1/neoforge.jar",
        ),
        (
            "https://meta.fabricmc.net/v2/versions/loader/1.21.4",
            "https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/1.21.4",
        ),
        (
            "https://maven.fabricmc.net/net/fabricmc/fabric-loader/1/a.jar",
            "https://bmclapi2.bangbang93.com/maven/net/fabricmc/fabric-loader/1/a.jar",
        ),
        (
            "https://repo.maven.apache.org/maven2/org/ow2/asm/asm.jar",
            "https://mirrors.cloud.tencent.com/nexus/repository/maven-public/org/ow2/asm/asm.jar",
        ),
        (
            "https://api.modrinth.com/v2/search?query=test%20mod",
            "https://mod.mcimirror.top/modrinth/v2/search?query=test%20mod",
        ),
        (
            "https://api.curseforge.com/v1/mods/1/files",
            "https://mod.mcimirror.top/curseforge/v1/mods/1/files",
        ),
        (
            "https://cdn.modrinth.com/data/a/versions/b/mod.jar",
            "https://mod.mcimirror.top/data/a/versions/b/mod.jar",
        ),
        (
            "https://edge.forgecdn.net/files/1/2/mod.jar",
            "https://mod.mcimirror.top/files/1/2/mod.jar",
        ),
    ] {
        let urls = candidates(official);
        assert_eq!(urls[0], official);
        assert!(urls.contains(&expected.to_string()), "{official}: {urls:?}");
        assert!(
            candidates(expected).contains(&official.to_string()),
            "reverse: {expected}"
        );
    }
    for url in [
        "https://meta.quiltmc.org/v3/versions/loader/1.21.4",
        "https://mediafilez.forgecdn.net/files/1/2/mod.jar",
        "https://api.curseforge.com.example.org/v1/mods",
        "https://user:secret@api.curseforge.com/v1/mods",
        "https://api.curseforge.com:444/v1/mods",
    ] {
        assert_eq!(candidates(url), vec![url.to_string()]);
    }
}

#[tokio::test]
async fn picks_fastest_source_caches_probes_and_shares_concurrent_measurements() {
    let slow = Server::start(br#"{"ok":true}"#, 100).await;
    let fast = Server::start(br#"{"ok":true}"#, 5).await;
    let sources = Arc::new(SourceSelector::default());
    let urls = vec![slow.file("first"), fast.file("first")];
    let client = reqwest::Client::new();
    let cancel = CancellationToken::new();
    let (one, two) = tokio::join!(
        sources.order(&client, &urls, &cancel),
        sources.order(&client, &urls, &cancel)
    );
    assert_eq!(one.unwrap()[0], fast.file("first"));
    assert_eq!(two.unwrap()[0], fast.file("first"));
    let ordered = sources
        .order(
            &client,
            &[slow.file("second"), fast.file("second")],
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(ordered[0], fast.file("second"));
    assert_eq!(slow.probes.load(Ordering::SeqCst), 1);
    assert_eq!(fast.probes.load(Ordering::SeqCst), 1);
    sources.set_mode(MinecraftDownloadSource::Official);
    assert_eq!(sources.order(&client, &urls, &cancel).await.unwrap(), urls);
}

#[tokio::test]
async fn ranks_authenticated_post_apis_using_their_real_method_and_payload() {
    let slow = Server::start_inner(br#"{"ok":true}"#, 100, true).await;
    let fast = Server::start_inner(br#"{"ok":true}"#, 5, true).await;
    let client = reqwest::Client::new();
    let sources = SourceSelector::default();
    let urls = vec![slow.file("fingerprints"), fast.file("fingerprints")];
    let ordered = sources
        .order_with(&urls, &CancellationToken::new(), |url| {
            Ok(client
                .post(url)
                .header("x-api-key", "test-only-credential")
                .json(&serde_json::json!({"fingerprints":[123]})))
        })
        .await
        .unwrap();
    assert_eq!(ordered[0], fast.file("fingerprints"));
    assert_eq!(slow.probes.load(Ordering::SeqCst), 1);
    assert_eq!(fast.probes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn malformed_fast_metadata_falls_back_and_does_not_poison_following_requests() {
    let fast = Server::start(b"not json", 5).await;
    let good = Server::start(br#"{"ok":true}"#, 60).await;
    let sources = SourceSelector::default();
    let client = reqwest::Client::new();
    let cancel = CancellationToken::new();
    let urls = vec![fast.file("a"), good.file("a")];
    let value: serde_json::Value = sources
        .fetch(&client, &urls, &cancel, |bytes| {
            Ok(serde_json::from_slice(bytes)?)
        })
        .await
        .unwrap();
    assert_eq!(value["ok"], true);
    let previous = fast.requests.load(Ordering::SeqCst);
    let _: serde_json::Value = sources
        .fetch(&client, &urls, &cancel, |bytes| {
            Ok(serde_json::from_slice(bytes)?)
        })
        .await
        .unwrap();
    assert_eq!(fast.requests.load(Ordering::SeqCst), previous);
}

#[tokio::test]
async fn corrupted_download_switches_sources_and_keeps_hash_validation() {
    let fast = Server::start(b"corrupt", 5).await;
    let good = Server::start(b"correct", 60).await;
    let temp = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&temp.path().join("state"), 2).unwrap();
    manager
        .sources()
        .set_mode(MinecraftDownloadSource::Official);
    let url = fast.file("client");
    manager
        .sources()
        .register(&url, vec![url.clone(), good.file("client")]);
    let id = manager
        .enqueue(
            "fallback".into(),
            temp.path().join("game"),
            vec![DownloadSpec {
                url,
                path: "client.bin".into(),
                size: Some(7),
                sha1: Some(hex::encode(Sha1::digest(b"correct"))),
                sha512: None,
            }],
        )
        .await
        .unwrap();
    let snapshot = manager.wait(&id, &CancellationToken::new()).await.unwrap();
    assert_eq!(snapshot.status, Status::Completed);
    assert_eq!(snapshot.files[0].attempts, 2);
    assert_eq!(
        std::fs::read(temp.path().join("game/client.bin")).unwrap(),
        b"correct"
    );
}

#[tokio::test]
async fn invalid_unhashed_installer_falls_back_to_a_valid_jar() {
    use std::io::{Cursor, Write};
    let mut jar = zip::ZipWriter::new(Cursor::new(Vec::new()));
    jar.start_file(
        "META-INF/MANIFEST.MF",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    jar.write_all(b"Manifest-Version: 1.0\n").unwrap();
    let bytes = jar.finish().unwrap().into_inner();
    let fast = Server::start(b"<html>upstream error</html>", 5).await;
    let good = Server::start(&bytes, 60).await;
    let temp = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&temp.path().join("state"), 1).unwrap();
    manager
        .sources()
        .set_mode(MinecraftDownloadSource::Official);
    let url = fast.file("installer");
    manager
        .sources()
        .register(&url, vec![url.clone(), good.file("installer")]);
    let id = manager
        .enqueue(
            "installer fallback".into(),
            temp.path().join("game"),
            vec![DownloadSpec {
                url,
                path: "Forge-installer.jar".into(),
                size: None,
                sha1: None,
                sha512: None,
            }],
        )
        .await
        .unwrap();
    let snapshot = manager.wait(&id, &CancellationToken::new()).await.unwrap();
    assert_eq!(snapshot.status, Status::Completed);
    assert_eq!(snapshot.files[0].attempts, 2);
    assert_eq!(
        std::fs::read(temp.path().join("game/Forge-installer.jar")).unwrap(),
        bytes
    );
}

#[tokio::test]
async fn cancellation_interrupts_speed_probes() {
    let one = Server::start(b"slow", 3000).await;
    let two = Server::start(b"slow", 3000).await;
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        stop.cancel();
    });
    let start = Instant::now();
    assert!(SourceSelector::default()
        .order(
            &reqwest::Client::new(),
            &[one.file("a"), two.file("a")],
            &cancel
        )
        .await
        .is_err());
    assert!(start.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
#[ignore = "downloads MC Mirror files with official hashes and rejects stale resource indexes"]
async fn live_mc_mirror_vanilla_files_pass_official_hashes() {
    use sfmcl_t_core::{
        config::ConfigStore,
        jobs::{JobKind, Jobs},
        minecraft::{installer::Installer, versions::spec},
    };
    let temp = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&temp.path().join("downloads"), 3).unwrap();
    let sources = manager.sources();
    let jobs = Arc::new(Jobs::default());
    let client = sfmcl_t_core::http_client().unwrap();
    let installer = Installer {
        downloads: manager.clone(),
        jobs: jobs.clone(),
        client: client.clone(),
        settings: Arc::new(ConfigStore::open(&temp.path().join("config")).unwrap()),
    };
    let job = jobs.create(JobKind::Repair, "MC Mirror smoke".into(), &["verify"]);
    let version = installer.base_version("1.20.1", &job).await.unwrap();
    let cancel = CancellationToken::new();
    let index = &version["assetIndex"];
    let mirror_for = |url: &str| {
        sources
            .candidates(url)
            .into_iter()
            .find(|url| url.starts_with(MC_MIRROR))
            .unwrap()
    };
    sources.set_mode(MinecraftDownloadSource::Official);
    let mut indexes = vec![mirror_for(index["url"].as_str().unwrap())];
    indexes.extend(sources.candidates(index["url"].as_str().unwrap()));
    let rejected_indexes = AtomicUsize::new(0);
    let assets: serde_json::Value = sources
        .fetch(&client, &indexes, &cancel, |bytes| {
            if hex::encode(Sha1::digest(bytes)) != index["sha1"].as_str().unwrap() {
                rejected_indexes.fetch_add(1, Ordering::SeqCst);
                anyhow::bail!("index hash mismatch");
            }
            Ok(serde_json::from_slice(bytes)?)
        })
        .await
        .unwrap();
    println!(
        "Resource index passed official SHA-1 after rejecting {} stale responses",
        rejected_indexes.load(Ordering::SeqCst)
    );
    let client_file = &version["downloads"]["client"];
    let logging = &version["logging"]["client"]["file"];
    let library = version["libraries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|library| &library["downloads"]["artifact"])
        .find(|artifact| {
            artifact["size"]
                .as_u64()
                .is_some_and(|size| size > 0 && size <= 262144)
        })
        .unwrap();
    let object = assets["objects"]
        .as_object()
        .unwrap()
        .values()
        .find(|object| {
            object["size"]
                .as_u64()
                .is_some_and(|size| (4096..=65536).contains(&size))
        })
        .unwrap();
    let hash = object["hash"].as_str().unwrap();
    let mut files = vec![
        spec(
            client_file,
            "client.jar".into(),
            mirror_for(client_file["url"].as_str().unwrap()),
        ),
        spec(
            logging,
            "logging.xml".into(),
            mirror_for(logging["url"].as_str().unwrap()),
        ),
        spec(
            library,
            "library.jar".into(),
            mirror_for(library["url"].as_str().unwrap()),
        ),
        sfmcl_t_core::downloads::DownloadSpec {
            path: "asset.bin".into(),
            url: format!("{MC_MIRROR}/assets/objects/{}/{hash}", &hash[..2]),
            size: object["size"].as_u64(),
            sha1: Some(hash.into()),
            sha512: None,
        },
    ];
    sources.set_mode(MinecraftDownloadSource::Official);
    for file in &mut files {
        assert!(file.sha1.is_some());
        sources.register(&file.url, vec![file.url.clone()]);
        println!("{}: {}", file.path, file.url);
    }
    let id = manager
        .enqueue(
            "MC Mirror vanilla smoke".into(),
            temp.path().join("game"),
            files,
        )
        .await
        .unwrap();
    let snapshot = manager.wait(&id, &cancel).await.unwrap();
    assert_eq!(snapshot.status, Status::Completed, "{:?}", snapshot.files);
    println!(
        "MC Mirror client, library, asset and logging passed official SHA-1; resource index used verified fallback"
    );
}

#[tokio::test]
#[ignore = "queries public upstream catalogs and downloads hashed Minecraft files"]
async fn live_catalogs_and_hashed_minecraft_files_use_available_sources() {
    use futures_util::{stream, StreamExt};
    use sfmcl_t_core::{
        config::ConfigStore,
        jobs::{JobKind, Jobs},
        minecraft::{installer::Installer, loaders},
    };
    let temp = tempfile::tempdir().unwrap();
    let manager = DownloadManager::open(&temp.path().join("downloads"), 3).unwrap();
    let sources = manager.sources();
    let client = sfmcl_t_core::http_client().unwrap();
    let catalogs = stream::iter([
        ("Forge", "1.20.1"),
        ("NeoForge", "1.21.1"),
        ("Fabric", "1.21.4"),
        ("Quilt", "1.21.4"),
        ("OptiFine", "1.20.1"),
        ("LiteLoader", "1.12.2"),
    ])
    .map(|(kind, minecraft)| {
        let client = &client;
        let sources = &sources;
        async move {
            (
                kind,
                loaders::catalog_with_sources(client, sources, minecraft, kind).await,
            )
        }
    })
    .buffer_unordered(4)
    .collect::<Vec<_>>()
    .await;
    for (kind, result) in catalogs {
        let choices = result.unwrap_or_else(|error| panic!("{kind}: {error:#}"));
        assert!(!choices.is_empty(), "{kind}: empty catalog");
        println!("{kind}: {} choices", choices.len());
    }
    let jobs = Arc::new(Jobs::default());
    let installer = Installer {
        downloads: manager.clone(),
        jobs: jobs.clone(),
        client: client.clone(),
        settings: Arc::new(ConfigStore::open(&temp.path().join("config")).unwrap()),
    };
    let job = jobs.create(JobKind::Repair, "source smoke".into(), &["verify"]);
    let version = installer.base_version("1.21.4", &job).await.unwrap();
    let index = &version["assetIndex"];
    let cancel = CancellationToken::new();
    let assets: serde_json::Value = sources
        .fetch(
            &client,
            &sources.candidates(index["url"].as_str().unwrap()),
            &cancel,
            |bytes| {
                anyhow::ensure!(
                    hex::encode(Sha1::digest(bytes)) == index["sha1"].as_str().unwrap(),
                    "asset index hash mismatch"
                );
                Ok(serde_json::from_slice(bytes)?)
            },
        )
        .await
        .unwrap();
    let artifact = version["libraries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|library| &library["downloads"]["artifact"])
        .find(|artifact| {
            artifact["size"]
                .as_u64()
                .is_some_and(|size| size > 0 && size <= 262144)
        })
        .unwrap();
    let object = assets["objects"]
        .as_object()
        .unwrap()
        .values()
        .find(|object| {
            object["size"]
                .as_u64()
                .is_some_and(|size| (4096..=65536).contains(&size))
        })
        .unwrap();
    let hash = object["hash"].as_str().unwrap();
    let files = vec![
        DownloadSpec {
            path: "library.jar".into(),
            url: artifact["url"].as_str().unwrap().into(),
            size: artifact["size"].as_u64(),
            sha1: artifact["sha1"].as_str().map(str::to_owned),
            sha512: None,
        },
        DownloadSpec {
            path: "asset.bin".into(),
            url: format!(
                "https://resources.download.minecraft.net/{}/{hash}",
                &hash[..2]
            ),
            size: object["size"].as_u64(),
            sha1: Some(hash.into()),
            sha512: None,
        },
    ];
    for file in &files {
        let ordered = sources
            .order(&client, &sources.candidates(&file.url), &cancel)
            .await
            .unwrap();
        println!("{}: preferred {}", file.path, ordered[0]);
    }
    let id = manager
        .enqueue("source smoke".into(), temp.path().join("game"), files)
        .await
        .unwrap();
    let snapshot = manager.wait(&id, &cancel).await.unwrap();
    assert_eq!(snapshot.status, Status::Completed, "{:?}", snapshot.files);
    println!("Minecraft 1.21.4 metadata, asset index, library and asset passed SHA-1 checks");
}
