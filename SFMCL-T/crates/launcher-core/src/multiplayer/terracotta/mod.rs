pub(super) mod component;
#[cfg(test)]
mod tests;
use super::engine::Member;
use anyhow::{ensure, Context, Result};
use reqwest::{Client, Url};
use serde::Deserialize;
use std::{
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub launch_id: Option<String>,
    room: Option<String>,
    invitation: Option<String>,
    #[serde(default)]
    public_nodes: Vec<String>,
}

pub(crate) struct Room {
    pub host: bool,
    room: Option<String>,
    player: Option<String>,
    nodes: Vec<String>,
}

impl Request {
    pub(crate) fn room(self, host: bool, player: Option<String>) -> Result<Room> {
        let room = if host {
            ensure!(self.invitation.is_none(), "创建陶瓦房间的参数无效");
            self.room
                .filter(|v| !v.trim().is_empty())
                .map(|v| normalize(&v))
                .transpose()?
        } else {
            ensure!(
                self.room.is_none() && self.launch_id.is_none(),
                "加入陶瓦房间的参数无效"
            );
            Some(normalize(self.invitation.as_deref().unwrap_or_default())?)
        };
        ensure!(self.public_nodes.len() <= 32, "备用公共节点最多 32 个");
        let nodes = self
            .public_nodes
            .iter()
            .enumerate()
            .map(|(i, value)| {
                node(value).with_context(|| format!("第 {} 个陶瓦公共节点地址无效", i + 1))
            })
            .collect::<Result<_>>()?;
        Ok(Room {
            host,
            room,
            player: player.filter(|v| super::invitation::text_field(v, 48)),
            nodes,
        })
    }
}

fn node(value: &str) -> Result<String> {
    let value = value.trim();
    ensure!(
        value.len() <= 512 && !value.chars().any(char::is_whitespace),
        "节点地址无效"
    );
    let url = Url::parse(value)?;
    ensure!(
        url.host().is_some()
            && url.port_or_known_default().is_some_and(|p| p != 0)
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && match url.scheme() {
                "tcp" | "udp" => matches!(url.path(), "" | "/") && url.query().is_none(),
                "ws" | "wss" | "http" | "https" => true,
                _ => false,
            },
        "节点地址无效"
    );
    Ok(value.to_owned())
}

fn normalize(text: &str) -> Result<String> {
    const CHARS: &[u8] = b"0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    ensure!(text.len() <= 16384, "陶瓦邀请码过长");
    for raw in text.as_bytes().windows(21) {
        if !raw[..2].eq_ignore_ascii_case(b"U/") {
            continue;
        }
        let mut code = raw.to_ascii_uppercase();
        let mut remainder = 0;
        let mut valid = true;
        for i in (2..21).rev() {
            if matches!(i, 6 | 11 | 16) {
                valid &= code[i] == b'-';
                continue;
            }
            code[i] = match code[i] {
                b'I' => b'1',
                b'O' => b'0',
                other => other,
            };
            if let Some(digit) = CHARS.iter().position(|c| *c == code[i]) {
                remainder = (remainder * 34 + digit) % 7;
            } else {
                valid = false;
                break;
            }
        }
        if valid && remainder == 0 {
            return Ok(String::from_utf8(code)?);
        }
    }
    anyhow::bail!("陶瓦邀请码格式或校验位有误，请粘贴完整的 U/ 邀请码")
}

#[derive(Deserialize)]
struct State {
    state: String,
    index: u64,
    room: Option<String>,
    url: Option<String>,
    profiles: Option<Vec<Profile>>,
    #[serde(rename = "type")]
    exception: Option<u32>,
}
#[derive(Deserialize)]
struct Profile {
    machine_id: String,
    name: String,
    kind: String,
}

pub(super) struct Update {
    pub phase: String,
    pub ready: bool,
    pub code: Option<String>,
    pub address: Option<SocketAddr>,
    pub members: Vec<Member>,
}

impl State {
    fn project(self, host: bool) -> Result<Update> {
        let mut update = Update {
            phase: self.state.clone(),
            ready: false,
            code: None,
            address: None,
            members: vec![],
        };
        match (host, self.state.as_str()) {
            (true, "host-scanning" | "host-starting")
            | (false, "guest-connecting" | "guest-starting") => {}
            (true, "host-ok") | (false, "guest-ok") => {
                update.ready = true;
                if host {
                    update.code = Some(normalize(self.room.as_deref().unwrap_or_default())?);
                } else {
                    let url = self.url.context("陶瓦未提供游戏地址")?;
                    let address: SocketAddr = if url == "127.0.0.1" {
                        (Ipv4Addr::LOCALHOST, 25565).into()
                    } else {
                        url.parse().context("陶瓦游戏地址无效")?
                    };
                    ensure!(
                        address.ip() == Ipv4Addr::LOCALHOST && address.port() > 0,
                        "陶瓦游戏地址无效"
                    );
                    update.address = Some(address);
                }
                for p in self.profiles.context("陶瓦成员数据缺失")? {
                    let (connection, local) = match p.kind.as_str() {
                        "HOST" => ("host", host),
                        "LOCAL" => ("local", true),
                        "GUEST" => ("guest", false),
                        _ => anyhow::bail!("陶瓦成员身份无效"),
                    };
                    update.members.push(Member {
                        id: p.machine_id,
                        name: p.name,
                        ip: String::new(),
                        connection: connection.into(),
                        latency: None,
                        local,
                    });
                }
            }
            (_, "exception") => anyhow::bail!(
                "{}",
                match self.exception {
                    Some(0) => "陶瓦无法连接房主",
                    Some(1) => "陶瓦与房主的连接已中断",
                    Some(2) => "好友的陶瓦网络组件已退出",
                    Some(3) => "房主的陶瓦网络组件已退出",
                    Some(4) => "房主已关闭局域网世界",
                    Some(5) => "陶瓦联机协议异常",
                    _ => "陶瓦返回未知异常",
                }
            ),
            _ => anyhow::bail!("陶瓦房间状态异常，请重新创建或加入"),
        }
        Ok(update)
    }
}

struct Control<F> {
    client: Client,
    port: u16,
    owns: F,
}
impl<F: Fn() -> Result<bool>> Control<F> {
    fn new(port: u16, owns: F) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(2))
                .build()?,
            port,
            owns,
        })
    }
    async fn get(&self, path: &str, room: Option<&Room>) -> Result<reqwest::Response> {
        ensure!((self.owns)()?, "陶瓦控制端口不属于当前会话");
        let mut url = Url::parse(&format!("http://127.0.0.1:{}{}", self.port, path))?;
        if let Some(r) = room {
            let mut pairs = url.query_pairs_mut();
            if let Some(code) = &r.room {
                pairs.append_pair("room", code);
            }
            if let Some(player) = &r.player {
                pairs.append_pair("player", player);
            }
            for node in &r.nodes {
                pairs.append_pair("public_nodes", node);
            }
        }
        // Request URLs can carry the invitation. Discard them on every error path.
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| e.without_url())?;
        ensure!(
            response.status().is_success(),
            "陶瓦控制接口返回 {}",
            response.status().as_u16()
        );
        Ok(response)
    }
    async fn state(&self) -> Result<State> {
        self.get("/state", None)
            .await?
            .json()
            .await
            .map_err(|_| anyhow::anyhow!("陶瓦状态数据无效"))
    }
    async fn monitor(&self, room: &Room, mut publish: impl FnMut(Update)) -> Result<()> {
        let initial = self.state().await?;
        ensure!(initial.state == "waiting", "陶瓦实例已有活动房间");
        let mut index = initial.index;
        // A timeout can occur after the upstream accepted the request. Read state
        // before deciding the result, and never repeat the mutation.
        let command = self
            .get(
                if room.host {
                    "/state/scanning"
                } else {
                    "/state/guesting"
                },
                Some(room),
            )
            .await;
        let mut started = false;
        let mut failures = 0;
        let mut ready = false;
        loop {
            match self.state().await {
                Ok(state) => {
                    failures = 0;
                    if !started && state.state == "waiting" {
                        if let Err(error) = &command {
                            anyhow::bail!("{error}");
                        }
                        anyhow::bail!("陶瓦未开始创建或加入房间，请重试");
                    }
                    if state.index > index {
                        index = state.index;
                        started = true;
                        let update = state.project(room.host)?;
                        ready = update.ready;
                        publish(update);
                    }
                }
                Err(error) => {
                    failures += 1;
                    if failures >= 3 {
                        return Err(error.context("与陶瓦组件的连接已中断"));
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(if ready { 1500 } else { 500 })).await;
        }
    }
    async fn shutdown(&self) {
        if self.get("/state/ide", None).await.is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(3), async {
                while self.state().await.is_ok_and(|s| s.state != "waiting") {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await;
        }
        let _ = self.get("/panic?peaceful=true", None).await;
    }
}

#[cfg(windows)]
pub(super) async fn run(
    root: &Path,
    exe: &Path,
    room: Room,
    cancel: &CancellationToken,
    publish: impl FnMut(Update),
    invalidate: impl FnOnce(),
) -> Result<()> {
    use super::owned_process::OwnedProcess;
    #[derive(Deserialize)]
    struct Handshake {
        port: u16,
    }
    #[derive(Deserialize)]
    struct Meta {
        version: String,
        target_arch: String,
        target_os: String,
    }
    let directory = tempfile::Builder::new()
        .prefix("terracotta-run-")
        .tempdir_in(root)?;
    let private = std::path::absolute(directory.path())?;
    let handshake = private.join("port.json");
    let process = OwnedProcess::spawn_terracotta(&std::path::absolute(exe)?, &private, &handshake)?;
    let port = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Ok(()),
        result = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                ensure!(process.job_running()?, "陶瓦工作进程已退出");
                match tokio::fs::read(&handshake).await {
                    Ok(bytes) => {
                        let data: Handshake = serde_json::from_slice(&bytes).context("陶瓦握手文件无效")?;
                        ensure!(data.port != 0, "陶瓦控制端口无效");
                        return Ok::<_, anyhow::Error>(data.port);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                    Err(e) => return Err(e.into()),
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }) => result.context("等待陶瓦启动超时")??,
    };
    let api = Control::new(port, || process.owns_listener(port))?;
    let meta: Meta = api
        .get("/meta", None)
        .await?
        .json()
        .await
        .map_err(|_| anyhow::anyhow!("陶瓦版本数据无效"))?;
    ensure!(
        meta.version == component::VERSION
            && meta.target_arch == component::release()?.meta_arch
            && meta.target_os == "windows",
        "陶瓦组件版本或架构不匹配"
    );
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Ok(()),
        result = api.monitor(&room, publish) => result,
    };
    invalidate();
    api.shutdown().await;
    for _ in 0..10 {
        if !process.job_running()? {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    process.stop()?;
    drop(process);
    directory.close().context("清理陶瓦运行目录失败")?;
    result
}

#[cfg(not(windows))]
pub(super) async fn run(
    _: &Path,
    _: &Path,
    _: Room,
    _: &CancellationToken,
    _: impl FnMut(Update),
    _: impl FnOnce(),
) -> Result<()> {
    anyhow::bail!("陶瓦组件目前支持 Windows x64 和 ARM64")
}
