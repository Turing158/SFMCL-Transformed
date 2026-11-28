use super::{manager, minecraft_fixture};
use crate::multiplayer::{
    components, engine, minecraft, owned_process::OwnedProcess, terracotta, Multiplayer, Snapshot,
};
use serde_json::{json, Value};
use std::{
    net::Ipv4Addr,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::time::{sleep, timeout};

#[test]
#[ignore = "subprocess for the Terracotta job lifetime regression"]
fn terracotta_crash_helper() {
    let Some(directory) = std::env::var_os("SFMCL_T_TERRACOTTA_CRASH_DIR") else {
        return;
    };
    let directory = PathBuf::from(directory);
    let exe = PathBuf::from(std::env::var_os("SFMCL_T_TERRACOTTA_EXE").unwrap());
    let _job =
        OwnedProcess::spawn_terracotta(&exe, &directory, &directory.join("port.json")).unwrap();
    std::thread::sleep(Duration::from_secs(75));
}

async fn assert_worker_dies_with_owner(exe: &Path, temp: &Path) {
    let directory = temp.join("crash");
    std::fs::create_dir(&directory).unwrap();
    let mut helper = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "multiplayer::integration_tests::terracotta_native::terracotta_crash_helper",
        ])
        .env("SFMCL_T_TERRACOTTA_EXE", exe)
        .env("SFMCL_T_TERRACOTTA_CRASH_DIR", &directory)
        .creation_flags(0x08000000)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let port = wait_port(&directory.join("port.json")).await;
    let address = (Ipv4Addr::LOCALHOST, port);
    assert!(tokio::net::TcpStream::connect(address).await.is_ok());
    helper.kill().await.unwrap();
    timeout(Duration::from_secs(5), async {
        while tokio::net::TcpStream::connect(address).await.is_ok() {
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("Terracotta worker outlived its owning job");
}

async fn wait(manager: &Multiplayer, test: impl Fn(&Snapshot) -> bool) -> Snapshot {
    timeout(Duration::from_secs(55), async {
        loop {
            let s = manager.snapshot();
            if test(&s) {
                return s;
            }
            assert_ne!(s.state, "failed", "{:?}", s.error);
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        let s = manager.snapshot();
        panic!(
            "Terracotta state timed out: state={}, phase={:?}, error={:?}",
            s.state, s.terracotta_phase, s.error
        )
    })
}

async fn broadcast_world(port: u16) -> tokio::task::JoinHandle<()> {
    let udp = tokio::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .await
        .unwrap();
    udp.set_multicast_ttl_v4(0).unwrap();
    udp.set_multicast_loop_v4(true).unwrap();
    tokio::spawn(async move {
        let data = format!("[MOTD]SFMCL integration test[/MOTD][AD]{port}[/AD]");
        loop {
            udp.send_to(data.as_bytes(), (Ipv4Addr::new(224, 0, 2, 60), 4445))
                .await
                .unwrap();
            sleep(Duration::from_millis(250)).await;
        }
    })
}

async fn wait_port(path: &Path) -> u16 {
    timeout(Duration::from_secs(20), async {
        loop {
            if let Ok(bytes) = std::fs::read(path) {
                return serde_json::from_slice::<Value>(&bytes).unwrap()["port"]
                    .as_u64()
                    .unwrap() as u16;
            }
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap()
}

struct Independent {
    process: OwnedProcess,
    client: reqwest::Client,
    url: String,
}
impl Independent {
    async fn start(exe: &Path, temp: &Path) -> Self {
        let external_dir = temp.join("independent");
        std::fs::create_dir(&external_dir).unwrap();
        let port_file = external_dir.join("handshake.json");
        let independent = OwnedProcess::spawn_terracotta(exe, &external_dir, &port_file).unwrap();
        let external_port = wait_port(&port_file).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let external_url = format!("http://127.0.0.1:{external_port}");
        assert!(independent.owns_listener(external_port).unwrap());

        Self {
            process: independent,
            client,
            url: external_url,
        }
    }
    async fn state(&self) -> Value {
        self.client
            .get(format!("{}/state", self.url))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn command(&self, command: &str, pairs: &[(&str, &str)]) {
        let response = self
            .client
            .get(format!("{}/state/{command}", self.url))
            .query(pairs)
            .send()
            .await
            .map_err(|e| e.without_url())
            .unwrap();
        assert!(response.status().is_success());
    }
    async fn until(&self, expected: &str) -> Value {
        timeout(Duration::from_secs(65), async {
            loop {
                let s = self.state().await;
                if s["state"] == expected {
                    return s;
                }
                assert_ne!(
                    s["state"], "exception",
                    "upstream failure type {}",
                    s["type"]
                );
                sleep(Duration::from_millis(250)).await;
            }
        })
        .await
        .unwrap()
    }
}

async fn setup() -> (tempfile::TempDir, std::sync::Arc<Multiplayer>, PathBuf) {
    let archive = PathBuf::from(std::env::var_os("SFMCL_T_TERRACOTTA_PACKAGE").unwrap());
    let temp = tempfile::Builder::new()
        .prefix("native-")
        .tempdir_in(archive.parent().unwrap())
        .unwrap();
    let root = temp.path().join("launcher");
    let mp = manager(&root);
    mp.prepare_terracotta(Some(archive.clone())).unwrap();
    wait(&mp, |s| s.session_id.is_none() && s.terracotta_ready).await;
    let release = terracotta::component::release().unwrap();
    let base = format!("terracotta-0.4.2-windows-{}", release.arch);
    let exe = root.join(&base).join(format!("{base}.exe"));

    (temp, mp, exe)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "downloads the pinned native package through the launcher download manager"]
async fn live_terracotta_download_and_offline_reuse() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let downloads = crate::downloads::DownloadManager::open(&root.join("downloads"), 2).unwrap();
    let jobs = std::sync::Arc::new(crate::jobs::Jobs::default());
    let mp = Multiplayer::new(root.into(), downloads.clone(), jobs.clone());
    let create = || {
        mp.terracotta_room(Default::default(), true, None, String::new())
            .unwrap()
    };

    let first = create();
    assert!(first.component_job_id.is_none());
    let acquiring = wait(&mp, |s| s.component_job_id.is_some()).await;
    assert_eq!(acquiring.state, "preparing");
    let job_id = acquiring.component_job_id.unwrap();
    wait(&mp, |s| s.terracotta_phase.is_some()).await;
    mp.leave(first.session_id.as_deref()).await.unwrap();
    let histories = jobs.snapshots();
    assert_eq!(histories.len(), 1);
    assert_eq!(histories[0].id, job_id);
    assert_eq!(histories[0].status, crate::downloads::Status::Completed);
    assert_eq!(downloads.snapshots().await.len(), 1);

    let second = create();
    assert_eq!(second.state, "connecting");
    assert!(second.component_job_id.is_none());
    wait(&mp, |s| s.terracotta_phase.is_some()).await;
    mp.leave(second.session_id.as_deref()).await.unwrap();
    assert_eq!(jobs.snapshots().len(), 1);
    assert_eq!(downloads.snapshots().await.len(), 1);

    // Change the files after readiness was cached. A repair must still be cancellable.
    let exe = terracotta::component::release()
        .unwrap()
        .verified_executable(root)
        .unwrap();
    std::fs::remove_file(exe.with_file_name("VCRUNTIME140.DLL")).unwrap();
    create();
    let repair = wait(&mp, |s| s.component_job_id.is_some()).await;
    assert!(!repair.terracotta_ready);
    jobs.cancel(repair.component_job_id.as_deref().unwrap())
        .unwrap();
    wait(&mp, |s| s.session_id.is_none()).await;
    let histories = jobs.snapshots();
    assert_eq!(histories.len(), 2);
    assert_eq!(histories[0].status, crate::downloads::Status::Cancelled);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires SFMCL_T_TERRACOTTA_PACKAGE pointing to the pinned native tar.gz"]
async fn real_terracotta_package_isolation_scan_and_shutdown() {
    let (temp, mp, exe) = setup().await;
    let root = temp.path().join("launcher");
    let independent = Independent::start(&exe, temp.path()).await;
    let (port, game) = minecraft_fixture().await;
    independent.command("scanning", &[]).await;
    let first_broadcast = broadcast_world(port).await;
    independent.until("host-ok").await;
    first_broadcast.abort();
    let corrupt = temp.path().join("broken.tar.gz");
    std::fs::write(&corrupt, b"corrupt").unwrap();
    mp.prepare_terracotta(Some(corrupt)).unwrap();
    wait(&mp, |s| s.state == "failed" && s.terracotta_ready).await;
    assert!(manager(&root).snapshot().terracotta_ready);
    let create = || {
        mp.terracotta_room(
            Default::default(),
            true,
            Some("Test Host".into()),
            String::new(),
        )
        .unwrap()
        .session_id
        .unwrap()
    };
    let first = create();
    assert!(mp.prepare(None, false).is_err() && mp.begin_maintenance().is_err());
    assert!(manager(&root).prepare_terracotta(None).is_err());
    wait(&mp, |s| {
        s.terracotta_phase.as_deref() == Some("host-scanning")
    })
    .await;
    mp.leave(Some(&first)).await.unwrap();
    assert!(!mp.active() && mp.invitation(&first).is_err());
    let second = create();
    wait(&mp, |s| {
        s.terracotta_phase.as_deref() == Some("host-scanning")
    })
    .await;
    mp.leave(Some(&first)).await.unwrap();
    assert_eq!(mp.snapshot().session_id.as_deref(), Some(second.as_str()));

    let broadcaster = broadcast_world(port).await;
    let ready = wait(&mp, |s| s.world_open).await;
    assert!(ready
        .members
        .iter()
        .any(|m| m.name == "Test Host" && m.local));
    assert!(mp.invitation(&second).unwrap().starts_with("U/"));
    assert!(mp.launch_target(&second).is_err());
    broadcaster.abort();
    mp.shutdown().await.unwrap();
    assert!(mp.invitation(&second).is_err() && !mp.active());
    assert!(minecraft::ping((Ipv4Addr::LOCALHOST, port).into())
        .await
        .is_ok());
    assert_eq!(independent.state().await["state"], "host-ok");
    assert!(std::fs::read_dir(&root).unwrap().all(|e| !e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("terracotta-run-")));

    assert_worker_dies_with_owner(&exe, temp.path()).await;
    assert_eq!(independent.state().await["state"], "host-ok");
    independent.process.stop().unwrap();
    game.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires pinned Terracotta and x64 EasyTier packages for the local rendezvous node"]
async fn real_terracotta_bidirectional_local_game_status() {
    let (temp, mp, exe) = setup().await;
    let independent = Independent::start(&exe, temp.path()).await;
    let relay_dir = temp.path().join("rendezvous");
    let archive = PathBuf::from(std::env::var_os("SFMCL_EASYTIER_ZIP").unwrap());
    let files = components::install_archive(
        &relay_dir,
        &archive,
        &components::release_for("x86_64").unwrap(),
    )
    .unwrap();
    let port = engine::free_port().unwrap();
    let node = format!("tcp://127.0.0.1:{port}");
    let config = format!(
        r#"listeners = ["{node}"]
[network_identity]
network_name = "local-test-node"
network_secret = "local-test-node"
[flags]
no_tun = true
bind_device = false
disable_upnp = true
accept_dns = false
"#
    );
    let _relay = engine::Engine::start(files, &config).unwrap();
    let (world, game) = minecraft_fixture().await;
    let broadcaster = broadcast_world(world).await;

    // SFMCL-T hosts and the standalone binary joins the exported room.
    let create = serde_json::from_value(json!({"publicNodes":[node]})).unwrap();
    let host = mp
        .terracotta_room(create, true, Some("LauncherHost".into()), String::new())
        .unwrap()
        .session_id
        .unwrap();
    wait(&mp, |s| s.world_open).await;
    let code = mp.invitation(&host).unwrap();
    independent
        .command(
            "guesting",
            &[
                ("room", &code),
                ("player", "IndependentGuest"),
                ("public_nodes", &node),
            ],
        )
        .await;
    let guest = independent.until("guest-ok").await;
    let address = guest["url"].as_str().unwrap();
    let address = if address == "127.0.0.1" {
        (Ipv4Addr::LOCALHOST, 25565).into()
    } else {
        address.parse().unwrap()
    };
    assert!(minecraft::ping(address).await.is_ok());
    wait(&mp, |s| {
        s.members.iter().any(|m| m.name == "IndependentGuest")
    })
    .await;
    independent.command("ide", &[]).await;
    mp.leave(Some(&host)).await.unwrap();

    // Reverse direction. Verify that the captured launch target is revoked on leave.
    independent
        .command(
            "scanning",
            &[("player", "IndependentHost"), ("public_nodes", &node)],
        )
        .await;
    let hosted = independent.until("host-ok").await;
    let join =
        serde_json::from_value(json!({"invitation":hosted["room"],"publicNodes":[node]})).unwrap();
    let guest = mp
        .terracotta_room(join, false, Some("LauncherGuest".into()), String::new())
        .unwrap()
        .session_id
        .unwrap();
    wait(&mp, |s| {
        s.world_open && s.members.iter().any(|m| m.name == "IndependentHost")
    })
    .await;
    assert!(mp.invitation(&guest).is_err());
    let target = mp.launch_target(&guest).unwrap();
    target.validate().await.unwrap();
    mp.leave(Some(&guest)).await.unwrap();
    assert!(target.cancel.is_cancelled() && target.validate().await.is_err());
    assert_eq!(independent.state().await["state"], "host-ok");
    independent.command("ide", &[]).await;
    broadcaster.abort();
    game.abort();
}
