use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{redirect::Policy, StatusCode, Url};

pub(super) mod oauth;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YggdrasilIdentity {
    pub server: String,
    pub server_name: String,
    pub homepage: String,
    pub profile_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YggdrasilLogin {
    pub session_id: String,
    pub server: String,
    pub server_name: String,
    pub profiles: Vec<Profile>,
}

#[derive(Clone)]
pub(super) struct PendingLogin {
    identity: YggdrasilIdentity,
    profiles: Vec<Profile>,
    selected: Option<Profile>,
    tokens: Tokens,
    created: std::time::Instant,
}

// Credentials must never follow an HTTP redirect. Only the initial, credential-
// free discovery request follows redirects / API Location Indication headers.
fn client() -> Result<reqwest::Client> {
    Ok(crate::http_client_builder()
        .redirect(Policy::none())
        .build()?)
}

pub(crate) fn web_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).context("请输入有效的验证服务器网址")?;
    let local = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if value.len() > 2048
        || url.host_str().is_none()
        || !(url.scheme() == "https" || (url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        bail!("验证服务和纹理须使用 HTTPS（本机服务可使用 HTTP），网址不能包含账号、密码或片段");
    }
    Ok(url)
}

pub(crate) fn server_url(value: &str) -> Result<Url> {
    let value = value.trim();
    let mut url = web_url(&if value.contains("://") {
        value.into()
    } else {
        format!("https://{value}")
    })?;
    if url.query().is_some() {
        bail!("验证服务器地址不能包含查询参数");
    }
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

async fn json_response(mut response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    if !status.is_success() {
        // Do not echo server error bodies: some servers include credentials.
        match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                bail!("验证失败：账号或密码错误，或登录已失效，请重新登录")
            }
            StatusCode::TOO_MANY_REQUESTS => bail!("验证请求过于频繁，请稍后重试"),
            _ => bail!(
                "第三方验证服务返回 HTTP {}，请检查 API 地址或稍后重试",
                status.as_u16()
            ),
        }
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.context("无法读取验证服务响应")? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            bail!("验证服务响应过大");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).context("验证服务未返回有效的 JSON，请填写 Yggdrasil API 地址")
}

async fn post(server: &str, operation: &str, body: Value) -> Result<Value> {
    let response = client()?
        .post(server_url(server)?.join(operation)?)
        .timeout(Duration::from_secs(30))
        .json(&body)
        .send()
        .await
        .context("无法连接第三方验证服务，请检查地址和网络")?;
    json_response(response).await
}

fn profile(value: &Value) -> Result<Profile> {
    let id = uuid::Uuid::parse_str(&required(value, "id")?)
        .context("验证服务返回了无效的角色 UUID")?
        .simple()
        .to_string();
    let name = required(value, "name")?;
    if name.chars().count() > 64 || name.chars().any(char::is_control) {
        bail!("验证服务返回了无效的角色名称");
    }
    Ok(Profile { id, name })
}

fn tokens(value: &Value, expected_client: &str) -> Result<Tokens> {
    let client_token = required(value, "clientToken")?;
    if client_token != expected_client {
        bail!("验证服务返回的客户端标识不匹配");
    }
    Ok(Tokens {
        access: required(value, "accessToken")?,
        client_token,
        ..Tokens::default()
    })
}

fn storage_id(server: &str, profile_id: &str) -> String {
    // A separate namespace prevents overwriting a Microsoft account or a
    // profile on a different server that happens to have the same game UUID.
    format!(
        "yggdrasil-{:x}",
        Md5::digest(format!("{server}\0{profile_id}"))
    )
}

impl Accounts {
    pub async fn begin_yggdrasil(
        &self,
        server: &str,
        username: &str,
        password: &str,
    ) -> Result<YggdrasilLogin> {
        if username.trim().is_empty() || password.is_empty() {
            bail!("请输入第三方站点账号和密码");
        }
        let _gate = self.login_gate.lock().await;
        let mut url = server_url(server)?;
        let http = client()?;
        let mut metadata = None;
        for _ in 0..5 {
            let response = http
                .get(url.clone())
                .timeout(Duration::from_secs(20))
                .send()
                .await
                .context("无法读取验证服务器信息")?;
            let location = response
                .headers()
                .get("x-authlib-injector-api-location")
                .or_else(|| {
                    response
                        .status()
                        .is_redirection()
                        .then(|| response.headers().get("location"))
                        .flatten()
                });
            if let Some(location) = location {
                let next = server_url(
                    url.join(location.to_str().context("验证服务器地址指示无效")?)?
                        .as_str(),
                )?;
                if url.scheme() == "https" && next.scheme() != "https" {
                    bail!("验证服务器不能重定向到不安全的 HTTP 地址");
                }
                if next != url {
                    url = next;
                    continue;
                }
            }
            metadata = Some(json_response(response).await?);
            break;
        }
        let metadata = metadata.context("验证服务器地址重定向过多")?;
        if !metadata.is_object() || !metadata["signaturePublickey"].is_string() {
            bail!("该地址不是兼容 authlib-injector 的 Yggdrasil API");
        }
        let server = url.to_string();
        let server_name = metadata["meta"]["serverName"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(url.host_str().unwrap_or("Yggdrasil"))
            .chars()
            .take(100)
            .collect::<String>();
        let homepage = metadata["meta"]["links"]["homepage"]
            .as_str()
            .and_then(|s| web_url(s).ok())
            .unwrap_or_else(|| url.join("/").unwrap())
            .to_string();
        let client_token = uuid::Uuid::new_v4().simple().to_string();
        let response = post(
            &server,
            "authserver/authenticate",
            json!({
                "agent": {"name": "Minecraft", "version": 1}, "username": username.trim(),
                "password": password, "clientToken": client_token, "requestUser": false,
            }),
        )
        .await?;
        let credentials = tokens(&response, &client_token)?;
        let selected = response
            .get("selectedProfile")
            .filter(|p| !p.is_null())
            .map(profile)
            .transpose()?;
        let profiles = if let Some(selected) = &selected {
            vec![selected.clone()]
        } else {
            response["availableProfiles"]
                .as_array()
                .into_iter()
                .flatten()
                .map(profile)
                .collect::<Result<Vec<_>>>()?
        };
        if profiles.is_empty() {
            bail!("此账号还没有游戏角色，请先在验证站点创建角色");
        }
        let session_id = uuid::Uuid::new_v4().to_string();
        let mut pending = self
            .yggdrasil_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        pending.retain(|_, p| p.created.elapsed() < Duration::from_secs(600));
        if pending.len() >= 16 {
            pending.clear();
        }
        pending.insert(
            session_id.clone(),
            PendingLogin {
                identity: YggdrasilIdentity {
                    server: server.clone(),
                    server_name: server_name.clone(),
                    homepage,
                    profile_id: String::new(),
                },
                profiles: profiles.clone(),
                selected,
                tokens: credentials,
                created: std::time::Instant::now(),
            },
        );
        Ok(YggdrasilLogin {
            session_id,
            server,
            server_name,
            profiles,
        })
    }

    pub fn cancel_yggdrasil(&self, session: &str) {
        if let Some(flow) = self
            .littleskin_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session)
        {
            flow.cancel.cancel();
        }
        self.yggdrasil_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session);
    }

    pub async fn complete_yggdrasil(&self, session: &str, profile_id: &str) -> Result<Player> {
        let _gate = self.login_gate.lock().await;
        let mut pending = self
            .yggdrasil_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session)
            .filter(|p| p.created.elapsed() < Duration::from_secs(600))
            .cloned()
            .context("角色选择已过期，请重新登录")?;
        let chosen = pending
            .profiles
            .iter()
            .find(|p| p.id == profile_id)
            .cloned()
            .context("请选择此账号拥有的角色")?;
        if pending.selected.is_none() {
            if let Some(oauth) = &pending.tokens.littleskin {
                if oauth.expires_at <= now() + 30 {
                    pending.tokens.littleskin = Some(self.renew_littleskin(oauth).await?);
                    let mut sessions = self
                        .yggdrasil_pending
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    let saved = sessions.get_mut(session).context("登录已取消")?;
                    // Preserve rotated credentials for a retry if the next API fails.
                    *saved = pending.clone();
                }
            }
            let response = if let Some(oauth) = &pending.tokens.littleskin {
                self.littleskin_minecraft_token(oauth, &chosen.id).await?
            } else {
                post(&pending.identity.server, "authserver/refresh", json!({
                "accessToken": pending.tokens.access, "clientToken": pending.tokens.client_token,
                "selectedProfile": chosen,
                })).await?
            };
            let selected = profile(&response["selectedProfile"])?;
            if selected.id != chosen.id {
                bail!("验证服务返回的角色与所选角色不一致");
            }
            let expected_client = if pending.tokens.littleskin.is_some() {
                required(&response, "clientToken")?
            } else {
                pending.tokens.client_token.clone()
            };
            let oauth = pending.tokens.littleskin.take();
            pending.tokens = tokens(&response, &expected_client)?;
            pending.tokens.littleskin = oauth;
            pending.selected = Some(selected);
            let mut sessions = self
                .yggdrasil_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if !sessions.contains_key(session) {
                bail!("登录已取消");
            }
            sessions.insert(session.into(), pending.clone());
        }
        let selected = pending.selected.as_ref().context("尚未选择角色")?;
        if selected.id != chosen.id {
            bail!("登录已绑定其他角色，请重新登录");
        }
        pending.identity.profile_id = selected.id.clone();
        let mut player = Player {
            uuid: storage_id(&pending.identity.server, &selected.id),
            name: selected.name.clone(),
            online: true,
            skin: String::new(),
            cape: String::new(),
            capes: None,
            slim: false,
            yggdrasil: Some(pending.identity),
        };
        self.yggdrasil_textures(&mut player).await;
        // Cancellation may happen during the profile request. Keep the pending
        // lock through persistence so a cancelled login cannot save afterward.
        let mut sessions = self
            .yggdrasil_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !sessions.contains_key(session) {
            bail!("登录已取消");
        }
        self.save_yggdrasil(&player, pending.tokens, false)?;
        self.select(&player.uuid)?;
        sessions.remove(session);
        Ok(player)
    }

    pub(super) async fn refresh_yggdrasil(&self, mut player: Player) -> Result<Player> {
        let identity = player.yggdrasil.as_ref().context("缺少验证服务器信息")?;
        let credentials = self
            .vault
            .get(&player.uuid)
            .context("缺少第三方登录凭据，请重新登录")?;
        if credentials.littleskin.is_some() {
            return self.refresh_littleskin(player, credentials).await;
        }
        // A bound token must be refreshed WITHOUT selectedProfile. Yggdrasil
        // invalidates the old access token and returns the same bound profile.
        let response = post(
            &identity.server,
            "authserver/refresh",
            json!({
                "accessToken": credentials.access, "clientToken": credentials.client_token,
            }),
        )
        .await?;
        let selected = profile(&response["selectedProfile"])?;
        if selected.id != identity.profile_id {
            bail!("刷新返回的角色与当前账号不一致，请重新登录");
        }
        let credentials = tokens(&response, &credentials.client_token)?;
        player.name = selected.name;
        // Save rotated credentials even if the optional texture lookup fails.
        self.save_yggdrasil(&player, credentials.clone(), true)?;
        self.yggdrasil_textures(&mut player).await;
        self.save_yggdrasil(&player, credentials, true)?;
        Ok(player)
    }

    fn save_yggdrasil(&self, player: &Player, credentials: Tokens, existing: bool) -> Result<()> {
        let mut players = self.players.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = players.clone();
        if let Some(entry) = next.iter_mut().find(|p| p.uuid == player.uuid) {
            *entry = player.clone();
        } else if existing {
            bail!("角色已移除");
        } else {
            next.push(player.clone());
        }
        self.vault.put(&player.uuid, credentials)?;
        self.save(&next)?;
        *players = next;
        Ok(())
    }

    async fn yggdrasil_textures(&self, player: &mut Player) {
        let result = async {
            let identity = player.yggdrasil.as_ref().context("缺少验证服务器")?;
            let url = server_url(&identity.server)?.join(&format!(
                "sessionserver/session/minecraft/profile/{}",
                identity.profile_id
            ))?;
            let response = client()?
                .get(url)
                .timeout(Duration::from_secs(15))
                .send()
                .await?;
            let value = json_response(response).await?;
            if profile(&value)?.id != identity.profile_id {
                bail!("纹理角色不匹配");
            }
            let Some(encoded) = value["properties"]
                .as_array()
                .and_then(|p| p.iter().find(|p| p["name"] == "textures"))
                .and_then(|p| p["value"].as_str())
            else {
                return Ok((String::new(), String::new(), false));
            };
            let texture: Value = serde_json::from_slice(&STANDARD.decode(encoded)?)?;
            let skin = texture["textures"]["SKIN"]["url"]
                .as_str()
                .and_then(|s| web_url(s).ok())
                .map(|s| s.to_string())
                .unwrap_or_default();
            let cape = texture["textures"]["CAPE"]["url"]
                .as_str()
                .and_then(|s| web_url(s).ok())
                .map(|s| s.to_string())
                .unwrap_or_default();
            Ok::<_, anyhow::Error>((
                skin,
                cape,
                texture["textures"]["SKIN"]["metadata"]["model"] == "slim",
            ))
        }
        .await;
        if let Ok((skin, cape, slim)) = result {
            player.skin = skin;
            player.cape = cape;
            player.slim = slim;
        }
    }
}

#[cfg(all(test, windows))]
mod tests;
