//! Room API access and owner leases stay in the desktop process, including
//! while the multiplayer page is hidden. No management token reaches WebView.
use super::invitation::{self, Invitation, InvitationPreview};
use anyhow::{ensure, Context, Result};
use reqwest::{Client, Method};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{net::Ipv4Addr, time::Duration};
use tokio::{sync::Mutex, task::JoinHandle, time::Instant};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone)]
pub(super) struct Network {
    pub name: String,
    pub host_ip: Ipv4Addr,
    pub relays: Vec<String>,
    pub invite_code: String,
}

#[derive(Clone)]
pub(super) struct RoomApi {
    client: Client,
    base: String,
}

#[derive(Deserialize)]
struct Room {
    id: Uuid,
    status: String,
    #[serde(default)]
    invite_code: String,
    #[serde(default)]
    room_name: String,
    #[serde(default)]
    game_version: String,
    #[serde(default)]
    game_port: u16,
    #[serde(default)]
    host_virtual_ipv4: String,
    #[serde(default)]
    last_heartbeat_at: String,
    #[serde(default)]
    expires_at: String,
    #[serde(default)]
    max_expires_at: String,
}

#[derive(Deserialize)]
struct Connection {
    network_name: String,
    network_secret: String,
    relay_urls: Vec<String>,
}

#[derive(Deserialize)]
struct Resolved {
    room: Room,
    easytier: Connection,
    owner_token: Option<String>,
    heartbeat_interval_seconds: Option<u64>,
}

struct ApiFailure {
    status: u16,
    retry_after: Option<u64>,
    message: &'static str,
}
impl std::fmt::Debug for ApiFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::fmt::Display for ApiFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for ApiFailure {}

fn token_valid(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub(super) fn normalize_code(value: &str) -> Result<String> {
    let value = value.trim();
    ensure!(
        value.len() == 8 && value.bytes().all(|b| b.is_ascii_alphanumeric()),
        "请输入 8 位英文字母或数字邀请码"
    );
    Ok(value.to_ascii_uppercase())
}

fn deadline(room: &Room, started: Instant) -> Result<Instant> {
    let parse = |value: &str| {
        chrono::DateTime::parse_from_rfc3339(value)
            .map_err(|_| anyhow::anyhow!("SFMCL联机房间有效期无效"))
    };
    let expires = parse(&room.expires_at)?;
    let heartbeat = parse(&room.last_heartbeat_at)?;
    let maximum = parse(&room.max_expires_at)?;
    let millis = (expires - heartbeat).num_milliseconds();
    ensure!(
        room.status == "active" && millis > 0 && millis <= 90_000 && expires <= maximum,
        "SFMCL联机房间已失效，请重新创建"
    );
    // Use server-relative time and the beginning of the request. This avoids
    // relying on the user's wall clock and conservatively includes network RTT.
    Ok(started + Duration::from_millis(millis as u64))
}

impl RoomApi {
    pub fn new() -> Result<Self> {
        Self::from_base(&crate::vault::playtogether_api_url()?)
    }

    fn from_base(base: &str) -> Result<Self> {
        let url =
            reqwest::Url::parse(base).map_err(|_| anyhow::anyhow!("SFMCL联机房间 API 地址无效"))?;
        ensure!(
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && matches!(url.path(), "" | "/")
                && url.query().is_none()
                && url.fragment().is_none(),
            "SFMCL联机房间 API 需要 HTTPS 根地址"
        );
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(8))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            base: base.trim_end_matches('/').into(),
        })
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: Option<&str>,
    ) -> Result<Value> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .header("Accept", "application/json");
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let mut response = request.send().await.map_err(|_| ApiFailure {
            status: 0,
            retry_after: None,
            message: "无法连接SFMCL联机房间服务，请检查网络后重试",
        })?;
        let status = response.status();
        let retry_after = response
            .headers()
            .get("Retry-After")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v > 0);
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("读取SFMCL联机房间服务失败"))?
        {
            ensure!(
                bytes.len() + chunk.len() <= 16 * 1024,
                "SFMCL联机房间响应过大"
            );
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("SFMCL联机房间服务响应无效"))?;
        if !status.is_success() {
            let message = match value["error"]["code"].as_str().unwrap_or_default() {
                "room_unavailable" => "房间不存在、已关闭或已过期，请向房主获取新邀请码",
                "room_expired" | "room_closed" => "SFMCL联机房间已关闭或已过期，请重新创建",
                "owner_token_required" | "invalid_owner_token" => {
                    "SFMCL联机房间管理权限已失效，请重新创建"
                }
                "rate_limited" => "请求过于频繁，请稍后重试",
                "active_room_limit" => "当前网络的SFMCL联机房间数量已达上限，请先关闭闲置房间",
                "invalid_parameters" => "房间信息无效，请检查名称、版本、端口或 8 位邀请码",
                _ => "SFMCL联机房间服务暂不可用，请稍后重试",
            };
            return Err(ApiFailure {
                status: status.as_u16(),
                retry_after,
                message,
            }
            .into());
        }
        Ok(value)
    }

    async fn resolve(&self, code: &str) -> Result<Resolved> {
        let code = normalize_code(code)?;
        let value = self
            .request(
                Method::POST,
                "/api/rooms/resolve",
                Some(json!({"invite_code":code})),
                None,
            )
            .await?;
        let resolved: Resolved =
            serde_json::from_value(value).map_err(|_| anyhow::anyhow!("SFMCL联机房间配置无效"))?;
        ensure!(
            resolved.room.invite_code == code,
            "SFMCL联机房间邀请码不匹配"
        );
        Ok(resolved)
    }

    pub async fn preview(&self, code: &str) -> Result<InvitationPreview> {
        Ok(self.resolve(code).await?.invitation()?.preview())
    }

    pub async fn join(&self, code: &str) -> Result<Invitation> {
        self.resolve(code).await?.invitation()
    }

    pub async fn create(
        &self,
        name: &str,
        port: u16,
        version: &str,
    ) -> Result<(Invitation, Owner)> {
        ensure!(
            invitation::text_field(name, 48) && invitation::text_field(version, 64) && port > 0,
            "请检查房间名称、游戏版本及端口"
        );
        let started = Instant::now();
        let value = self
            .request(
                Method::POST,
                "/api/rooms",
                Some(json!({
                    "room_name":name.trim(), "game_port":port, "game_version":version,
                    "host_virtual_ipv4":"10.126.0.1"
                })),
                None,
            )
            .await?;
        let resolved: Resolved =
            serde_json::from_value(value).map_err(|_| anyhow::anyhow!("SFMCL联机房间配置无效"))?;
        let token = resolved
            .owner_token
            .as_deref()
            .context("SFMCL联机房间未返回管理权限")?;
        ensure!(token_valid(token), "SFMCL联机房间管理凭据无效");
        let interval = resolved
            .heartbeat_interval_seconds
            .context("SFMCL联机房间未返回心跳间隔")?;
        ensure!((1..=30).contains(&interval), "SFMCL联机房间心跳间隔无效");
        let owner = Owner {
            api: self.clone(),
            id: resolved.room.id,
            token: token.into(),
            deadline: deadline(&resolved.room, started)?,
            interval: Duration::from_secs(interval),
        };
        Ok((resolved.invitation()?, owner))
    }
}

impl Resolved {
    fn invitation(&self) -> Result<Invitation> {
        ensure!(
            self.room.status == "active"
                && !self.room.id.is_nil()
                && invitation::text_field(&self.room.room_name, 80)
                && invitation::text_field(&self.room.game_version, 64)
                && self.room.game_port > 0
                && token_valid(&self.easytier.network_secret)
                && invitation::text_field(&self.easytier.network_name, 128),
            "SFMCL联机房间配置无效"
        );
        let host_ip: Ipv4Addr = self
            .room
            .host_virtual_ipv4
            .parse()
            .map_err(|_| anyhow::anyhow!("SFMCL联机房间虚拟地址无效"))?;
        ensure!(
            host_ip.is_private() && (1..=254).contains(&host_ip.octets()[3]),
            "SFMCL联机房间虚拟地址无效"
        );
        ensure!(
            (1..=5).contains(&self.easytier.relay_urls.len()),
            "SFMCL联机节点配置无效"
        );
        for relay in &self.easytier.relay_urls {
            let url =
                reqwest::Url::parse(relay).map_err(|_| anyhow::anyhow!("SFMCL联机节点地址无效"))?;
            ensure!(
                relay.len() <= 512
                    && matches!(url.scheme(), "tcp" | "udp" | "ws" | "wss" | "quic")
                    && url.host_str().is_some()
                    && url.port_or_known_default().is_some_and(|port| port > 0)
                    && url.username().is_empty()
                    && url.password().is_none(),
                "SFMCL联机节点地址无效"
            );
        }
        let code = normalize_code(&self.room.invite_code)?;
        Ok(Invitation {
            protocol: 1,
            room_id: self.room.id,
            name: self.room.room_name.clone(),
            secret: self.easytier.network_secret.clone(),
            subnet: [126, 0],
            port: self.room.game_port,
            server: self.easytier.relay_urls[0].clone(),
            game_version: self.room.game_version.clone(),
            official: Some(Network {
                name: self.easytier.network_name.clone(),
                host_ip,
                relays: self.easytier.relay_urls.clone(),
                invite_code: code,
            }),
        })
    }
}

pub(super) struct Owner {
    api: RoomApi,
    id: Uuid,
    token: String,
    deadline: Instant,
    interval: Duration,
}

pub(super) struct Lease {
    stop: CancellationToken,
    task: Mutex<Option<(Owner, JoinHandle<Result<()>>)>>,
}

impl Owner {
    pub fn start(self, session: CancellationToken) -> Lease {
        let stop = CancellationToken::new();
        let stopped = stop.clone();
        let api = self.api.clone();
        let token = self.token.clone();
        let id = self.id;
        let mut expires = self.deadline;
        let interval = self.interval;
        let task = tokio::spawn(async move {
            let mut delay = interval;
            let mut failures = 0u32;
            let outcome = async {
                loop {
                    tokio::select! {
                        biased;
                        _ = stopped.cancelled() => return Ok(()),
                        _ = session.cancelled() => return Ok(()),
                        _ = tokio::time::sleep_until(expires) => anyhow::bail!("SFMCL联机房间心跳超时，请重新创建"),
                        _ = tokio::time::sleep(delay) => {}
                    }
                    let started = Instant::now();
                    // Await issued heartbeats before DELETE; never let a late
                    // heartbeat race with explicit room closure.
                    match api.request(Method::POST, &format!("/api/rooms/{id}/heartbeat"), None, Some(&token)).await {
                        Ok(value) => {
                            let room: Room = serde_json::from_value(value["room"].clone()).map_err(|_| anyhow::anyhow!("SFMCL联机房间心跳响应无效"))?;
                            ensure!(room.id == id, "SFMCL联机房间心跳不匹配");
                            expires = deadline(&room, started)?;
                            failures = 0;
                            delay = interval;
                        }
                        Err(error) => {
                            let failure = error.downcast_ref::<ApiFailure>();
                            if failure.is_some_and(|f| matches!(f.status, 401 | 403 | 404 | 410)) { return Err(error); }
                            failures += 1;
                            delay = Duration::from_secs(failure.and_then(|f| f.retry_after).unwrap_or((failures as u64 * 5).min(15)).min(86400));
                            ensure!(Instant::now() + delay < expires, "SFMCL联机房间心跳超时，请重新创建");
                        }
                    }
                }
            }.await;
            if outcome.is_err() {
                session.cancel();
            }
            outcome
        });
        Lease {
            stop,
            task: Mutex::new(Some((self, task))),
        }
    }
}

impl Lease {
    pub async fn stop_close(&self) -> Result<()> {
        let mut state = self.task.lock().await;
        let Some((owner, task)) = state.take() else {
            return Ok(());
        };
        self.stop.cancel();
        let heartbeat = task
            .await
            .context("SFMCL联机房间心跳任务结束失败")
            .and_then(|result| result);
        let closed = owner
            .api
            .request(
                Method::DELETE,
                &format!("/api/rooms/{}", owner.id),
                None,
                Some(&owner.token),
            )
            .await;
        heartbeat.and(closed.map(|_| ()).map_err(|_| {
            anyhow::anyhow!("房间已在本机结束，注销失败；邀请码将在停止心跳后自动过期")
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Request, State},
        http::StatusCode,
        response::IntoResponse,
        routing::any,
        Router,
    };
    use std::sync::{Arc, Mutex as StdMutex};

    #[derive(Default)]
    struct Fixture {
        calls: StdMutex<Vec<(String, String, bool, Value)>>,
        fail_heartbeat: StdMutex<Option<u16>>,
        fail_close: StdMutex<bool>,
        heartbeat_gate: StdMutex<Option<Arc<tokio::sync::Notify>>>,
    }

    fn response() -> Value {
        json!({"room": {
            "id":"e6be91cc-8fdd-4f33-8f71-8e5fb4c889df", "status":"active", "invite_code":"A1B2C3D4",
            "room_name":"room", "game_version":"1.21.4", "game_port":25565, "host_virtual_ipv4":"10.126.0.1",
            "last_heartbeat_at":"2026-11-14T00:00:00+00:00", "expires_at":"2026-11-14T00:01:30+00:00",
            "max_expires_at":"2026-11-14T06:00:00+00:00"
        }, "easytier": {"network_name":"sfmcl-room-e6be91cc-8fdd-4f33-8f71-8e5fb4c889df",
            "network_secret":"a".repeat(43), "relay_urls":["wss://relay.example.com", "tcp://relay.example.com:11010"]},
            "owner_token":"b".repeat(43), "heartbeat_interval_seconds":30})
    }

    async fn handler(
        State(fixture): State<Arc<Fixture>>,
        request: Request,
    ) -> axum::response::Response {
        let path = request.uri().path().to_string();
        let method = request.method().to_string();
        let authorized = request
            .headers()
            .get("Authorization")
            .is_some_and(|v| v.to_str().unwrap() == format!("Bearer {}", "b".repeat(43)));
        let body = axum::body::to_bytes(request.into_body(), 8192)
            .await
            .unwrap();
        let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
        fixture
            .calls
            .lock()
            .unwrap()
            .push((method.clone(), path.clone(), authorized, body));
        if path.ends_with("heartbeat") {
            let gate = fixture.heartbeat_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.notified().await;
            }
            let failure = fixture.fail_heartbeat.lock().unwrap().take();
            if let Some(status) = failure {
                let code = if status == 410 {
                    "room_expired"
                } else {
                    "rate_limited"
                };
                return (
                    StatusCode::from_u16(status).unwrap(),
                    [("Retry-After", "1")],
                    axum::Json(json!({"error":{"code":code,"message":"never echo secrets"}})),
                )
                    .into_response();
            }
            return axum::Json(json!({"room":response()["room"]})).into_response();
        }
        if method == "DELETE" {
            if *fixture.fail_close.lock().unwrap() {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    axum::Json(json!({"error":{"code":"database_unavailable"}})),
                )
                    .into_response();
            }
            return axum::Json(json!({"room":{"status":"closed"}})).into_response();
        }
        (
            if path == "/api/rooms" {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            },
            axum::Json(response()),
        )
            .into_response()
    }

    async fn fixture() -> (RoomApi, Arc<Fixture>, JoinHandle<()>) {
        let state = Arc::new(Fixture::default());
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let api = RoomApi {
            client: Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            base: format!("http://{}", listener.local_addr().unwrap()),
        };
        let router = Router::new()
            .fallback(any(handler))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (api, state, task)
    }

    #[test]
    fn private_api_roots_require_https_without_embedded_credentials() {
        let api = RoomApi::from_base("https://rooms.example.com/").unwrap();
        assert_eq!(api.base, "https://rooms.example.com");
        for invalid in [
            "http://rooms.example.com",
            "https://private-user:private-key@rooms.example.com",
            "https://rooms.example.com/api",
            "https://rooms.example.com/?private-key=secret",
            "https://rooms.example.com/#secret",
            "private-invalid-root",
        ] {
            let error = match RoomApi::from_base(invalid) {
                Ok(_) => panic!("invalid root accepted"),
                Err(error) => format!("{error:#}"),
            };
            assert!(error.contains("API") && !error.contains(invalid));
        }
    }

    #[test]
    fn codes_are_ascii_alphanumeric_and_server_times_ignore_the_client_clock() {
        assert_eq!(normalize_code(" abcdefgh \n").unwrap(), "ABCDEFGH");
        assert_eq!(normalize_code(" a1b2c3d4 \n").unwrap(), "A1B2C3D4");
        assert_eq!(normalize_code("12345678").unwrap(), "12345678");
        for value in [
            "AB12!D34",
            "ABCDＥFGH",
            "A１B2C3D4",
            "SFMCL1.code",
            "ABCDEFG",
            "ABCDEFGHI",
        ] {
            assert!(normalize_code(value).is_err());
        }
        let mut room: Room = serde_json::from_value(response()["room"].clone()).unwrap();
        let started = Instant::now();
        assert_eq!(
            deadline(&room, started).unwrap() - started,
            Duration::from_secs(90)
        );
        room.expires_at = room.last_heartbeat_at.clone();
        assert!(deadline(&room, started).is_err());
    }

    #[tokio::test]
    async fn create_resolve_and_network_config_keep_owner_credentials_native() {
        let (api, fixture, server) = fixture().await;
        let (invite, owner) = api.create(" room ", 25565, "1.21.4").await.unwrap();
        assert!(invite.encode().is_err());
        assert_eq!(invite.host_ip(), "10.126.0.1");
        assert_eq!(invite.guest_ip(), "10.126.0.2");
        assert_eq!(
            invite.network_name(),
            response()["easytier"]["network_name"]
        );
        let config: toml::Value =
            toml::from_str(&super::super::engine::config(&invite, false, "guest", 50000).unwrap())
                .unwrap();
        assert_eq!(config["peer"].as_array().unwrap().len(), 2);
        assert_eq!(config["ipv4"].as_str().unwrap(), "10.126.0.2/24");
        assert_eq!(
            config["port_forward"][0]["dst_addr"].as_str().unwrap(),
            "10.126.0.1:25565"
        );
        assert_eq!(
            config["network_identity"]["network_secret"]
                .as_str()
                .unwrap(),
            "a".repeat(43)
        );
        let preview = serde_json::to_string(&api.preview("a1b2c3d4").await.unwrap()).unwrap();
        assert!(!preview.contains(&"a".repeat(43)) && !preview.contains(&"b".repeat(43)));
        let joined = api.join("a1b2c3d4").await.unwrap();
        assert_eq!(joined.official.as_ref().unwrap().invite_code, "A1B2C3D4");
        assert!(api.join("AB12!D34").await.is_err());
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        owner.start(cancelled).stop_close().await.unwrap();
        let calls = fixture.calls.lock().unwrap();
        assert_eq!(calls[0].3["host_virtual_ipv4"], "10.126.0.1");
        assert_eq!(calls[1].3["invite_code"], "A1B2C3D4");
        assert_eq!(calls[2].3["invite_code"], "A1B2C3D4");
        assert_eq!(calls.len(), 4);
        assert!(!calls[0].2 && !calls[1].2 && !calls[2].2);
        assert_eq!(calls.last().unwrap().0, "DELETE");
        assert!(calls.last().unwrap().2);
        drop(calls);
        server.abort();
    }

    async fn wait_heartbeat(fixture: &Fixture, count: usize) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while fixture
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c.1.ends_with("heartbeat"))
                .count()
                < count
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn heartbeat_retries_rate_limits_and_closes_once_after_the_last_heartbeat() {
        let (api, fixture, server) = fixture().await;
        let (_, mut owner) = api.create("room", 25565, "1.21.4").await.unwrap();
        owner.interval = Duration::from_millis(10);
        *fixture.fail_heartbeat.lock().unwrap() = Some(429);
        let session = CancellationToken::new();
        let started = Instant::now();
        let lease = owner.start(session.clone());
        wait_heartbeat(&fixture, 2).await;
        assert!(started.elapsed() >= Duration::from_secs(1));
        assert!(!session.is_cancelled());
        lease.stop_close().await.unwrap();
        lease.stop_close().await.unwrap();
        let calls = fixture.calls.lock().unwrap();
        assert_eq!(calls.iter().filter(|c| c.0 == "DELETE").count(), 1);
        assert_eq!(calls.last().unwrap().0, "DELETE");
        assert!(calls
            .iter()
            .filter(|c| c.1.ends_with("heartbeat"))
            .all(|c| c.2));
        drop(calls);
        server.abort();
    }

    #[tokio::test]
    async fn permanent_heartbeat_failure_ends_the_session_and_still_closes() {
        let (api, fixture, server) = fixture().await;
        let (_, mut owner) = api.create("room", 25565, "1.21.4").await.unwrap();
        owner.interval = Duration::from_millis(10);
        *fixture.fail_heartbeat.lock().unwrap() = Some(410);
        let session = CancellationToken::new();
        let lease = owner.start(session.clone());
        tokio::time::timeout(Duration::from_secs(2), session.cancelled())
            .await
            .unwrap();
        let error = lease.stop_close().await.unwrap_err().to_string();
        assert!(error.contains("重新创建"));
        assert_eq!(fixture.calls.lock().unwrap().last().unwrap().0, "DELETE");
        server.abort();
    }

    #[tokio::test]
    async fn close_waits_for_an_inflight_heartbeat() {
        let (api, fixture, server) = fixture().await;
        let (_, mut owner) = api.create("room", 25565, "1.21.4").await.unwrap();
        owner.interval = Duration::from_millis(10);
        let gate = Arc::new(tokio::sync::Notify::new());
        *fixture.heartbeat_gate.lock().unwrap() = Some(gate.clone());
        let lease = Arc::new(owner.start(CancellationToken::new()));
        wait_heartbeat(&fixture, 1).await;
        let closing = {
            let lease = lease.clone();
            tokio::spawn(async move { lease.stop_close().await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!fixture
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|call| call.0 == "DELETE"));
        gate.notify_one();
        closing.await.unwrap().unwrap();
        assert_eq!(fixture.calls.lock().unwrap().last().unwrap().0, "DELETE");
        server.abort();
    }

    #[tokio::test]
    async fn lease_expiry_and_failed_close_do_not_keep_local_sessions_alive() {
        let (api, fixture, server) = fixture().await;
        let (_, mut owner) = api.create("room", 25565, "1.21.4").await.unwrap();
        owner.deadline = Instant::now() + Duration::from_millis(20);
        *fixture.fail_close.lock().unwrap() = true;
        let session = CancellationToken::new();
        let lease = owner.start(session.clone());
        tokio::time::timeout(Duration::from_secs(2), session.cancelled())
            .await
            .unwrap();
        assert!(lease.stop_close().await.is_err());
        assert_eq!(fixture.calls.lock().unwrap().last().unwrap().0, "DELETE");
        server.abort();
    }
}
