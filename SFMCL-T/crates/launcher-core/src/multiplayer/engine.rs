use super::{components::Binaries, invitation::Invitation};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    net::{Ipv4Addr, TcpListener},
    process::Stdio,
    time::Duration,
};
use tokio::io::AsyncReadExt;

pub fn free_port() -> Result<u16> {
    Ok(TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?
        .local_addr()?
        .port())
}

pub fn config(invite: &Invitation, host: bool, name: &str, forward: u16) -> Result<String> {
    let ip = if host {
        invite.host_ip()
    } else {
        format!("10.{}.{}.2", invite.subnet[0], invite.subnet[1])
    };
    let rules = if host {
        vec![json!({"name":"minecraft", "enabled":true, "priority":1000,
        "protocol":1, "ports":[invite.port.to_string()], "destination_ips":[format!("{}/32", invite.host_ip())],
        "action":1, "stateful":true})]
    } else {
        vec![]
    };
    let mut config = json!({
        "ipv4":format!("{ip}/24"), "dhcp":!host, "hostname":name,
        "listeners":[], "tcp_whitelist":if host { vec![invite.port.to_string()] } else { vec![] },
        "udp_whitelist":[],
        "network_identity":{"network_name":invite.network_name(),"network_secret":invite.secret},
        "peer":[{"uri":invite.server}],
        "flags":{"no_tun":true,"bind_device":false,"use_smoltcp":true,
            "private_mode":true,"relay_network_whitelist":"","disable_upnp":true,"accept_dns":false,
            "disable_p2p":invite.uses_tunnel()},
        "acl":{"acl_v1":{"chains":[
            {"name":"inbound", "chain_type":1,"enabled":true,"default_action":2,"rules":rules},
            {"name":"forward", "chain_type":3,"enabled":true,"default_action":2,"rules":rules}
        ]}}
    });
    if !host {
        // Explicit stateful egress tracks return traffic through default-drop ingress.
        config["acl"]["acl_v1"]["chains"].as_array_mut().unwrap().push(json!({
            "name":"outbound-game","chain_type":2,"enabled":true,"default_action":2,
            "rules":[{"name":"game", "enabled":true,"priority":1000,"protocol":1,
                "ports":[invite.port.to_string()],"destination_ips":[format!("{}/32", invite.host_ip())],"action":1,"stateful":true}]
        }));
        config["port_forward"] = json!([{"bind_addr":format!("127.0.0.1:{forward}"),"dst_addr":format!("{}:{}",invite.host_ip(),invite.port),"proto":"tcp"}]);
    }
    toml::to_string(&config).context("无法生成联机配置")
}

pub fn host_tunnel_config(invite: &Invitation, name: &str, listener: u16) -> Result<String> {
    ensure!(invite.uses_tunnel() && listener > 0, "房主联机入口配置无效");
    let mut config: toml::Value = toml::from_str(&config(invite, true, name, 0)?)?;
    config["listeners"] = toml::Value::Array(vec![toml::Value::String(format!(
        "ws://127.0.0.1:{listener}"
    ))]);
    config.as_table_mut().unwrap().remove("peer");
    toml::to_string(&config).context("无法生成房主联机配置")
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub connection: String,
    pub latency: Option<f64>,
    pub local: bool,
}

pub struct Engine {
    #[cfg(windows)]
    process: super::owned_process::OwnedProcess,
    files: Binaries,
    rpc: u16,
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
impl Engine {
    pub fn start(files: Binaries, config: &str) -> Result<Self> {
        let rpc = free_port()?;
        #[cfg(windows)]
        {
            let process = super::owned_process::OwnedProcess::spawn(&files.core, rpc, config)?;
            Ok(Self {
                process,
                files,
                rpc,
            })
        }
        #[cfg(not(windows))]
        {
            let _ = (files, config, rpc);
            anyhow::bail!("联机组件目前支持 Windows")
        }
    }
    pub fn running(&self) -> bool {
        #[cfg(windows)]
        {
            self.process.running()
        }
        #[cfg(not(windows))]
        {
            false
        }
    }
    pub fn stop(&self) -> Result<()> {
        #[cfg(windows)]
        {
            self.process.stop()
        }
        #[cfg(not(windows))]
        {
            Ok(())
        }
    }
    pub(super) async fn query(&self, operation: &str) -> Result<serde_json::Value> {
        let mut command = tokio::process::Command::new(&self.files.cli);
        command
            .args([
                "-p",
                &format!("127.0.0.1:{}", self.rpc),
                "-o",
                "json",
                operation,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().context("无法读取联机状态")?;
        let mut output = child
            .stdout
            .take()
            .context("无法读取联机状态")?
            .take(262145);
        let result = tokio::time::timeout(Duration::from_secs(3), async {
            let mut bytes = Vec::new();
            output.read_to_end(&mut bytes).await?;
            ensure!(bytes.len() <= 262144, "联机状态数据过大");
            ensure!(child.wait().await?.success(), "联机状态暂不可用");
            serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("联机状态格式无效"))
        })
        .await
        .context("联机状态读取超时");
        if !matches!(result, Ok(Ok(_))) {
            let _ = child.kill().await;
        }
        result?
    }
    pub async fn members(&self, invite: &Invitation) -> Result<(Vec<Member>, bool)> {
        let data = self.query("peer").await?;
        let peers = data.as_array().context("联机成员数据无效")?;
        let prefix = format!("10.{}.{}.", invite.subnet[0], invite.subnet[1]);
        let mut members = vec![];
        for peer in peers.iter().take(256) {
            let ip = peer["ipv4"].as_str().unwrap_or_default();
            if !ip.starts_with(&prefix) {
                continue;
            }
            let cost = peer["cost"].as_str().unwrap_or_default();
            let local = cost == "Local";
            let connection = if local {
                "local"
            } else if cost == "p2p" {
                if peer["tunnel_proto"]
                    .as_str()
                    .is_some_and(|proto| matches!(proto, "ws" | "wss"))
                {
                    "tunnel"
                } else {
                    "direct"
                }
            } else if cost.starts_with("relay(") {
                "relay"
            } else {
                "unknown"
            };
            let name = peer["hostname"]
                .as_str()
                .unwrap_or("成员")
                .chars()
                .filter(|ch| !ch.is_control())
                .take(48)
                .collect();
            let latency = peer["lat_ms"]
                .as_str()
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value >= 0.);
            members.push(Member {
                id: peer["id"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(32)
                    .collect(),
                name,
                ip: ip.into(),
                connection: connection.into(),
                latency,
                local,
            });
        }
        let connectors = self.query("connector").await?;
        // v2.6.4 CLI emits an array; ConnectorStatus::CONNECTED is zero.
        let connected = connectors
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["status"].as_u64() == Some(0)))
            || peers
                .iter()
                .any(|peer| peer["cost"].as_str().is_some_and(|cost| cost != "Local"));
        Ok((members, connected))
    }
}
