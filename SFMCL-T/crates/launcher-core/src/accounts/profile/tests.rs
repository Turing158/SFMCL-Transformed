use super::*;
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::Request,
    response::IntoResponse,
    Router,
};

const ID: &str = "0123456789abcdef0123456789abcdef";
const CAPE: &str = "11111111-2222-3333-4444-555555555555";

struct RecordedRequest {
    method: String,
    path: String,
    authorization: String,
    body: Vec<u8>,
}

struct Service {
    profile: Value,
    requests: Vec<RecordedRequest>,
    unauthorized: usize,
    allowed: bool,
    availability: &'static str,
    mutation_error: Option<(StatusCode, Value)>,
    empty_response: bool,
    fail_sync: bool,
}

impl Default for Service {
    fn default() -> Self {
        Self {
            profile: json!({
                "id": ID, "name": "Before",
                "skins": [{"state":"ACTIVE", "url":"https://textures.minecraft.net/texture/ab", "variant":"CLASSIC"}],
                "capes": [{"id": CAPE, "alias": "Migrator", "url":"https://textures.minecraft.net/texture/cd", "state":"INACTIVE"}]
            }),
            requests: vec![],
            unauthorized: 0,
            allowed: true,
            availability: "AVAILABLE",
            mutation_error: None,
            empty_response: false,
            fail_sync: false,
        }
    }
}

async fn serve(
    State(state): State<Arc<Mutex<Service>>>,
    request: Request<Body>,
) -> axum::response::Response {
    let method = request.method().to_string();
    let path = request.uri().path().to_owned();
    let authorization = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body = to_bytes(request.into_body(), 5 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    let mut state = state.lock().unwrap();
    state.requests.push(RecordedRequest {
        method: method.clone(),
        path: path.clone(),
        authorization,
        body: body.clone(),
    });
    let reply = |value: Value| axum::Json(value).into_response();
    match path.as_str() {
        "/token" => {
            return reply(json!({"access_token":"msa-fresh", "refresh_token":"refresh-fresh"}))
        }
        "/xbox" => return reply(json!({"Token":"xbox-token"})),
        "/xsts" => {
            return reply(
                json!({"Token":"xsts-token", "DisplayClaims":{"xui":[{"uhs":"user-hash"}]}}),
            )
        }
        "/authentication/login_with_xbox" => {
            return reply(json!({"access_token":"minecraft-fresh", "expires_in":86400}))
        }
        _ => {}
    }
    if state.unauthorized > 0 {
        state.unauthorized -= 1;
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if method == "GET" {
        return match path.as_str() {
            "/minecraft/profile" => {
                if state.fail_sync {
                    StatusCode::SERVICE_UNAVAILABLE.into_response()
                } else {
                    reply(state.profile.clone())
                }
            }
            "/minecraft/profile/namechange" => reply(
                json!({"nameChangeAllowed":state.allowed, "changedAt":"2026-10-20T00:00:00Z", "createdAt":"2015-01-01T00:00:00Z"}),
            ),
            _ if path.ends_with("/available") => reply(json!({"status": state.availability})),
            _ => StatusCode::NOT_FOUND.into_response(),
        };
    }
    if let Some((status, error)) = &state.mutation_error {
        return (*status, axum::Json(error.clone())).into_response();
    }
    match (method.as_str(), path.as_str()) {
        ("POST", "/minecraft/profile/skins") => {
            let slim = body
                .windows(b"\r\n\r\nslim\r\n".len())
                .any(|w| w == b"\r\n\r\nslim\r\n");
            state.profile["skins"] = json!([{"state":"ACTIVE", "url":"https://textures.minecraft.net/texture/ef", "variant": if slim { "SLIM" } else { "CLASSIC" }}]);
        }
        ("DELETE", "/minecraft/profile/skins/active") => state.profile["skins"] = json!([]),
        ("PUT", "/minecraft/profile/capes/active") => {
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap()["capeId"],
                CAPE
            );
            state.profile["capes"][0]["state"] = json!("ACTIVE");
        }
        ("DELETE", "/minecraft/profile/capes/active") => {
            state.profile["capes"][0]["state"] = json!("INACTIVE")
        }
        ("PUT", _) if path.starts_with("/minecraft/profile/name/") => {
            state.profile["name"] = json!(path.rsplit('/').next().unwrap())
        }
        _ => return StatusCode::NOT_FOUND.into_response(),
    }
    if state.empty_response {
        StatusCode::NO_CONTENT.into_response()
    } else {
        reply(state.profile.clone())
    }
}

struct Harness {
    accounts: Arc<Accounts>,
    state: Arc<Mutex<Service>>,
    directory: tempfile::TempDir,
    server: tokio::task::JoinHandle<()>,
    selected: String,
}

impl Harness {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(Mutex::new(Service::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().fallback(serve).with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let vault = Arc::new(Vault::open(directory.path()).unwrap());
        vault
            .put(
                ID,
                Tokens {
                    littleskin: None,
                    client_token: String::new(),
                    access: "minecraft-old".into(),
                    refresh: "refresh-old".into(),
                    expires_at: now() + 86400,
                },
            )
            .unwrap();
        let config = Arc::new(ConfigStore::open(directory.path()).unwrap());
        config
            .update(|s| s.microsoft_client_id = "test-client-id".into())
            .unwrap();
        let mut accounts =
            Accounts::open(directory.path(), vault, config, Arc::new(Jobs::default())).unwrap();
        Arc::get_mut(&mut accounts).unwrap().endpoints = AccountEndpoints {
            minecraft: url.clone(),
            microsoft_token: format!("{url}/token"),
            xbox_authenticate: format!("{url}/xbox"),
            xsts_authorize: format!("{url}/xsts"),
        };
        accounts
            .upsert(player_from_profile(&state.lock().unwrap().profile).unwrap())
            .unwrap();
        let selected = accounts.add_offline("Other").unwrap().uuid;
        Self {
            accounts,
            state,
            directory,
            server,
            selected,
        }
    }

    fn player(&self) -> Player {
        self.accounts
            .list()
            .into_iter()
            .find(|p| p.uuid == ID)
            .unwrap()
    }
    fn mutations(&self) -> usize {
        self.state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|r| r.method != "GET" && r.path.starts_with("/minecraft/profile/"))
            .count()
    }
    fn assert_preserved(&self) {
        assert_eq!(self.accounts.config.get().active_player, self.selected);
        assert_eq!(self.player().uuid, ID);
        let saved: Vec<Player> = serde_json::from_slice(
            &std::fs::read(self.directory.path().join("players.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            saved.iter().find(|p| p.uuid == ID).unwrap().name,
            self.player().name
        );
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
async fn uploads_png_with_selected_model_and_resets_skin() {
    let h = Harness::new().await;
    let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD,
        "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAN0lEQVR42u3PAQ0AAAgDINc/9K3hHFQgE1mVJQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPg1AQ9AAT/hTj4AAAAASUVORK5CYII=").unwrap();
    let path = h.directory.path().join("skin.png");
    std::fs::write(&path, &png).unwrap();
    for slim in [true, false] {
        let player = h.accounts.update_skin(ID, Some(&path), slim).await.unwrap();
        assert_eq!(player.slim, slim);
        assert_eq!(player.skin, "https://textures.minecraft.net/texture/ef");
        let state = h.state.lock().unwrap();
        let upload = state
            .requests
            .iter()
            .rev()
            .find(|r| r.path.ends_with("/skins"))
            .unwrap();
        assert_eq!(upload.method, "POST");
        assert_eq!(upload.authorization, "Bearer minecraft-old");
        assert!(upload.body.windows(png.len()).any(|part| part == png));
    }
    h.state.lock().unwrap().empty_response = true;
    let player = h.accounts.update_skin(ID, None, false).await.unwrap();
    assert!(player.skin.is_empty() && !player.slim);
    assert_eq!(h.mutations(), 3);
    h.assert_preserved();
    std::fs::write(&path, b"invalid png").unwrap();
    assert!(h
        .accounts
        .update_skin(ID, Some(&path), false)
        .await
        .is_err());
    assert_eq!(h.mutations(), 3);
}

#[tokio::test]
async fn login_saves_all_owned_capes_without_an_extra_profile_request() {
    let h = Harness::new().await;
    h.state.lock().unwrap().profile["capes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"another-cape", "alias":"Vanilla", "url":"https://textures.minecraft.net/texture/ef", "state":"ACTIVE"}));
    let job = h.accounts.jobs.create(
        JobKind::Login,
        "Test login".into(),
        &["Microsoft", "Xbox", "Minecraft", "Save"],
    );
    let player = h
        .accounts
        .exchange(
            &json!({"access_token":"msa-token", "refresh_token":"refresh-token"}),
            job,
            None,
        )
        .await
        .unwrap();
    let capes = player.capes.unwrap();
    assert_eq!(capes.len(), 2);
    assert_eq!(capes[0].name, "Migrator");
    assert!(capes[1].active);
    assert_eq!(h.accounts.capes(ID, false).await.unwrap().len(), 2);
    assert_eq!(
        h.state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|r| r.method == "GET" && r.path == "/minecraft/profile")
            .count(),
        1
    );
    let saved: Vec<Player> =
        serde_json::from_slice(&std::fs::read(h.directory.path().join("players.json")).unwrap())
            .unwrap();
    assert_eq!(
        saved
            .iter()
            .find(|p| p.uuid == ID)
            .unwrap()
            .capes
            .as_ref()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn cape_cache_persists_and_only_explicit_refresh_fetches_updates() {
    let h = Harness::new().await;
    assert_eq!(h.accounts.capes(ID, false).await.unwrap().len(), 1);
    h.state.lock().unwrap().profile["capes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"another-cape", "alias":"Vanilla", "url":"https://textures.minecraft.net/texture/ef", "state":"INACTIVE"}));
    assert_eq!(h.accounts.capes(ID, false).await.unwrap().len(), 1);
    assert!(h.state.lock().unwrap().requests.is_empty());
    assert_eq!(h.accounts.capes(ID, true).await.unwrap().len(), 2);
    assert_eq!(h.state.lock().unwrap().requests.len(), 1);
    let reopened = Accounts::open(
        h.directory.path(),
        h.accounts.vault.clone(),
        h.accounts.config.clone(),
        Arc::new(Jobs::default()),
    )
    .unwrap();
    assert_eq!(reopened.capes(ID, false).await.unwrap().len(), 2);
    h.state.lock().unwrap().fail_sync = true;
    assert!(h.accounts.capes(ID, true).await.is_err());
    assert_eq!(h.accounts.capes(ID, false).await.unwrap().len(), 2);
    assert_eq!(h.state.lock().unwrap().requests.len(), 2);
    h.assert_preserved();
}

#[tokio::test]
async fn old_accounts_fetch_once_and_an_empty_cape_list_is_cached() {
    let h = Harness::new().await;
    let mut player = h.player();
    player.capes = None;
    h.accounts.upsert(player).unwrap();
    let (first, second) = tokio::join!(h.accounts.capes(ID, false), h.accounts.capes(ID, false));
    assert_eq!(first.unwrap().len(), 1);
    assert_eq!(second.unwrap().len(), 1);
    assert_eq!(h.state.lock().unwrap().requests.len(), 1);
    h.state.lock().unwrap().profile["capes"] = json!([]);
    assert!(h.accounts.capes(ID, true).await.unwrap().is_empty());
    assert!(h.accounts.capes(ID, false).await.unwrap().is_empty());
    assert_eq!(h.state.lock().unwrap().requests.len(), 2);
    assert!(h.player().capes.unwrap().is_empty());
    h.assert_preserved();
}

#[tokio::test]
async fn only_owned_capes_can_be_equipped_and_removed() {
    let h = Harness::new().await;
    let capes = h.accounts.capes(ID, false).await.unwrap();
    assert_eq!(capes[0].name, "Migrator");
    assert!(!capes[0].active);
    assert!(h
        .accounts
        .set_cape(ID, Some("unowned-cape"))
        .await
        .unwrap_err()
        .to_string()
        .contains("未拥有"));
    assert_eq!(h.mutations(), 0);
    let player = h.accounts.set_cape(ID, Some(CAPE)).await.unwrap();
    assert_eq!(player.cape, "https://textures.minecraft.net/texture/cd");
    assert!(h.accounts.capes(ID, false).await.unwrap()[0].active);
    h.state.lock().unwrap().empty_response = true;
    assert!(h.accounts.set_cape(ID, None).await.unwrap().cape.is_empty());
    assert_eq!(h.mutations(), 2);
    h.assert_preserved();
}

#[tokio::test]
async fn name_changes_check_cooldown_availability_and_keep_uuid() {
    let h = Harness::new().await;
    for invalid in [
        "ab",
        "name-with-dash",
        "../escape",
        "中文",
        "12345678901234567",
    ] {
        assert!(h.accounts.update_name(ID, invalid).await.is_err());
    }
    assert!(h.state.lock().unwrap().requests.is_empty());
    h.state.lock().unwrap().allowed = false;
    assert!(
        !h.accounts
            .name_change(ID)
            .await
            .unwrap()
            .name_change_allowed
    );
    assert!(h
        .accounts
        .update_name(ID, "After")
        .await
        .unwrap_err()
        .to_string()
        .contains("30 天"));
    h.state.lock().unwrap().allowed = true;
    for unavailable in ["DUPLICATE", "NOT_ALLOWED", "UNKNOWN"] {
        h.state.lock().unwrap().availability = unavailable;
        assert!(h.accounts.update_name(ID, "After").await.is_err());
        assert_eq!(h.mutations(), 0);
        assert_eq!(h.player().name, "Before");
    }
    h.state.lock().unwrap().availability = "AVAILABLE";
    assert_eq!(
        h.accounts.update_name(ID, "After").await.unwrap().name,
        "After"
    );
    let identity = h.accounts.launch_identity(ID).await.unwrap();
    assert_eq!(identity.name, "After");
    assert_eq!(identity.uuid, ID);
    h.assert_preserved();
}

#[tokio::test]
async fn expired_tokens_renew_and_401_retries_once_without_switching_accounts() {
    for expired in [true, false] {
        let h = Harness::new().await;
        if expired {
            let mut tokens = h.accounts.vault.get(ID).unwrap();
            tokens.expires_at = 0;
            h.accounts.vault.put(ID, tokens).unwrap();
        } else {
            h.state.lock().unwrap().unauthorized = 1;
        }
        h.accounts.update_skin(ID, None, false).await.unwrap();
        let tokens = h.accounts.vault.get(ID).unwrap();
        assert_eq!(tokens.access, "minecraft-fresh");
        assert_eq!(tokens.refresh, "refresh-fresh");
        let state = h.state.lock().unwrap();
        assert_eq!(
            state.requests.iter().filter(|r| r.path == "/token").count(),
            1
        );
        assert!(String::from_utf8_lossy(
            &state
                .requests
                .iter()
                .find(|r| r.path == "/token")
                .unwrap()
                .body
        )
        .contains("refresh_token=refresh-old"));
        assert_eq!(
            state
                .requests
                .iter()
                .rev()
                .find(|r| r.method == "DELETE")
                .unwrap()
                .authorization,
            "Bearer minecraft-fresh"
        );
        drop(state);
        h.assert_preserved();
    }
    let h = Harness::new().await;
    h.state.lock().unwrap().mutation_error = Some((StatusCode::UNAUTHORIZED, json!({})));
    let error = h.accounts.update_skin(ID, None, false).await.unwrap_err();
    assert!(error.to_string().contains("登录已失效"));
    assert_eq!(h.mutations(), 2);
    assert_eq!(
        h.state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|r| r.path == "/token")
            .count(),
        1
    );
    assert!(!h.player().skin.is_empty());
}

#[tokio::test]
async fn failed_mutations_do_not_change_local_profiles_or_leak_server_bodies() {
    let h = Harness::new().await;
    for (status, error, expected) in [
        (
            StatusCode::FORBIDDEN,
            json!({"details":{"status":"DUPLICATE"}, "errorMessage":"sensitive-test-body"}),
            "已被占用",
        ),
        (
            StatusCode::TOO_MANY_REQUESTS,
            json!({"errorMessage":"sensitive-test-body"}),
            "过于频繁",
        ),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"errorMessage":"sensitive-test-body"}),
            "暂时不可用",
        ),
    ] {
        h.state.lock().unwrap().mutation_error = Some((status, error));
        let error = h
            .accounts
            .update_name(ID, "After")
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains(expected));
        assert!(!error.contains("sensitive-test-body"));
        assert_eq!(h.player().name, "Before");
        h.assert_preserved();
    }
    let attempts = h.mutations();
    assert_eq!(attempts, 3);
    assert!(h.accounts.capes(&h.selected, false).await.is_err());
    assert!(h.accounts.name_change("missing").await.is_err());
    assert_eq!(h.mutations(), attempts);
}

#[tokio::test]
async fn mismatched_accounts_and_failed_sync_do_not_overwrite_saved_profile() {
    let h = Harness::new().await;
    h.state.lock().unwrap().profile["id"] = json!("different-account");
    assert!(h.accounts.set_cape(ID, Some(CAPE)).await.is_err());
    assert_eq!(h.mutations(), 0);
    let mut tokens = h.accounts.vault.get(ID).unwrap();
    tokens.expires_at = 0;
    h.accounts.vault.put(ID, tokens).unwrap();
    assert!(h.accounts.update_name(ID, "After").await.is_err());
    assert_eq!(h.accounts.vault.get(ID).unwrap().access, "minecraft-old");
    assert_eq!(h.player().name, "Before");

    let h = Harness::new().await;
    {
        let mut state = h.state.lock().unwrap();
        state.empty_response = true;
        state.fail_sync = true;
    }
    let error = h.accounts.update_name(ID, "After").await.unwrap_err();
    assert!(error.to_string().contains("更改已提交"));
    assert_eq!(h.mutations(), 1);
    assert_eq!(h.player().name, "Before");
    h.assert_preserved();
}
