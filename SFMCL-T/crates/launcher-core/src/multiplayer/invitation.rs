use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const PREFIX: &str = "SFMCL1.";
pub const TUNNEL_PREFIX: &str = "SFMCL2.";
pub const MAX_INVITATION: usize = 4096;

// Deliberately no Debug: invitations contain network credentials.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Invitation {
    pub protocol: u8,
    pub room_id: Uuid,
    pub name: String,
    pub secret: String,
    pub subnet: [u8; 2],
    pub port: u16,
    pub server: String,
    pub game_version: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationPreview {
    pub name: String,
    pub game_version: String,
    pub server: String,
}

pub fn text_field(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}

pub fn validate_server(value: &str) -> Result<String> {
    ensure!(value.len() <= 300, "共享节点地址过长");
    let url = reqwest::Url::parse(value.trim()).context("联机入口地址无效")?;
    ensure!(
        matches!(url.scheme(), "tcp" | "udp" | "wss")
            && url.port_or_known_default().is_some_and(|port| port > 0)
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && matches!(url.path(), "" | "/")
            && url.query().is_none()
            && url.fragment().is_none(),
        "联机入口只支持 TCP / UDP 地址或加密 WebSocket 地址"
    );
    if let Ok(ip) = url
        .host_str()
        .unwrap()
        .trim_matches(['[', ']'])
        .parse::<std::net::IpAddr>()
    {
        ensure!(
            !ip.is_unspecified() && !ip.is_multicast(),
            "共享节点地址无效"
        );
    }
    Ok(url.as_str().trim_end_matches('/').into())
}

impl Invitation {
    pub fn new(name: String, port: u16, server: String, game_version: String) -> Result<Self> {
        let mut invitation = Self::for_tunnel(name, port, game_version)?;
        invitation.protocol = 1;
        invitation.server = validate_server(&server)?;
        invitation.validate()?;
        Ok(invitation)
    }

    /// A room remains unshareable until its public tunnel has been verified.
    pub fn for_tunnel(name: String, port: u16, game_version: String) -> Result<Self> {
        let id = Uuid::new_v4();
        let invitation = Self {
            protocol: 2,
            room_id: id,
            name: name.trim().into(),
            secret: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            subnet: [1 + id.as_bytes()[0] % 254, 1 + id.as_bytes()[1] % 254],
            port,
            server: String::new(),
            game_version,
        };
        invitation.validate_room()?;
        Ok(invitation)
    }

    pub fn uses_tunnel(&self) -> bool {
        self.protocol == 2
    }

    pub(super) fn publish(&mut self, server: String) -> Result<()> {
        self.server = validate_server(&server)?;
        self.validate()
    }

    pub fn host_ip(&self) -> String {
        format!("10.{}.{}.1", self.subnet[0], self.subnet[1])
    }
    pub fn network_name(&self) -> String {
        format!("sfmcl-{}", self.room_id.simple())
    }
    pub fn preview(&self) -> InvitationPreview {
        InvitationPreview {
            name: self.name.clone(),
            game_version: self.game_version.clone(),
            server: self.server.clone(),
        }
    }
    fn validate_room(&self) -> Result<()> {
        ensure!(
            matches!(self.protocol, 1 | 2),
            "邀请码版本不受支持，请更新启动器"
        );
        ensure!(
            !self.room_id.is_nil()
                && text_field(&self.name, 48)
                && text_field(&self.game_version, 128),
            "邀请码房间信息无效"
        );
        ensure!(
            self.port > 0 && self.subnet.iter().all(|part| (1..=254).contains(part)),
            "邀请码网络地址无效"
        );
        ensure!(
            self.secret.len() == 64 && self.secret.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "邀请码凭据无效"
        );
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        self.validate_room()?;
        let server = validate_server(&self.server)?;
        ensure!(
            if self.uses_tunnel() {
                server.starts_with("wss://")
            } else {
                server.starts_with("tcp://") || server.starts_with("udp://")
            },
            "邀请码连接协议无效，请更新启动器或重新获取邀请"
        );
        Ok(())
    }
    pub fn encode(&self) -> Result<String> {
        self.validate()?;
        Ok(format!(
            "{}{}",
            if self.uses_tunnel() {
                TUNNEL_PREFIX
            } else {
                PREFIX
            },
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(self)?)
        ))
    }
    pub fn decode(value: &str) -> Result<Self> {
        ensure!(value.len() <= MAX_INVITATION, "邀请码过长");
        let value = value.trim();
        let (value, protocol) = if let Some(value) = value.strip_prefix(TUNNEL_PREFIX) {
            (value, 2)
        } else {
            (
                value
                    .strip_prefix(PREFIX)
                    .context("请输入完整的 SFMCL 联机邀请码")?,
                1,
            )
        };
        let bytes = URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| anyhow::anyhow!("邀请码编码无效"))?;
        // Never forward serde errors: they may quote a credential or raw input.
        let invitation: Self =
            serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("邀请码格式无效"))?;
        ensure!(invitation.protocol == protocol, "邀请码版本与内容不一致");
        invitation.validate()?;
        Ok(invitation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tunnel_invitation_is_unshareable_until_published_and_carries_its_endpoint() {
        let mut invite =
            Invitation::for_tunnel("Cloudflare room".into(), 25565, "1.21.4".into()).unwrap();
        assert!(invite.encode().is_err());
        invite
            .publish("wss://quiet-blue-bird.trycloudflare.com:443".into())
            .unwrap();
        let code = invite.encode().unwrap();
        assert!(code.starts_with(TUNNEL_PREFIX));
        let decoded = Invitation::decode(&code).unwrap();
        assert!(decoded.uses_tunnel());
        assert_eq!(decoded.server, "wss://quiet-blue-bird.trycloudflare.com");
        assert_eq!(decoded.secret, invite.secret);
        assert_eq!(decoded.port, 25565);
        assert!(Invitation::decode(&code.replacen(TUNNEL_PREFIX, PREFIX, 1)).is_err());
        for endpoint in [
            "ws://host:11011",
            "tcp://host:11010",
            "wss://user:secret@host",
            "wss://host/?token=secret",
        ] {
            assert!(Invitation::for_tunnel("room".into(), 1, "1.21.4".into())
                .unwrap()
                .publish(endpoint.into())
                .is_err());
        }
    }
    #[test]
    fn invitation_roundtrip_and_redacted_preview() {
        let invite = Invitation::new(
            "测试房间".into(),
            25565,
            "tcp://example.com:11010".into(),
            "1.21.4".into(),
        )
        .unwrap();
        let copy = Invitation::decode(&invite.encode().unwrap()).unwrap();
        assert_eq!(copy.secret, invite.secret);
        assert!(!serde_json::to_string(&copy.preview())
            .unwrap()
            .contains(&invite.secret));
        let next = Invitation::new(
            "测试房间".into(),
            25565,
            invite.server.clone(),
            "1.21.4".into(),
        )
        .unwrap();
        assert_ne!(invite.secret, next.secret);
        assert_ne!(invite.room_id, next.room_id);
    }
    #[test]
    fn rejects_unsafe_inputs_without_echoing_secrets() {
        for node in [
            "file:///a",
            "tcp://user:password@host:1",
            "tcp://host:1/?arg=bad",
            "tcp://host:0",
            "tcp://0.0.0.0:1",
            "http://host:123",
        ] {
            assert!(validate_server(node).is_err());
        }
        assert!(Invitation::decode(&"x".repeat(MAX_INVITATION + 1)).is_err());
        let secret = "DO-NOT-LOG-THIS";
        let code = format!(
            "{PREFIX}{}",
            URL_SAFE_NO_PAD.encode(format!(
                r#"{{"secret":"{secret}","unexpected":"{secret}"}}"#
            ))
        );
        assert!(!Invitation::decode(&code)
            .err()
            .unwrap()
            .to_string()
            .contains(secret));
        let mut invite =
            Invitation::new("room".into(), 1, "udp://host:1".into(), "1.21.4".into()).unwrap();
        invite.protocol = 2;
        assert!(invite.validate().is_err());
        invite.protocol = 1;
        invite.subnet = [0, 0];
        assert!(invite.validate().is_err());
    }
}
