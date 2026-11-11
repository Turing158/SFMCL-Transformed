use super::*;
use crate::vault::LittleSkinTokens;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

// LittleSkin's device grant uses a different origin from its Yggdrasil API.
// Never derive either credential endpoint from user input or a redirect.
pub(crate) struct Endpoints {
    pub oauth: String,
    pub yggdrasil: String,
}
impl Default for Endpoints {
    fn default() -> Self {
        Self {
            oauth: "https://open.littleskin.cn/oauth/".into(),
            yggdrasil: "https://littleskin.cn/api/yggdrasil/".into(),
        }
    }
}
const SCOPE: &str = "Yggdrasil.PlayerProfiles.Read Yggdrasil.MinecraftToken.Create offline_access";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthDeviceLogin {
    pub session_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
}

pub(crate) struct Flow {
    pub cancel: CancellationToken,
    deadline: Instant,
    grant: Mutex<Option<DeviceGrant>>,
}
struct DeviceGrant {
    client_id: String,
    device_code: String,
    interval: Duration,
}

fn oauth_error(code: &str) -> &'static str {
    match code {
        "invalid_client" | "unauthorized_client" => {
            "LittleSkin 应用未获准使用设备代码流，请检查 Client ID 和白名单状态"
        }
        "invalid_scope" => {
            "LittleSkin 应用缺少角色读取、Minecraft 令牌或离线访问权限，请检查白名单授权范围"
        }
        "access_denied" | "authorization_declined" => "你已拒绝 LittleSkin 授权，可重新发起登录",
        "expired_token" => "LittleSkin 授权码已过期，请重新登录",
        "invalid_grant" => "LittleSkin 授权已失效或被撤销，请重新登录",
        "invalid_request" => "LittleSkin 授权请求无效，请更新启动器或联系维护者",
        "server_error" => "LittleSkin 授权服务内部错误，请稍后重试",
        "temporarily_unavailable" => "LittleSkin 授权服务暂时不可用，请稍后重试",
        _ => "LittleSkin 授权失败，请稍后重试",
    }
}

async fn response_json(mut response: reqwest::Response) -> Result<(StatusCode, Value)> {
    let status = response.status();
    if status.is_redirection() {
        bail!("LittleSkin 授权接口发生重定向，请稍后重试");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.context("无法读取 LittleSkin 响应")? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            bail!("LittleSkin 响应过大");
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice(&bytes)
        .with_context(|| format!("LittleSkin 返回了无效响应（HTTP {}）", status.as_u16()))?;
    Ok((status, value))
}

fn accepted(status: StatusCode, value: Value) -> Result<Value> {
    let code = value["error"].as_str();
    // OAuth errors have a known vocabulary. Other endpoints return Yggdrasil
    // or HTTP error names (e.g. "Not Found"), which must retain their HTTP cause.
    // Never echo arbitrary error text: it can include credentials.
    if let Some(code) = code.filter(|code| {
        matches!(
            *code,
            "invalid_client"
                | "unauthorized_client"
                | "invalid_scope"
                | "access_denied"
                | "authorization_declined"
                | "expired_token"
                | "invalid_grant"
                | "invalid_request"
                | "server_error"
                | "temporarily_unavailable"
        )
    }) {
        bail!(
            "{}（HTTP {}，错误码 {}）",
            oauth_error(code),
            status.as_u16(),
            code
        );
    }
    if status == StatusCode::UNAUTHORIZED {
        bail!("LittleSkin 授权已失效，请重新登录（HTTP 401）");
    }
    if status == StatusCode::FORBIDDEN || value["code"].as_i64() == Some(403) {
        bail!(
            "LittleSkin 拒绝访问，请重新授权或检查令牌、权限及应用白名单（HTTP {}）",
            status.as_u16()
        );
    }
    if status == StatusCode::NOT_FOUND {
        bail!("LittleSkin 接口不存在（HTTP 404），请更新启动器或联系维护者");
    }
    if !status.is_success() {
        bail!("LittleSkin 服务返回 HTTP {}，请稍后重试", status.as_u16());
    }
    if code.is_some() {
        bail!(
            "LittleSkin 返回了无法识别的服务错误（HTTP {}），请联系维护者",
            status.as_u16()
        );
    }
    Ok(value)
}

fn oauth_tokens(value: &Value, client_id: &str) -> Result<LittleSkinTokens> {
    if !required(value, "token_type")?.eq_ignore_ascii_case("Bearer") {
        bail!("LittleSkin 返回的令牌类型无效");
    }
    let expires = value["expires_in"]
        .as_u64()
        .filter(|v| *v > 0)
        .context("LittleSkin 未返回有效的令牌有效期")?;
    Ok(LittleSkinTokens {
        client_id: client_id.into(),
        access: required(value, "access_token")?,
        refresh: required(value, "refresh_token")
            .context("LittleSkin 未授予离线访问权限，请重新授权")?,
        expires_at: now().saturating_add(expires),
    })
}

impl Accounts {
    async fn littleskin_token_request(&self, form: &[(&str, &str)]) -> Result<(StatusCode, Value)> {
        let response = client()?
            .post(server_url(&self.littleskin_endpoints.oauth)?.join("token")?)
            .header("Accept", "application/json")
            .timeout(Duration::from_secs(30))
            .form(form)
            .send()
            .await
            .context("无法连接 LittleSkin 授权服务")?;
        response_json(response).await
    }

    pub async fn begin_littleskin(&self) -> Result<OAuthDeviceLogin> {
        let client_id = self.vault.littleskin_client_id()?;
        let base = server_url(&self.littleskin_endpoints.oauth)?;
        let response = client()?
            .post(base.join("device_code")?)
            .header("Accept", "application/json")
            .timeout(Duration::from_secs(30))
            .form(&[("client_id", client_id.as_str()), ("scope", SCOPE)])
            .send()
            .await
            .context("无法获取 LittleSkin 授权码")?;
        let (status, value) = response_json(response)
            .await
            .context("获取 LittleSkin 授权码失败")?;
        let value = accepted(status, value).context("获取 LittleSkin 授权码失败")?;
        let expires_in = value["expires_in"]
            .as_u64()
            .filter(|v| (1..=3600).contains(v))
            .context("LittleSkin 返回的授权码有效期无效")?;
        let verification_uri = required(&value, "verification_uri")?;
        let verification_uri_complete = value["verification_uri_complete"]
            .as_str()
            .map(str::to_owned);
        for uri in std::iter::once(&verification_uri).chain(verification_uri_complete.iter()) {
            let url = web_url(uri)?;
            if url.origin() != base.origin() {
                bail!("LittleSkin 返回了不可信的授权页面地址");
            }
        }
        let user_code = required(&value, "user_code")?;
        let device_code = required(&value, "device_code")?;
        let interval = value["interval"].as_u64().unwrap_or(5).max(1);
        if interval > 3600 {
            bail!("LittleSkin 返回的轮询间隔无效");
        }
        let session_id = uuid::Uuid::new_v4().to_string();
        let mut sessions = self
            .littleskin_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        sessions.retain(|_, flow| {
            if Instant::now() >= flow.deadline {
                flow.cancel.cancel();
                false
            } else {
                true
            }
        });
        if sessions.len() >= 16 {
            bail!("已有过多 LittleSkin 授权请求，请先取消或等待过期");
        }
        sessions.insert(
            session_id.clone(),
            Arc::new(Flow {
                cancel: CancellationToken::new(),
                deadline: Instant::now() + Duration::from_secs(expires_in),
                grant: Mutex::new(Some(DeviceGrant {
                    client_id,
                    device_code,
                    interval: Duration::from_secs(interval),
                })),
            }),
        );
        Ok(OAuthDeviceLogin {
            session_id,
            user_code,
            verification_uri,
            verification_uri_complete,
            expires_in,
        })
    }

    pub async fn wait_littleskin(&self, session: &str) -> Result<YggdrasilLogin> {
        let flow = self
            .littleskin_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session)
            .cloned()
            .context("LittleSkin 授权已取消或过期")?;
        let grant = flow
            .grant
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .context("正在等待 LittleSkin 授权，请勿重复请求")?;
        let result = tokio::select! {
            biased;
            _ = flow.cancel.cancelled() => Err(anyhow::anyhow!("LittleSkin 登录已取消")),
            _ = tokio::time::sleep_until(flow.deadline) => Err(anyhow::anyhow!(oauth_error("expired_token"))),
            result = self.poll_littleskin(grant) => result,
        };
        // Serialize publication with cancellation; no late result can revive a
        // cancelled login. Tokens remain in memory until a profile is chosen.
        let mut sessions = self
            .littleskin_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        sessions.remove(session);
        if flow.cancel.is_cancelled() {
            bail!("LittleSkin 登录已取消");
        }
        let (credentials, profiles) = result?;
        let server = self.littleskin_endpoints.yggdrasil.clone();
        let server_name = "LittleSkin".to_owned();
        let mut pending = self
            .yggdrasil_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        pending.retain(|_, p| p.created.elapsed() < Duration::from_secs(600));
        if pending.len() >= 16 {
            bail!("待选择的账号过多，请先完成已有登录");
        }
        pending.insert(
            session.into(),
            PendingLogin {
                identity: YggdrasilIdentity {
                    server: server.clone(),
                    server_name: server_name.clone(),
                    homepage: "https://littleskin.cn/".into(),
                    profile_id: String::new(),
                },
                profiles: profiles.clone(),
                selected: None,
                tokens: Tokens {
                    littleskin: Some(credentials),
                    ..Tokens::default()
                },
                created: std::time::Instant::now(),
            },
        );
        Ok(YggdrasilLogin {
            session_id: session.into(),
            server,
            server_name,
            profiles,
        })
    }

    async fn poll_littleskin(
        &self,
        mut grant: DeviceGrant,
    ) -> Result<(LittleSkinTokens, Vec<Profile>)> {
        let value = loop {
            tokio::time::sleep(grant.interval).await;
            let result = self
                .littleskin_token_request(&[
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                    ("client_id", &grant.client_id),
                    ("device_code", &grant.device_code),
                ])
                .await;
            let (status, value) = match result {
                Ok(response) => response,
                Err(error)
                    if error.chain().any(|e| {
                        e.downcast_ref::<reqwest::Error>()
                            .is_some_and(|e| e.is_timeout())
                    }) =>
                {
                    grant.interval = grant.interval.saturating_mul(2);
                    continue;
                }
                Err(error) => return Err(error),
            };
            match value["error"].as_str() {
                Some("authorization_pending") => continue,
                Some("slow_down") => {
                    grant.interval += Duration::from_secs(5);
                    continue;
                }
                _ => {
                    break accepted(status, value).context("获取 LittleSkin 授权结果失败")?;
                }
            }
        };
        let credentials = oauth_tokens(&value, &grant.client_id)?;
        // The deployed LittleSkin service uses the singular collection route;
        // the older OpenAPI document's /profiles route returns HTTP 404.
        let response = client()?
            .get(
                server_url(&self.littleskin_endpoints.yggdrasil)?
                    .join("sessionserver/session/minecraft/profile")?,
            )
            .header("Accept", "application/json")
            .bearer_auth(&credentials.access)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .context("无法读取 LittleSkin 角色列表")?;
        let (status, value) = response_json(response)
            .await
            .context("读取 LittleSkin 角色列表失败")?;
        let value = accepted(status, value).context("读取 LittleSkin 角色列表失败")?;
        let profiles = value
            .as_array()
            .context("LittleSkin 返回的角色列表无效")?
            .iter()
            .map(profile)
            .collect::<Result<Vec<_>>>()?;
        if profiles.is_empty() {
            bail!("此账号还没有游戏角色，请先在 LittleSkin 创建角色");
        }
        Ok((credentials, profiles))
    }

    pub(super) async fn littleskin_minecraft_token(
        &self,
        oauth: &LittleSkinTokens,
        id: &str,
    ) -> Result<Value> {
        let response = client()?
            .post(server_url(&self.littleskin_endpoints.yggdrasil)?.join("authserver/oauth")?)
            .header("Accept", "application/json")
            .bearer_auth(&oauth.access)
            .timeout(Duration::from_secs(30))
            .json(&json!({"uuid": id}))
            .send()
            .await
            .context("无法获取 LittleSkin Minecraft 令牌")?;
        let (status, value) = response_json(response)
            .await
            .context("获取 LittleSkin Minecraft 令牌失败")?;
        accepted(status, value).context("获取 LittleSkin Minecraft 令牌失败")
    }

    pub(super) async fn renew_littleskin(
        &self,
        oauth: &LittleSkinTokens,
    ) -> Result<LittleSkinTokens> {
        let (status, value) = self
            .littleskin_token_request(&[
                ("grant_type", "refresh_token"),
                ("client_id", &oauth.client_id),
                ("refresh_token", &oauth.refresh),
            ])
            .await?;
        oauth_tokens(
            &accepted(status, value).context("刷新 LittleSkin 授权失败")?,
            &oauth.client_id,
        )
    }

    pub(super) async fn refresh_littleskin(
        &self,
        mut player: Player,
        mut credentials: Tokens,
    ) -> Result<Player> {
        let identity = player.yggdrasil.as_ref().context("缺少验证服务器信息")?;
        if identity.server != self.littleskin_endpoints.yggdrasil {
            bail!("LittleSkin 授权与验证服务器不匹配，请重新登录");
        }
        let oauth = credentials
            .littleskin
            .as_ref()
            .context("缺少 LittleSkin 授权")?;
        // Refresh on each account refresh/launch, so a revoked grant is not
        // silently bypassed by continuing to use an old Minecraft token.
        let oauth = self.renew_littleskin(oauth).await?;
        credentials.littleskin = Some(oauth.clone());
        // Rotation invalidates the old refresh token immediately. Persist it
        // before the next request, even if minting a Minecraft token then fails.
        self.save_yggdrasil(&player, credentials.clone(), true)?;
        let response = self
            .littleskin_minecraft_token(&oauth, &identity.profile_id)
            .await?;
        let selected = profile(&response["selectedProfile"])?;
        if selected.id != identity.profile_id {
            bail!("LittleSkin 返回的角色与当前账号不一致，请重新登录");
        }
        let mut credentials = tokens(&response, &required(&response, "clientToken")?)?;
        credentials.littleskin = Some(oauth);
        player.name = selected.name;
        self.save_yggdrasil(&player, credentials.clone(), true)?;
        self.yggdrasil_textures(&mut player).await;
        self.save_yggdrasil(&player, credentials, true)?;
        Ok(player)
    }
}

#[cfg(all(test, windows))]
mod tests;
