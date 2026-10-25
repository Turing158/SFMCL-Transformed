use crate::{
    config::ConfigStore,
    downloads::now,
    jobs::{Job, JobKind, Jobs},
    minecraft::launch::LaunchIdentity,
    paths::{atomic_write, safe_join},
    vault::{Tokens, Vault},
};
use anyhow::{bail, Context, Result};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    pub uuid: String,
    pub name: String,
    pub online: bool,
    pub skin: String,
    #[serde(default)]
    pub cape: String,
    #[serde(default)]
    pub slim: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLogin {
    pub job_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
}
pub struct Accounts {
    path: PathBuf,
    players: Mutex<Vec<Player>>,
    pub vault: Arc<Vault>,
    config: Arc<ConfigStore>,
    client: reqwest::Client,
    jobs: Arc<Jobs>,
    login_gate: Arc<tokio::sync::Mutex<()>>,
}

pub fn offline_uuid(name: &str) -> String {
    let mut bytes: [u8; 16] = Md5::digest(format!("OfflinePlayer:{name}").as_bytes()).into();
    bytes[6] = (bytes[6] & 0x0f) | 0x30;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).simple().to_string()
}
fn valid_player_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 16
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        bail!("角色名需要 1–16 个英文字母、数字或下划线");
    }
    Ok(())
}
impl Accounts {
    pub fn open(
        directory: &Path,
        vault: Arc<Vault>,
        config: Arc<ConfigStore>,
        jobs: Arc<Jobs>,
    ) -> Result<Arc<Self>> {
        let path = directory.join("players.json");
        let players = if path.exists() {
            serde_json::from_slice(&std::fs::read(&path)?).context("角色配置损坏")?
        } else {
            vec![]
        };
        Ok(Arc::new(Self {
            path,
            players: Mutex::new(players),
            vault,
            config,
            client: crate::http_client()?,
            jobs,
            login_gate: Arc::new(tokio::sync::Mutex::new(())),
        }))
    }
    pub fn list(&self) -> Vec<Player> {
        self.players
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    fn save(&self, players: &[Player]) -> Result<()> {
        atomic_write(&self.path, &serde_json::to_vec_pretty(players)?)
    }
    fn upsert(&self, player: Player) -> Result<()> {
        let mut players = self.players.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = players.clone();
        if let Some(existing) = next.iter_mut().find(|p| p.uuid == player.uuid) {
            *existing = player;
        } else {
            next.push(player);
        }
        self.save(&next)?;
        *players = next;
        Ok(())
    }
    pub fn add_offline(&self, name: &str) -> Result<Player> {
        valid_player_name(name)?;
        if self.list().iter().any(|p| !p.online && p.name == name) {
            bail!("角色已存在");
        }
        let player = Player {
            uuid: offline_uuid(name),
            name: name.into(),
            online: false,
            skin: String::new(),
            cape: String::new(),
            slim: false,
        };
        self.upsert(player.clone())?;
        self.select(&player.uuid)?;
        Ok(player)
    }
    pub fn select(&self, id: &str) -> Result<()> {
        if !self.list().iter().any(|p| p.uuid == id) {
            bail!("角色不存在");
        }
        self.config.update(|s| s.active_player = id.into())?;
        Ok(())
    }
    pub fn remove(&self, id: &str) -> Result<()> {
        let mut players = self.players.lock().unwrap_or_else(|e| e.into_inner());
        let next: Vec<_> = players.iter().filter(|p| p.uuid != id).cloned().collect();
        if next.len() == players.len() {
            bail!("角色不存在");
        }
        self.vault.remove(id)?;
        self.save(&next)?;
        *players = next;
        self.config.update(|s| {
            if s.active_player == id {
                s.active_player = players.first().map(|p| p.uuid.clone()).unwrap_or_default();
            }
        })?;
        Ok(())
    }
    pub fn rename(&self, id: &str, name: &str) -> Result<Player> {
        valid_player_name(name)?;
        let mut players = self.players.lock().unwrap_or_else(|e| e.into_inner());
        if players
            .iter()
            .any(|p| p.uuid != id && !p.online && p.name == name)
        {
            bail!("角色名已存在");
        }
        let mut next = players.clone();
        let player = next
            .iter_mut()
            .find(|p| p.uuid == id)
            .context("角色不存在")?;
        if player.online {
            bail!("正版角色名称请在 Minecraft 账号页面修改");
        }
        player.name = name.into();
        player.uuid = offline_uuid(name);
        let result = player.clone();
        self.save(&next)?;
        *players = next;
        self.config.update(|s| {
            if s.active_player == id {
                s.active_player = result.uuid.clone();
            }
        })?;
        Ok(result)
    }
    pub fn skin(&self, id: &str, path: Option<&Path>, slim: bool) -> Result<Player> {
        let mut player = self
            .list()
            .into_iter()
            .find(|p| p.uuid == id)
            .context("角色不存在")?;
        if player.online {
            bail!("正版皮肤请在 Minecraft 账号页面修改后刷新角色");
        }
        player.skin = if let Some(path) = path {
            let bytes = std::fs::read(path)?;
            validate_skin(&bytes)?;
            let directory = self.path.parent().context("配置目录无效")?;
            let target = safe_join(directory, format!("skins/{id}.png"))?;
            atomic_write(&target, &bytes)?;
            target.to_string_lossy().into_owned()
        } else {
            String::new()
        };
        player.slim = slim;
        self.upsert(player.clone())?;
        Ok(player)
    }
    pub async fn texture_image(&self, source: &str) -> Result<Vec<u8>> {
        let players = self.list();
        let kind = if players.iter().any(|player| player.skin == source) {
            TextureKind::Skin
        } else if players
            .iter()
            .any(|player| player.online && player.cape == source)
        {
            TextureKind::Cape
        } else {
            bail!("纹理地址不属于已保存角色的皮肤或已装备披风");
        };
        // Minecraft profiles can still contain HTTP texture URLs. Fetch over
        // HTTPS in Rust so WebView CSP/CORS cannot prevent canvas rendering.
        let url = official_texture_url(source)?;
        let response = self
            .client
            .get(url)
            .timeout(Duration::from_secs(20))
            .send()
            .await?;
        read_texture_image(response, kind).await
    }
    fn client_id(&self) -> Result<String> {
        let id = self.config.get().microsoft_client_id;
        if id.trim().is_empty() {
            bail!("请在设置中填写 Microsoft 应用 Client ID");
        }
        Ok(id)
    }
    pub async fn begin_login(self: &Arc<Self>) -> Result<DeviceLogin> {
        let gate = self
            .login_gate
            .clone()
            .try_lock_owned()
            .context("已有微软登录正在进行")?;
        let client_id = self.client_id()?;
        let response = self
            .client
            .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode")
            .form(&[
                ("client_id", client_id.as_str()),
                ("scope", "XboxLive.signin offline_access"),
            ])
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let device_code = required(&response, "device_code")?;
        let user_code = required(&response, "user_code")?;
        let expires_in = response["expires_in"].as_u64().unwrap_or(900);
        let interval = response["interval"].as_u64().unwrap_or(5).max(1);
        let verification_uri = response["verification_uri"]
            .as_str()
            .unwrap_or("https://www.microsoft.com/link")
            .into();
        let job = self.jobs.create(
            JobKind::Login,
            "微软账号登录".into(),
            &[
                "等待浏览器授权",
                "验证 Xbox Live",
                "验证 Minecraft 账号",
                "保存角色",
            ],
        );
        job.step(0, "请在浏览器输入设备代码，完成后会自动继续");
        let job_id = job.snapshot().id;
        let accounts = self.clone();
        tokio::spawn(async move {
            let _gate = gate;
            let result = accounts
                .poll_login(client_id, device_code, interval, expires_in, job.clone())
                .await;
            job.finish(&result);
        });
        Ok(DeviceLogin {
            job_id,
            user_code,
            verification_uri,
            expires_in,
        })
    }
    async fn poll_login(
        &self,
        client_id: String,
        code: String,
        mut interval: u64,
        expires: u64,
        job: Arc<Job>,
    ) -> Result<()> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(expires);
        loop {
            if tokio::time::Instant::now() >= deadline {
                bail!("设备代码已过期，请重新登录");
            }
            tokio::select! { _=job.cancel.cancelled()=>bail!(job.cancellation_message()), _=tokio::time::sleep(Duration::from_secs(interval))=>{} }
            let request = self
                .client
                .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
                .form(&[
                    ("client_id", client_id.as_str()),
                    ("device_code", code.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ])
                .send();
            let response = tokio::select! { _=job.cancel.cancelled()=>bail!(job.cancellation_message()), r=request=>r? };
            let ok = response.status().is_success();
            let value: Value = response.json().await?;
            if ok {
                self.exchange(&value, job).await?;
                return Ok(());
            }
            match value["error"].as_str() {
                Some("authorization_pending") => {}
                Some("slow_down") => interval += 5,
                Some("authorization_declined") => bail!("你已拒绝微软授权"),
                Some("expired_token") => bail!("设备代码已过期"),
                _ => bail!(
                    "微软登录失败：{}",
                    value["error"].as_str().unwrap_or("unknown_error")
                ),
            }
        }
    }
    async fn exchange(&self, token: &Value, job: Arc<Job>) -> Result<Player> {
        let msa = required(token, "access_token")?;
        let refresh = required(token, "refresh_token")?;
        job.step(1, "验证 Xbox Live 与 XSTS");
        let xbox=self.post_json("https://user.auth.xboxlive.com/user/authenticate",json!({"Properties":{"AuthMethod":"RPS","SiteName":"user.auth.xboxlive.com","RpsTicket":format!("d={msa}")},"RelyingParty":"http://auth.xboxlive.com","TokenType":"JWT"}),&job).await?;
        let xbox_token = required(&xbox, "Token")?;
        let xsts=self.post_json("https://xsts.auth.xboxlive.com/xsts/authorize",json!({"Properties":{"SandboxId":"RETAIL","UserTokens":[xbox_token]},"RelyingParty":"rp://api.minecraftservices.com/","TokenType":"JWT"}),&job).await?;
        let uhs = xsts["DisplayClaims"]["xui"][0]["uhs"]
            .as_str()
            .context("XSTS 未返回用户标识")?;
        let xsts_token = required(&xsts, "Token")?;
        job.step(2, "获取 Minecraft 游戏资料");
        let minecraft = self
            .post_json(
                "https://api.minecraftservices.com/authentication/login_with_xbox",
                json!({"identityToken":format!("XBL3.0 x={uhs};{xsts_token}")}),
                &job,
            )
            .await?;
        let access = required(&minecraft, "access_token")?;
        let request = self
            .client
            .get("https://api.minecraftservices.com/minecraft/profile")
            .bearer_auth(&access)
            .send();
        let response = tokio::select! { _=job.cancel.cancelled()=>bail!(job.cancellation_message()),r=request=>r? };
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            bail!("此微软账号没有可用的 Minecraft Java 版角色，请先购买或创建角色");
        }
        let profile: Value = response.error_for_status()?.json().await?;
        let player = player_from_profile(&profile)?;
        if job.cancel.is_cancelled() {
            bail!(job.cancellation_message());
        }
        job.step(3, "安全保存账号凭据");
        self.vault.put(
            &player.uuid,
            Tokens {
                access,
                refresh,
                expires_at: now() + minecraft["expires_in"].as_u64().unwrap_or(86400),
            },
        )?;
        self.upsert(player.clone())?;
        self.select(&player.uuid)?;
        Ok(player)
    }
    async fn post_json(&self, url: &str, body: Value, job: &Job) -> Result<Value> {
        let request = self.client.post(url).json(&body).send();
        let response = tokio::select! {_=job.cancel.cancelled()=>bail!(job.cancellation_message()),r=request=>r?};
        let status = response.status();
        let value: Value = response.json().await?;
        if !status.is_success() {
            if let Some(error) = value["XErr"].as_u64() {
                bail!("Xbox 账号验证失败 ({error})，请检查 Xbox 档案、家庭权限及所在地区");
            }
            bail!("账号服务返回 HTTP {}", status.as_u16());
        }
        Ok(value)
    }
    pub async fn refresh(self: &Arc<Self>, id: &str) -> Result<Player> {
        let _gate = self.login_gate.lock().await;
        let player = self
            .list()
            .into_iter()
            .find(|p| p.uuid == id)
            .context("角色不存在")?;
        if !player.online {
            return Ok(player);
        }
        let credentials = self
            .vault
            .get(id)
            .context("缺少刷新凭据，请重新登录微软账号")?;
        let job = self.jobs.create(
            JobKind::LoginRefresh,
            "刷新微软登录".into(),
            &[
                "刷新微软凭据",
                "验证 Xbox Live",
                "验证 Minecraft 账号",
                "保存角色",
            ],
        );
        let result = async {
            job.step(0, "刷新微软凭据");
            let response = self
                .client
                .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
                .form(&[
                    ("client_id", self.client_id()?),
                    ("refresh_token", credentials.refresh),
                    ("grant_type", "refresh_token".into()),
                    ("scope", "XboxLive.signin offline_access".into()),
                ])
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await?;
            self.exchange(&response, job.clone()).await
        }
        .await;
        job.finish(
            &result
                .as_ref()
                .map(|_| ())
                .map_err(|e| anyhow::anyhow!("{e:#}")),
        );
        result
    }
    pub async fn launch_identity(self: &Arc<Self>, id: &str) -> Result<LaunchIdentity> {
        let mut player = self
            .list()
            .into_iter()
            .find(|p| p.uuid == id)
            .context("请先选择角色")?;
        if player.online
            && self
                .vault
                .get(id)
                .is_none_or(|t| t.expires_at < now() + 120)
        {
            player = self.refresh(id).await?;
        }
        Ok(LaunchIdentity {
            name: player.name,
            uuid: player.uuid.clone(),
            online: player.online,
            access_token: self
                .vault
                .get(&player.uuid)
                .map(|t| t.access)
                .unwrap_or_default(),
        })
    }
    pub fn import_legacy(&self, value: &Value) -> Result<usize> {
        let mut count = 0;
        for p in value["player"]["players"].as_array().into_iter().flatten() {
            let Some(name) = p["Name"].as_str() else {
                continue;
            };
            let online = p["IsOnline"].as_bool().unwrap_or(false);
            let id = p["UUID"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| offline_uuid(name));
            uuid::Uuid::parse_str(&id).context("旧角色 UUID 无效")?;
            if online {
                self.vault.put(
                    &id,
                    Tokens {
                        access: p["AccessToken"].as_str().unwrap_or("").into(),
                        refresh: p["RefreshToken"].as_str().unwrap_or("").into(),
                        expires_at: 0,
                    },
                )?;
            }
            let skin = p["Skin"].as_str().unwrap_or("");
            self.upsert(Player {
                uuid: id,
                name: name.into(),
                online,
                skin: if skin.starts_with("pack:") {
                    String::new()
                } else {
                    skin.into()
                },
                cape: String::new(),
                slim: false,
            })?;
            count += 1;
        }
        Ok(count)
    }
}
fn required(value: &Value, key: &str) -> Result<String> {
    value[key]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .with_context(|| format!("账号响应缺少 {key}"))
}
fn player_from_profile(profile: &Value) -> Result<Player> {
    let skin = profile["skins"].as_array().and_then(|skins| {
        skins
            .iter()
            .find(|s| s["state"] == "ACTIVE")
            .or(skins.first())
    });
    // Owned capes are not necessarily equipped. An absent ACTIVE cape also
    // clears any cape saved by an earlier login or refresh.
    let cape = profile["capes"]
        .as_array()
        .and_then(|capes| capes.iter().find(|cape| cape["state"] == "ACTIVE"));
    Ok(Player {
        uuid: required(profile, "id")?,
        name: required(profile, "name")?,
        online: true,
        skin: skin.and_then(|s| s["url"].as_str()).unwrap_or("").into(),
        cape: cape.and_then(|c| c["url"].as_str()).unwrap_or("").into(),
        slim: skin.and_then(|s| s["variant"].as_str()) == Some("SLIM"),
    })
}

fn official_texture_url(source: &str) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(source).context("纹理地址无效")?;
    let texture = url.path().strip_prefix("/texture/").unwrap_or("");
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str() != Some("textures.minecraft.net")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || texture.is_empty()
        || texture.len() > 64
        || !texture.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        bail!("只支持 Minecraft 官方纹理地址");
    }
    url.set_scheme("https")
        .map_err(|_| anyhow::anyhow!("纹理地址无效"))?;
    Ok(url)
}

#[derive(Clone, Copy)]
enum TextureKind {
    Skin,
    Cape,
}

async fn read_texture_image(response: reqwest::Response, kind: TextureKind) -> Result<Vec<u8>> {
    const MAX_TEXTURE_BYTES: usize = 4 * 1024 * 1024;
    let mut response = response.error_for_status()?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_TEXTURE_BYTES as u64)
    {
        bail!("纹理图片超过 4 MB");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > MAX_TEXTURE_BYTES {
            bail!("纹理图片超过 4 MB");
        }
        bytes.extend_from_slice(&chunk);
    }
    let (_, height) = validate_skin(&bytes)?;
    if matches!(kind, TextureKind::Cape) && height != 32 {
        bail!("Minecraft 披风必须为 64×32 像素");
    }
    Ok(bytes)
}

pub fn validate_skin(bytes: &[u8]) -> Result<(u32, u32)> {
    if bytes.len() < 33
        || bytes.len() > 4 * 1024 * 1024
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || &bytes[12..16] != b"IHDR"
    {
        bail!("请选择有效的 PNG 皮肤文件");
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into()?);
    if width != 64 || (height != 32 && height != 64) {
        bail!("Minecraft 皮肤必须为 64×32 或 64×64 像素");
    }
    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_selects_only_equipped_cape_and_clears_it_when_removed() {
        let mut profile = json!({
            "id": "0123456789abcdef0123456789abcdef", "name": "CapePlayer",
            "skins": [{"state": "ACTIVE", "url": "https://textures.minecraft.net/texture/ab", "variant": "SLIM"}],
            "capes": [
                {"state": "INACTIVE", "url": "https://textures.minecraft.net/texture/cd"},
                {"state": "ACTIVE", "url": "https://textures.minecraft.net/texture/ef"}
            ]
        });
        let player = player_from_profile(&profile).unwrap();
        assert_eq!(player.cape, "https://textures.minecraft.net/texture/ef");
        assert!(player.online && player.slim);
        assert_eq!(player.skin, "https://textures.minecraft.net/texture/ab");
        profile["capes"][1]["state"] = json!("INACTIVE");
        assert!(player_from_profile(&profile).unwrap().cape.is_empty());
        profile["capes"] = json!([]);
        assert!(player_from_profile(&profile).unwrap().cape.is_empty());
        profile.as_object_mut().unwrap().remove("capes");
        assert!(player_from_profile(&profile).unwrap().cape.is_empty());
    }

    #[tokio::test]
    async fn old_accounts_open_and_cape_updates_persist() {
        let directory = tempfile::tempdir().unwrap();
        let open = || {
            Accounts::open(
                directory.path(),
                Arc::new(Vault::open(directory.path()).unwrap()),
                Arc::new(ConfigStore::open(directory.path()).unwrap()),
                Arc::new(Jobs::default()),
            )
            .unwrap()
        };
        let profile = json!({
            "uuid": "0123456789abcdef0123456789abcdef", "name": "CapePlayer",
            "online": true, "skin": "", "slim": false
        });
        std::fs::write(
            directory.path().join("players.json"),
            serde_json::to_vec(&json!([profile])).unwrap(),
        )
        .unwrap();
        let accounts = open();
        let mut player = accounts.list().remove(0);
        assert!(player.cape.is_empty());
        player.cape = "https://textures.minecraft.net/texture/ef".into();
        accounts.upsert(player.clone()).unwrap();
        assert_eq!(open().list()[0].cape, player.cape);
        player.cape.clear();
        accounts.upsert(player.clone()).unwrap();
        assert!(open().list()[0].cape.is_empty());
        assert!(accounts
            .texture_image("https://textures.minecraft.net/texture/ef")
            .await
            .unwrap_err()
            .to_string()
            .contains("不属于"));
        player.online = false;
        player.cape = "https://textures.minecraft.net/texture/ef".into();
        accounts.upsert(player).unwrap();
        assert!(accounts
            .texture_image("https://textures.minecraft.net/texture/ef")
            .await
            .unwrap_err()
            .to_string()
            .contains("不属于"));
    }
    #[test]
    fn official_skin_urls_upgrade_to_https() {
        let path = format!("textures.minecraft.net/texture/{}", "ab".repeat(32));
        for scheme in ["http", "https"] {
            assert_eq!(
                official_texture_url(&format!("{scheme}://{path}"))
                    .unwrap()
                    .as_str(),
                format!("https://{path}")
            );
        }
        for source in [
            "https://example.com/texture/ab",
            "https://textures.minecraft.net.evil.test/texture/ab",
            "http://127.0.0.1/texture/ab",
            "file:///texture/ab",
            "https://textures.minecraft.net/texture/",
            "https://textures.minecraft.net/texture/../profile",
            "https://textures.minecraft.net:8080/texture/ab",
            "https://user@textures.minecraft.net/texture/ab",
            "https://textures.minecraft.net/texture/ab?url=http://localhost",
        ] {
            assert!(official_texture_url(source).is_err(), "accepted {source}");
        }
    }

    #[tokio::test]
    async fn remote_skin_bytes_are_checked_without_browser_cors() {
        use axum::{body::Body, response::Response, routing::get, Router};
        use base64::Engine;
        let png = base64::engine::general_purpose::STANDARD.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAlElEQVR4nO3QMREAMBDDsPAn/YWhoR60+7zb7mfTAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA9DiOHSbdjxEgAAAABJRU5ErkJggg=="
        ).unwrap();
        let served_png = png.clone();
        let cape = base64::engine::general_purpose::STANDARD.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAXUlEQVR4nO3QMREAIBDAsFeCCPxLwQvIyECH7L3OWfv+bHSA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AHaA/+tWQCZFZx3AAAAAElFTkSuQmCC"
        ).unwrap();
        let served_cape = cape.clone();
        let app = Router::new()
            .route("/skin", get(move || async move { served_png }))
            .route("/cape", get(move || async move { served_cape }))
            .route("/invalid", get(|| async { "not a PNG" }))
            .route("/large", get(|| async { vec![0u8; 4 * 1024 * 1024 + 1] }))
            .route(
                "/stream",
                get(|| async {
                    let chunks = futures_util::stream::iter(
                        (0..5).map(|_| Ok::<_, std::io::Error>(vec![0u8; 1024 * 1024])),
                    );
                    Response::new(Body::from_stream(chunks))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = crate::http_client().unwrap();
        let response = client
            .get(format!("http://{address}/skin"))
            .send()
            .await
            .unwrap();
        assert!(!response
            .headers()
            .contains_key("access-control-allow-origin"));
        assert_eq!(
            read_texture_image(response, TextureKind::Skin)
                .await
                .unwrap(),
            png.as_slice()
        );
        let response = client
            .get(format!("http://{address}/cape"))
            .send()
            .await
            .unwrap();
        assert_eq!(
            read_texture_image(response, TextureKind::Cape)
                .await
                .unwrap(),
            cape.as_slice()
        );
        let response = client
            .get(format!("http://{address}/skin"))
            .send()
            .await
            .unwrap();
        assert!(read_texture_image(response, TextureKind::Cape)
            .await
            .is_err());
        for path in ["invalid", "large", "stream", "missing"] {
            for kind in [TextureKind::Skin, TextureKind::Cape] {
                let response = client
                    .get(format!("http://{address}/{path}"))
                    .send()
                    .await
                    .unwrap();
                assert!(
                    read_texture_image(response, kind).await.is_err(),
                    "accepted {path}"
                );
            }
        }
        server.abort();
    }

    #[test]
    fn offline_uuid_matches_java_name_uuid() {
        assert_eq!(offline_uuid("Notch"), "b50ad385829d3141a2167e7d7539ba7f");
    }
    #[test]
    fn offline_name_validation() {
        assert!(valid_player_name("Steve_42").is_ok());
        for name in ["", "bad name", "abcdefghijklmnopq", "../../a"] {
            assert!(valid_player_name(name).is_err());
        }
    }
    #[test]
    fn png_dimensions_checked() {
        let mut png = vec![0; 33];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&64u32.to_be_bytes());
        png[20..24].copy_from_slice(&64u32.to_be_bytes());
        assert!(validate_skin(&png).is_ok());
        png[20..24].copy_from_slice(&65u32.to_be_bytes());
        assert!(validate_skin(&png).is_err());
    }
}
