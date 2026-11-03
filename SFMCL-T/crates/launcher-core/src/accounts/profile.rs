use super::*;
use reqwest::{multipart, RequestBuilder, Response, StatusCode};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cape {
    pub id: String,
    pub name: String,
    pub url: String,
    pub active: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameChange {
    pub name_change_allowed: bool,
    pub changed_at: Option<String>,
    pub created_at: Option<String>,
}

impl Accounts {
    fn online_player(&self, id: &str) -> Result<Player> {
        let player = self
            .list()
            .into_iter()
            .find(|p| p.uuid == id)
            .context("角色不存在")?;
        if !player.online {
            bail!("此操作仅支持 Microsoft 登录的正版角色");
        }
        Ok(player)
    }

    fn profile_url(&self, path: &str) -> String {
        format!("{}/minecraft/profile{path}", self.endpoints.minecraft)
    }

    // Callers hold login_gate through validation, token renewal and mutation.
    // A rejected token is renewed once; other errors never replay a mutation.
    async fn profile_request(
        &self,
        id: &str,
        build: impl Fn(&str) -> RequestBuilder,
        invalid_message: &str,
    ) -> Result<Response> {
        self.online_player(id)?;
        let mut tokens = self
            .vault
            .get(id)
            .context("缺少账号凭据，请重新登录微软账号")?;
        if tokens.access.is_empty() || tokens.expires_at <= now() + 120 {
            self.refresh_locked(id).await?;
            tokens = self
                .vault
                .get(id)
                .context("刷新未返回账号凭据，请重新登录")?;
        }
        let mut response = build(&tokens.access)
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            self.refresh_locked(id).await?;
            tokens = self
                .vault
                .get(id)
                .context("刷新未返回账号凭据，请重新登录")?;
            response = build(&tokens.access)
                .timeout(Duration::from_secs(30))
                .send()
                .await?;
        }
        check_response(response, invalid_message).await
    }

    async fn read_profile(&self, id: &str) -> Result<Value> {
        let profile: Value = self
            .profile_request(
                id,
                |token| self.client.get(self.profile_url("")).bearer_auth(token),
                "无法读取角色资料",
            )
            .await?
            .json()
            .await
            .context("Minecraft 返回的角色资料无效")?;
        if required(&profile, "id")? != id {
            bail!("Minecraft 返回的角色与操作账号不一致，请重新登录");
        }
        Ok(profile)
    }

    fn save_profile(&self, id: &str, profile: &Value) -> Result<Player> {
        let player = player_from_profile(profile)?;
        if player.uuid != id {
            bail!("Minecraft 返回的角色与操作账号不一致，请重新登录");
        }
        let mut players = self.players.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = players.clone();
        let existing = next
            .iter_mut()
            .find(|p| p.uuid == id && p.online)
            .context("角色已移除，无法同步资料")?;
        *existing = player.clone();
        self.save(&next)?;
        *players = next;
        Ok(player)
    }

    async fn finish_profile_change(&self, id: &str, response: Response) -> Result<Player> {
        let result = async {
            let bytes = response.bytes().await?;
            let profile = match serde_json::from_slice::<Value>(&bytes) {
                Ok(value)
                    if value["id"].is_string()
                        && value["name"].is_string()
                        && value["skins"].is_array()
                        && value["capes"].is_array() =>
                {
                    value
                }
                _ => self.read_profile(id).await?,
            };
            self.save_profile(id, &profile)
        }
        .await;
        result.context("更改已提交，但角色资料同步失败，请稍后刷新登录以确认结果")
    }

    pub async fn update_skin(
        self: &Arc<Self>,
        id: &str,
        path: Option<&Path>,
        slim: bool,
    ) -> Result<Player> {
        let player = self
            .list()
            .into_iter()
            .find(|p| p.uuid == id)
            .context("角色不存在")?;
        if !player.online {
            return self.skin(id, path, slim);
        }
        let bytes = if let Some(path) = path {
            Some(read_skin_file(path).await?)
        } else {
            None
        };
        let _gate = self.login_gate.lock().await;
        let response = self
            .profile_request(
                id,
                |token| {
                    if let Some(bytes) = &bytes {
                        let file = multipart::Part::bytes(bytes.clone())
                            .file_name("skin.png")
                            .mime_str("image/png")
                            .expect("constant MIME type");
                        let form = multipart::Form::new()
                            .text("variant", if slim { "slim" } else { "classic" })
                            .part("file", file);
                        self.client
                            .post(self.profile_url("/skins"))
                            .bearer_auth(token)
                            .multipart(form)
                    } else {
                        self.client
                            .delete(self.profile_url("/skins/active"))
                            .bearer_auth(token)
                    }
                },
                "皮肤上传失败，请使用有效的 64×32 或 64×64 PNG 文件",
            )
            .await?;
        self.finish_profile_change(id, response).await
    }

    pub async fn capes(self: &Arc<Self>, id: &str, refresh: bool) -> Result<Vec<Cape>> {
        let _gate = self.login_gate.lock().await;
        let player = self.online_player(id)?;
        if !refresh {
            if let Some(capes) = player.capes {
                return Ok(capes);
            }
        }
        let profile = self.read_profile(id).await?;
        let capes = owned_capes(&profile)?;
        self.save_profile(id, &profile)?;
        Ok(capes)
    }

    pub async fn set_cape(self: &Arc<Self>, id: &str, cape_id: Option<&str>) -> Result<Player> {
        let _gate = self.login_gate.lock().await;
        // Fetch ownership afresh, including for older accounts with no cape cache.
        let profile = self.read_profile(id).await?;
        if let Some(cape_id) = cape_id {
            if !owned_capes(&profile)?.iter().any(|cape| cape.id == cape_id) {
                bail!("此账号未拥有所选披风，只能装备已获得的官方披风");
            }
        }
        let response = self
            .profile_request(
                id,
                |token| {
                    if let Some(cape_id) = cape_id {
                        self.client
                            .put(self.profile_url("/capes/active"))
                            .bearer_auth(token)
                            .json(&json!({"capeId": cape_id}))
                    } else {
                        self.client
                            .delete(self.profile_url("/capes/active"))
                            .bearer_auth(token)
                    }
                },
                "披风更换失败，请重新获取账号拥有的披风",
            )
            .await?;
        self.finish_profile_change(id, response).await
    }

    async fn read_name_change(&self, id: &str) -> Result<NameChange> {
        self.profile_request(
            id,
            |token| {
                self.client
                    .get(self.profile_url("/namechange"))
                    .bearer_auth(token)
            },
            "无法查询改名资格",
        )
        .await?
        .json()
        .await
        .context("Minecraft 返回的改名资格无效")
    }

    pub async fn name_change(self: &Arc<Self>, id: &str) -> Result<NameChange> {
        let _gate = self.login_gate.lock().await;
        self.read_name_change(id).await
    }

    pub async fn update_name(self: &Arc<Self>, id: &str, name: &str) -> Result<Player> {
        let player = self
            .list()
            .into_iter()
            .find(|p| p.uuid == id)
            .context("角色不存在")?;
        if !player.online {
            return self.rename(id, name);
        }
        valid_player_name(name)?;
        if name.len() < 3 {
            bail!("正版游戏名需要 3–16 个英文字母、数字或下划线");
        }
        if name == player.name {
            return Ok(player);
        }
        let _gate = self.login_gate.lock().await;
        if !self.read_name_change(id).await?.name_change_allowed {
            bail!("此账号暂时不能改名，通常需距上次改名或创建角色满 30 天");
        }
        let availability: Value = self
            .profile_request(
                id,
                |token| {
                    self.client
                        .get(self.profile_url(&format!("/name/{name}/available")))
                        .bearer_auth(token)
                },
                "无法检查游戏名是否可用",
            )
            .await?
            .json()
            .await
            .context("Minecraft 返回的名称检查结果无效")?;
        match availability["status"].as_str() {
            Some("AVAILABLE") => {}
            Some("DUPLICATE") => bail!("此游戏名已被占用，请选择其他名称"),
            Some("NOT_ALLOWED") => bail!("Minecraft 不允许使用此游戏名，请选择其他名称"),
            _ => bail!("无法确认此游戏名是否可用，请稍后重试"),
        }
        let response = self
            .profile_request(
                id,
                |token| {
                    self.client
                        .put(self.profile_url(&format!("/name/{name}")))
                        .bearer_auth(token)
                },
                "游戏名修改失败，请检查名称是否可用及 30 天改名间隔",
            )
            .await?;
        self.finish_profile_change(id, response).await
    }
}

pub(super) fn owned_capes(profile: &Value) -> Result<Vec<Cape>> {
    profile["capes"]
        .as_array()
        .context("Minecraft 返回的披风列表无效")?
        .iter()
        .map(|cape| {
            Ok(Cape {
                id: required(cape, "id")?,
                name: cape["alias"].as_str().unwrap_or("官方披风").into(),
                url: required(cape, "url")?,
                active: cape["state"] == "ACTIVE",
            })
        })
        .collect()
}

async fn check_response(response: Response, invalid_message: &str) -> Result<Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let error = response.json::<Value>().await.unwrap_or(Value::Null);
    // Use known error codes only. Never expose response bodies or credentials.
    match error["details"]["status"]
        .as_str()
        .or(error["error"].as_str())
    {
        Some("DUPLICATE") => bail!("此游戏名已被占用，请选择其他名称"),
        Some("NOT_ALLOWED") => bail!("Minecraft 不允许使用此游戏名，请选择其他名称"),
        _ => {}
    }
    match status {
        StatusCode::UNAUTHORIZED => bail!("Minecraft 登录已失效，请重新登录微软账号"),
        StatusCode::BAD_REQUEST | StatusCode::FORBIDDEN | StatusCode::CONFLICT => {
            bail!("{invalid_message}")
        }
        StatusCode::NOT_FOUND => bail!("未找到 Minecraft Java 版角色资料，请检查账号"),
        StatusCode::TOO_MANY_REQUESTS => bail!("账号操作过于频繁，请稍后重试"),
        _ => bail!(
            "Minecraft 账号服务暂时不可用（HTTP {}），请稍后重试",
            status.as_u16()
        ),
    }
}

#[cfg(all(test, windows))]
mod tests;
