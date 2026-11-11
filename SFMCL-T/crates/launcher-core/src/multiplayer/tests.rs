use super::*;
use std::{net::Ipv4Addr, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn automatic_room_needs_no_server_and_exposes_only_a_loopback_websocket() {
    let request: CreateRequest = serde_json::from_str(r#"{"name":"Room","port":25565}"#).unwrap();
    assert!(request.server.is_empty());
    let invite =
        invitation::Invitation::for_tunnel(request.name, request.port, "1.21.4".into()).unwrap();
    let config: toml::Value =
        toml::from_str(&engine::host_tunnel_config(&invite, "Host", 11011).unwrap()).unwrap();
    assert_eq!(
        config["listeners"][0].as_str(),
        Some("ws://127.0.0.1:11011")
    );
    assert!(config.get("peer").is_none());
    assert_eq!(config["flags"]["private_mode"].as_bool(), Some(true));
    assert_eq!(
        config["flags"]["relay_network_whitelist"].as_str(),
        Some("")
    );
    assert_eq!(config["tcp_whitelist"][0].as_str(), Some("25565"));
    assert_eq!(
        config["acl"]["acl_v1"]["chains"][0]["rules"][0]["ports"][0].as_str(),
        Some("25565")
    );
}

/// Exercises the complete public WSS path with verified official executables,
/// two room engines and a Minecraft status fixture. It does not claim that an
/// actual player has entered a game or that cross-network latency was measured.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires official EasyTier ZIP, cloudflared EXE and Cloudflare access"]
async fn real_cloudflare_invitation_and_lifecycle() {
    let work = tempfile::Builder::new()
        .prefix("real tunnel test ")
        .tempdir()
        .unwrap();
    let release = components::release_for("x86_64").unwrap();
    components::install_archive(
        work.path(),
        &std::path::PathBuf::from(std::env::var_os("SFMCL_EASYTIER_ZIP").unwrap()),
        &release,
    )
    .unwrap();
    super::tunnel::install_for_test(
        work.path(),
        &std::path::PathBuf::from(std::env::var_os("SFMCL_CLOUDFLARED_EXE").unwrap()),
    )
    .unwrap();
    let host = manager(work.path());
    let guest = manager(work.path());
    let (port, world) = minecraft_fixture().await;
    host.create(
        serde_json::from_value(serde_json::json!({"name":"Tunnel room", "port":port})).unwrap(),
        "1.21.4".into(),
        "Host".into(),
    )
    .unwrap();
    assert!(host
        .invitation(host.snapshot().session_id.as_deref().unwrap())
        .is_err());
    wait_ready(&host, 110).await;
    let host_id = host.snapshot().session_id.unwrap();
    let code = host.invitation(&host_id).unwrap();
    let invite = invitation::Invitation::decode(&code).unwrap();
    assert!(invite.uses_tunnel() && invite.server.starts_with("wss://"));
    assert!(invite.server.ends_with(".trycloudflare.com"));
    guest.join(&code, "Guest".into()).unwrap();
    wait_ready(&guest, 45).await;
    assert!(guest.snapshot().members.iter().any(|member| !member.local
        && member.ip == invite.host_ip()
        && member.connection == "tunnel"));
    let target = guest
        .launch_target(guest.snapshot().session_id.as_deref().unwrap())
        .unwrap();
    target.validate().await.unwrap();
    world.abort();
    let _ = world.await;
    for _ in 0..15 {
        if !host.snapshot().world_open && !guest.snapshot().world_open {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert!(!host.snapshot().world_open && !guest.snapshot().world_open);
    assert!(host.invitation(&host_id).is_err());
    guest.leave(None).await.unwrap();
    host.leave(None).await.unwrap();
    assert!(!host.active() && !guest.active());
    assert!(target.cancel.is_cancelled());
    assert!(!std::fs::read_dir(work.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("tunnel-session-")));
    println!("real Cloudflare: host ready before guests, WSS invitation, Minecraft status through tunnel, world closure and owned-process cleanup passed");
}

#[cfg(windows)]
async fn wait_ready(manager: &Multiplayer, seconds: u64) {
    for _ in 0..seconds {
        let snapshot = manager.snapshot();
        if snapshot.state == "ready" {
            return;
        }
        assert_ne!(snapshot.state, "failed", "{:?}", snapshot.error);
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    panic!("session not ready: {:?}", manager.snapshot().error);
}

fn manager(root: &std::path::Path) -> std::sync::Arc<Multiplayer> {
    Multiplayer::new(
        root.into(),
        crate::downloads::DownloadManager::open(&root.join("downloads"), 2).unwrap(),
        std::sync::Arc::new(crate::jobs::Jobs::default()),
    )
}

async fn minecraft_fixture() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut request = [0; 256];
                if stream.read(&mut request).await.unwrap_or(0) == 0 {
                    return;
                }
                let json = br#"{"version":{"name":"1.21.4","protocol":769},"players":{"max":8,"online":1},"description":{"text":"fixture"}}"#;
                let mut packet = vec![(json.len() + 2) as u8, 0, json.len() as u8];
                packet.extend(json);
                let _ = stream.write_all(&packet).await;
            });
        }
    });
    (port, task)
}

#[tokio::test]
async fn minecraft_ping_requires_protocol_response() {
    let (port, task) = minecraft_fixture().await;
    assert_eq!(
        minecraft::ping((Ipv4Addr::LOCALHOST, port).into())
            .await
            .unwrap(),
        "1.21.4"
    );
    task.abort();
    let _ = task.await;
    assert!(minecraft::ping((Ipv4Addr::LOCALHOST, port).into())
        .await
        .is_err());
}
#[tokio::test]
async fn launch_target_is_transient_and_cancelled_session_is_rejected() {
    let original = crate::config::Settings::default();
    let saved = serde_json::to_vec(&original).unwrap();
    let mut effective = original.clone();
    let target = LaunchTarget {
        address: (Ipv4Addr::LOCALHOST, 12345).into(),
        cancel: Default::default(),
    };
    target.apply(&mut effective).unwrap();
    assert_eq!(effective.server_host, "127.0.0.1");
    assert_eq!(effective.server_port, 12345);
    assert!(effective.server_enabled && !effective.quick_play_enabled);
    assert_eq!(serde_json::to_vec(&original).unwrap(), saved);
    target.cancel.cancel();
    assert!(target.apply(&mut effective).is_err());
    assert!(target.validate().await.is_err());
}

#[tokio::test]
async fn concurrent_sessions_cancellation_and_maintenance() {
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(temp.path());
    manager.begin_maintenance().unwrap();
    assert!(manager.prepare(None).is_err());
    manager.end_maintenance();
    let first = manager.prepare(None).unwrap();
    assert!(manager.prepare(None).is_err());
    assert!(manager.begin_maintenance().is_err());
    manager.leave(Some("stale-id")).await.unwrap();
    assert!(manager.active());
    manager.leave(first.session_id.as_deref()).await.unwrap();
    manager.leave(None).await.unwrap();
    assert!(!manager.active());
    assert_eq!(manager.snapshot().state, "idle");
    manager.shutdown().await.unwrap();
    assert!(manager.prepare(None).is_err());
}

#[test]
fn component_import_rejects_unverified_archives() {
    let temp = tempfile::tempdir().unwrap();
    let archive = temp.path().join("untrusted.zip");
    std::fs::write(&archive, b"not an official release").unwrap();
    let release = components::release_for("x86_64").unwrap();
    assert!(components::install_archive(temp.path(), &archive, &release).is_err());
    assert!(!temp
        .path()
        .join("easytier-2.6.4-x86_64/easytier-core.exe")
        .exists());
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "helper launched by real engine integration test"]
async fn crash_engine_child() {
    let Some(core) = std::env::var_os("SFMCL_TEST_ENGINE_CORE") else {
        return;
    };
    let core = std::path::PathBuf::from(core);
    let port: u16 = std::env::var("SFMCL_TEST_ENGINE_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let config = format!("listeners = [\"tcp://127.0.0.1:{port}\"]\n[flags]\nno_tun = true\nbind_device = false\ndisable_upnp = true\n");
    let _engine = engine::Engine::start(
        components::Binaries {
            cli: core.with_file_name("easytier-cli.exe"),
            core,
        },
        &config,
    )
    .unwrap();
    tokio::time::sleep(Duration::from_secs(120)).await;
}

#[cfg(windows)]
async fn assert_crash_cleanup(files: &components::Binaries) {
    let port = engine::free_port().unwrap();
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--ignored",
            "--exact",
            "multiplayer::integration_tests::crash_engine_child",
        ])
        .env("SFMCL_TEST_ENGINE_CORE", &files.core)
        .env("SFMCL_TEST_ENGINE_PORT", port.to_string())
        .creation_flags(0x08000000)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut helper = command.spawn().unwrap();
    let address = (Ipv4Addr::LOCALHOST, port);
    let mut listening = false;
    for _ in 0..30 {
        if tokio::net::TcpStream::connect(address).await.is_ok() {
            listening = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(listening, "child engine failed to start");
    helper.kill().await.unwrap();
    helper.wait().await.unwrap();
    for _ in 0..30 {
        if tokio::net::TcpStream::connect(address).await.is_err() {
            println!("launcher crash: owned engine terminated by Windows job");
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("engine survived its owning process");
}

/// Run with SFMCL_EASYTIER_ZIP pointing to the official verified archive.
/// Uses real binaries and an isolated relay plus a Minecraft status fixture.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires the official EasyTier v2.6.4 Windows ZIP"]
async fn real_engine_relay_acl_and_lifecycle() {
    let archive = std::env::var_os("SFMCL_EASYTIER_ZIP").expect("SFMCL_EASYTIER_ZIP");
    let temp = tempfile::tempdir().unwrap();
    let release = components::release_for(
        &std::env::var("SFMCL_EASYTIER_ARCH").unwrap_or(std::env::consts::ARCH.into()),
    )
    .unwrap();
    let files =
        components::install_archive(temp.path(), &std::path::PathBuf::from(archive), &release)
            .unwrap();
    assert_crash_cleanup(&files).await;
    let node_port = engine::free_port().unwrap();
    let relay_config = format!(
        r#"
listeners = ["tcp://127.0.0.1:{node_port}"]
[network_identity]
network_name = "fixture-relay"
network_secret = "fixture-relay"
[flags]
no_tun = true
bind_device = false
disable_upnp = true
accept_dns = false
"#
    );
    let relay = engine::Engine::start(files.clone(), &relay_config).unwrap();
    let (port, world) = minecraft_fixture().await;
    let invite = invitation::Invitation::new(
        "Fixture".into(),
        port,
        format!("tcp://127.0.0.1:{node_port}"),
        "1.21.4".into(),
    )
    .unwrap();
    let mut host_config: toml::Value =
        toml::from_str(&engine::config(&invite, true, "Host", 0).unwrap()).unwrap();
    host_config["flags"]
        .as_table_mut()
        .unwrap()
        .insert("disable_p2p".into(), toml::Value::Boolean(true));
    let host =
        engine::Engine::start(files.clone(), &toml::to_string(&host_config).unwrap()).unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        host.members(&invite).await.unwrap().1,
        "host must be able to publish invitation before guests join"
    );
    let forward = engine::free_port().unwrap();
    let mut guest_config: toml::Value =
        toml::from_str(&engine::config(&invite, false, "Guest", forward).unwrap()).unwrap();
    guest_config["flags"]
        .as_table_mut()
        .unwrap()
        .insert("disable_p2p".into(), toml::Value::Boolean(true));
    let guest =
        engine::Engine::start(files.clone(), &toml::to_string(&guest_config).unwrap()).unwrap();
    let mut ready = false;
    for _ in 0..20 {
        if minecraft::ping((Ipv4Addr::LOCALHOST, forward).into())
            .await
            .is_ok()
        {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    if !ready {
        println!(
            "running: relay={} host={} guest={}",
            relay.running(),
            host.running(),
            guest.running()
        );
        println!("host peers: {:?}", host.query("peer").await);
        println!("guest peers: {:?}", guest.query("peer").await);
        println!("host connectors: {:?}", host.query("connector").await);
        println!("guest connectors: {:?}", guest.query("connector").await);
    }
    assert!(ready, "real relay forwarding failed");
    let (members, connected) = guest.members(&invite).await.unwrap();
    assert!(connected);
    assert!(members
        .iter()
        .any(|member| member.ip == invite.host_ip() && member.connection == "relay"));
    println!("real engine relay: Minecraft status forwarded, route reported relay");
    // A hostile room participant removes their own ACL. Host enforcement must
    // still protect a SECOND ACTUALLY LISTENING service, not just a closed port.
    let (private_port, private_service) = minecraft_fixture().await;
    let denied = engine::free_port().unwrap();
    guest_config.as_table_mut().unwrap().remove("acl");
    guest_config["ipv4"] = toml::Value::String(format!(
        "10.{}.{}.254/24",
        invite.subnet[0], invite.subnet[1]
    ));
    guest_config["dhcp"] = toml::Value::Boolean(false);
    guest_config["port_forward"][0]["bind_addr"] =
        toml::Value::String(format!("127.0.0.1:{denied}"));
    guest_config["port_forward"][0]["dst_addr"] =
        toml::Value::String(format!("{}:{private_port}", invite.host_ip()));
    let guest_ip = members
        .iter()
        .find(|member| member.local)
        .unwrap()
        .ip
        .clone();
    let guest_denied = engine::free_port().unwrap();
    let mut guest_forward = guest_config["port_forward"][0].clone();
    guest_forward["bind_addr"] = toml::Value::String(format!("127.0.0.1:{guest_denied}"));
    guest_forward["dst_addr"] = toml::Value::String(format!("{guest_ip}:{private_port}"));
    guest_config["port_forward"]
        .as_array_mut()
        .unwrap()
        .push(guest_forward);
    let hostile =
        engine::Engine::start(files.clone(), &toml::to_string(&guest_config).unwrap()).unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(minecraft::ping((Ipv4Addr::LOCALHOST, private_port).into())
        .await
        .is_ok());
    let attacker_members = hostile.members(&invite).await.unwrap().0;
    assert!(
        attacker_members
            .iter()
            .any(|member| member.ip == guest_ip && !member.local),
        "guest ACL probe must target a remote node"
    );
    assert!(minecraft::ping((Ipv4Addr::LOCALHOST, denied).into())
        .await
        .is_err());
    assert!(minecraft::ping((Ipv4Addr::LOCALHOST, guest_denied).into())
        .await
        .is_err());
    assert!(host
        .members(&invite)
        .await
        .unwrap()
        .0
        .iter()
        .any(|member| !member.local));
    hostile.stop().unwrap();
    assert!(!hostile.running());
    guest.stop().unwrap();
    host.stop().unwrap();
    assert!(!host.running());
    println!("host and guest ACL denied a listening private service; owned engines stopped");
    // An actual direct connection with the same security policy, using an
    // explicit local listener to avoid relying on Internet NAT/STUN in CI.
    let direct_port = engine::free_port().unwrap();
    host_config["listeners"] = toml::Value::Array(vec![toml::Value::String(format!(
        "tcp://127.0.0.1:{direct_port}"
    ))]);
    host_config["flags"]["disable_p2p"] = toml::Value::Boolean(false);
    let direct_host =
        engine::Engine::start(files.clone(), &toml::to_string(&host_config).unwrap()).unwrap();
    let direct_forward = engine::free_port().unwrap();
    let mut direct_guest_config: toml::Value =
        toml::from_str(&engine::config(&invite, false, "Guest", direct_forward).unwrap()).unwrap();
    direct_guest_config["peer"][0]["uri"] =
        toml::Value::String(format!("tcp://127.0.0.1:{direct_port}"));
    let direct_guest =
        engine::Engine::start(files, &toml::to_string(&direct_guest_config).unwrap()).unwrap();
    let mut direct_ready = false;
    for _ in 0..12 {
        if minecraft::ping((Ipv4Addr::LOCALHOST, direct_forward).into())
            .await
            .is_ok()
        {
            direct_ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(direct_ready);
    assert!(direct_guest
        .members(&invite)
        .await
        .unwrap()
        .0
        .iter()
        .any(|member| member.ip == invite.host_ip() && member.connection == "direct"));
    direct_guest.stop().unwrap();
    direct_host.stop().unwrap();
    println!("real engine direct: Minecraft status forwarded, route reported direct");
    // Exercise the public manager, including host-only ready, invitation,
    // guest target, closed world, cancellation, and invalidated launch lease.
    if release.arch == "x86_64" {
        let guest_manager = manager(temp.path());
        let manager = manager(temp.path());
        manager
            .create(
                CreateRequest {
                    name: "Room".into(),
                    port,
                    server: invite.server.clone(),
                    launch_id: None,
                },
                "1.21.4".into(),
                "Host".into(),
            )
            .unwrap();
        for _ in 0..20 {
            if manager.snapshot().state == "ready" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let snapshot = manager.snapshot();
        assert_eq!(snapshot.state, "ready", "{:?}", snapshot.error);
        let code = manager
            .invitation(snapshot.session_id.as_deref().unwrap())
            .unwrap();
        guest_manager.join(&code, "Guest".into()).unwrap();
        for _ in 0..30 {
            if guest_manager.snapshot().state == "ready" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let snapshot = guest_manager.snapshot();
        assert_eq!(snapshot.state, "ready", "{:?}", snapshot.error);
        let lease = guest_manager
            .launch_target(snapshot.session_id.as_deref().unwrap())
            .unwrap();
        lease.validate().await.unwrap();
        world.abort();
        let _ = world.await;
        for _ in 0..30 {
            if !guest_manager.snapshot().world_open {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        assert!(!guest_manager.snapshot().world_open);
        assert!(guest_manager
            .launch_target(snapshot.session_id.as_deref().unwrap())
            .is_err());
        guest_manager.leave(None).await.unwrap();
        manager.leave(None).await.unwrap();
        assert!(!manager.active() && !guest_manager.active());
        assert!(lease.cancel.is_cancelled());
        println!("session manager: ready, invite, join, world closure, launch invalidation, leave passed");
    } else {
        world.abort();
        let _ = world.await;
    }
    relay.stop().unwrap();
    private_service.abort();
    let _ = private_service.await;
}
