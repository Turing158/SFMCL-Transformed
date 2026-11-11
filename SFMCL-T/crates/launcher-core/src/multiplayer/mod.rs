//! Isolated, application-owned EasyTier sessions for Minecraft Java.
mod components;
mod engine;
pub mod invitation;
mod minecraft;
#[cfg(windows)]
mod owned_process;
mod session;
mod tunnel;
pub use session::{CreateRequest, LaunchTarget, Multiplayer, Snapshot};
#[cfg(test)]
#[path = "tests.rs"]
mod integration_tests;

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;
use tokio::net::TcpStream;

/// Resolve the launcher's actual live game, never a later global selection.
pub fn host_launch(
    jobs: &crate::jobs::Jobs,
    id: Option<&str>,
) -> Result<Option<crate::jobs::LaunchContext>> {
    let mut running = jobs.running_launches();
    if let Some(id) = id {
        return Ok(running
            .into_iter()
            .find(|job| job.id == id)
            .context("所选游戏尚未启动或已结束，请进入世界并对局域网开放后重试")?
            .launch);
    }
    ensure!(
        running.len() <= 1,
        "有多个游戏正在运行，请选择用于创建房间的游戏"
    );
    Ok(running.pop().and_then(|job| job.launch))
}

/// Accept a port only. The preparatory check must never probe an invite-supplied
/// address, resolve a hostname or scan the user's network.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortCheckRequest {
    port: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortCheck {
    pub port: u16,
    pub reachable: bool,
}

pub async fn check_local_port(request: PortCheckRequest) -> Result<PortCheck> {
    ensure!(request.port != 0, "请输入 1–65535 之间的游戏端口");
    let connect = |ip| async move {
        matches!(
            tokio::time::timeout(
                Duration::from_millis(1500),
                TcpStream::connect(SocketAddr::new(ip, request.port)),
            )
            .await,
            Ok(Ok(_))
        )
    };
    let (v4, v6) = tokio::join!(
        connect(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        connect(IpAddr::V6(Ipv6Addr::LOCALHOST)),
    );
    Ok(PortCheck {
        port: request.port,
        reachable: v4 || v6,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn launch(
        jobs: &crate::jobs::Jobs,
        version: &str,
        player: &str,
    ) -> std::sync::Arc<crate::jobs::Job> {
        let job = jobs.create(
            crate::jobs::JobKind::Launch,
            format!("启动 {version}"),
            &["游戏运行"],
        );
        job.set_launch_context(crate::jobs::LaunchContext {
            version_id: version.into(),
            game_version: "1.20.1".into(),
            directory: "D:/RunningGame".into(),
            player_name: player.into(),
            running: false,
        });
        job
    }

    #[test]
    fn host_launch_uses_actual_game_context_and_ignores_preparation() {
        let jobs = crate::jobs::Jobs::default();
        let game = launch(&jobs, "1.20.1-Fabric", "Steve");
        assert!(host_launch(&jobs, None).unwrap().is_none());
        assert!(host_launch(&jobs, Some(&game.snapshot().id)).is_err());
        game.set_launch_running(true);
        let preparing = launch(&jobs, "1.21.4", "Alex");
        let context = host_launch(&jobs, None).unwrap().unwrap();
        assert_eq!(context.version_id, "1.20.1-Fabric");
        assert_eq!(context.game_version, "1.20.1");
        assert_eq!(context.player_name, "Steve");
        assert_eq!(context.directory, "D:/RunningGame");
        assert!(host_launch(&jobs, Some(&preparing.snapshot().id)).is_err());
    }

    #[test]
    fn host_launch_requires_a_choice_for_multiple_games_and_rejects_stale_ids() {
        let jobs = crate::jobs::Jobs::default();
        let first = launch(&jobs, "first", "Steve");
        let second = launch(&jobs, "second", "Alex");
        first.set_launch_running(true);
        second.set_launch_running(true);
        assert!(host_launch(&jobs, None).is_err());
        let first_id = first.snapshot().id;
        assert_eq!(
            host_launch(&jobs, Some(&first_id))
                .unwrap()
                .unwrap()
                .player_name,
            "Steve"
        );
        first.cancel.cancel();
        assert!(host_launch(&jobs, Some(&first_id)).is_err());
        second.finish(&Ok(()));
        assert!(host_launch(&jobs, Some(&second.snapshot().id)).is_err());
        assert!(host_launch(&jobs, None).unwrap().is_none());
    }

    #[tokio::test]
    async fn detects_a_listener_then_its_closed_port() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(
            check_local_port(PortCheckRequest { port })
                .await
                .unwrap()
                .reachable
        );
        drop(listener);
        assert!(
            !check_local_port(PortCheckRequest { port })
                .await
                .unwrap()
                .reachable
        );
    }

    #[tokio::test]
    async fn rejects_zero_before_connecting() {
        assert!(check_local_port(PortCheckRequest { port: 0 })
            .await
            .is_err());
    }

    #[test]
    fn rejects_remote_targets_and_invalid_ports() {
        for payload in [
            r#"{"port":25565,"host":"192.168.1.1"}"#,
            r#"{"port":65536}"#,
            r#"{"port":-1}"#,
            r#"{"port":1.5}"#,
            r#"{"port":"25565"}"#,
            r#"{}"#,
        ] {
            assert!(serde_json::from_str::<PortCheckRequest>(payload).is_err());
        }
    }
}
