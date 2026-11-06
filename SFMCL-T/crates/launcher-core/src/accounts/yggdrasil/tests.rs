use super::*;
use axum::{
    extract::State,
    http::Uri,
    response::{IntoResponse, Response},
    Json, Router,
};

const FIRST: &str = "11111111111111111111111111111111";
const SECOND: &str = "22222222222222222222222222222222";

#[derive(Default)]
struct Service {
    requests: Vec<(String, Value)>,
    tokens: std::collections::HashMap<String, (String, Option<Value>)>,
    single: bool,
    empty: bool,
    wrong_profile: bool,
    reject: bool,
}

async fn serve(
    State(state): State<Arc<Mutex<Service>>>,
    uri: Uri,
    body: Option<Json<Value>>,
) -> Response {
    let path = uri.path();
    if path == "/" {
        return (
            [("X-Authlib-Injector-API-Location", "/api/yggdrasil/")],
            "site",
        )
            .into_response();
    }
    if path.ends_with("/yggdrasil/") {
        return Json(
            json!({"meta": {"serverName": "Test Skin"}, "signaturePublickey": "test-public-key"}),
        )
        .into_response();
    }
    let mut s = state.lock().unwrap();
    let body = body.map(|v| v.0).unwrap_or(Value::Null);
    s.requests.push((path.into(), body.clone()));
    if path.ends_with("/authenticate") {
        if s.reject {
            return (
                StatusCode::FORBIDDEN,
                "sensitive-password-must-not-be-echoed",
            )
                .into_response();
        }
        let a = json!({"id": FIRST, "name": "Builder"});
        let b = json!({"id": SECOND, "name": "Explorer"});
        let selected = s.single.then_some(a.clone());
        let access = format!("test-access-{}", s.requests.len());
        s.tokens.insert(
            access.clone(),
            (
                body["clientToken"].as_str().unwrap().into(),
                selected.clone(),
            ),
        );
        return Json(json!({"accessToken": access, "clientToken": body["clientToken"],
            "selectedProfile": selected, "availableProfiles": if s.empty {vec![]} else {vec![a, b]}})).into_response();
    }
    if path.ends_with("/refresh") {
        let Some((client, bound)) = s.tokens.get(body["accessToken"].as_str().unwrap()).cloned()
        else {
            return StatusCode::FORBIDDEN.into_response();
        };
        assert_eq!(client, body["clientToken"]);
        // A strict server rejects re-selecting an already-bound token.
        if bound.is_some() && body.get("selectedProfile").is_some() {
            return StatusCode::BAD_REQUEST.into_response();
        }
        let mut selected = bound.unwrap_or_else(|| body["selectedProfile"].clone());
        if s.wrong_profile {
            selected["id"] = json!(FIRST);
        }
        if body.get("selectedProfile").is_none() {
            selected["name"] = json!("Renamed");
        }
        s.tokens.remove(body["accessToken"].as_str().unwrap());
        let access = format!("test-access-{}", s.requests.len());
        s.tokens
            .insert(access.clone(), (client.clone(), Some(selected.clone())));
        return Json(
            json!({"accessToken": access, "clientToken": client, "selectedProfile": selected}),
        )
        .into_response();
    }
    if path.contains("/session/minecraft/profile/") {
        let id = path.rsplit('/').next().unwrap();
        let textures = STANDARD.encode(
            serde_json::to_vec(&json!({"textures": {
                "SKIN": {"url": "https://skin.example/skin.png", "metadata": {"model": "slim"}},
                "CAPE": {"url": "https://skin.example/cape.png"}
            }}))
            .unwrap(),
        );
        return Json(json!({"id": id, "name": "Builder", "properties": [{"name": "textures", "value": textures}]})).into_response();
    }
    StatusCode::NOT_FOUND.into_response()
}

struct Harness {
    accounts: Arc<Accounts>,
    state: Arc<Mutex<Service>>,
    dir: tempfile::TempDir,
    server: tokio::task::JoinHandle<()>,
    url: String,
}
impl Harness {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(Mutex::new(Service::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new().fallback(serve).with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let accounts = Accounts::open(
            dir.path(),
            Arc::new(Vault::open(dir.path()).unwrap()),
            Arc::new(ConfigStore::open(dir.path()).unwrap()),
            Arc::new(Jobs::default()),
        )
        .unwrap();
        Self {
            accounts,
            state,
            dir,
            server,
            url,
        }
    }
    async fn login(&self) -> YggdrasilLogin {
        self.accounts
            .begin_yggdrasil(&self.url, "test@example.com", "test-password")
            .await
            .unwrap()
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
async fn discovery_selection_refresh_and_launch_preserve_real_uuid_and_encrypted_tokens() {
    let h = Harness::new().await;
    let login = h.login().await;
    assert_eq!(login.profiles.len(), 2);
    assert!(login.server.ends_with("/api/yggdrasil/"));
    let public = serde_json::to_string(&login).unwrap();
    assert!(!public.contains("accessToken") && !public.contains("clientToken"));
    assert!(h.accounts.list().is_empty());
    let player = h
        .accounts
        .complete_yggdrasil(&login.session_id, SECOND)
        .await
        .unwrap();
    assert!(player.uuid.starts_with("yggdrasil-"));
    assert_eq!(player.yggdrasil.as_ref().unwrap().profile_id, SECOND);
    assert_eq!(player.skin, "https://skin.example/skin.png");
    assert!(player.slim);
    assert_eq!(h.accounts.config.get().active_player, player.uuid);
    let before = h.accounts.vault.get(&player.uuid).unwrap().access;
    let refreshed = h.accounts.refresh(&player.uuid).await.unwrap();
    assert_eq!(refreshed.name, "Renamed");
    assert_ne!(h.accounts.vault.get(&player.uuid).unwrap().access, before);
    let identity = h.accounts.launch_identity(&player.uuid).await.unwrap();
    assert_eq!(identity.uuid, SECOND);
    assert_eq!(identity.auth_server.as_deref(), Some(login.server.as_str()));
    assert!(identity.online && !identity.access_token.is_empty());
    assert!(h.accounts.name_change(&player.uuid).await.is_err());
    assert!(h.accounts.capes(&player.uuid, false).await.is_err());
    let disk = std::fs::read(h.dir.path().join("credentials.dat")).unwrap();
    assert!(!String::from_utf8_lossy(&disk).contains("test-access"));
    assert!(!String::from_utf8_lossy(&disk).contains("test-password"));
    let reopened = Accounts::open(
        h.dir.path(),
        Arc::new(Vault::open(h.dir.path()).unwrap()),
        h.accounts.config.clone(),
        h.accounts.jobs.clone(),
    )
    .unwrap();
    assert_eq!(
        reopened.launch_identity(&player.uuid).await.unwrap().uuid,
        SECOND
    );
    h.accounts.remove(&player.uuid).unwrap();
    assert!(h.accounts.vault.get(&player.uuid).is_none());
}

#[tokio::test]
async fn single_profile_does_not_rebind_and_servers_do_not_overwrite_each_other() {
    let h = Harness::new().await;
    h.state.lock().unwrap().single = true;
    let official = player_from_profile(&json!({"id": FIRST, "name": "Official"})).unwrap();
    h.accounts.upsert(official).unwrap();
    let login = h.login().await;
    assert_eq!(login.profiles.len(), 1);
    let a = h
        .accounts
        .complete_yggdrasil(&login.session_id, FIRST)
        .await
        .unwrap();
    assert!(!h
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .any(|(p, _)| p.ends_with("/refresh")));
    let login = h
        .accounts
        .begin_yggdrasil(&format!("{}/other/yggdrasil", h.url), "account", "password")
        .await
        .unwrap();
    let b = h
        .accounts
        .complete_yggdrasil(&login.session_id, FIRST)
        .await
        .unwrap();
    assert_ne!(a.uuid, b.uuid);
    assert_eq!(h.accounts.list().len(), 3);
    assert!(h
        .accounts
        .list()
        .iter()
        .any(|p| p.uuid == FIRST && p.yggdrasil.is_none()));
    let retry = h.login().await;
    h.accounts
        .complete_yggdrasil(&retry.session_id, FIRST)
        .await
        .unwrap();
    assert_eq!(h.accounts.list().len(), 3);
}

#[tokio::test]
async fn cancelled_expired_and_invalid_selections_cannot_save_accounts() {
    let h = Harness::new().await;
    let login = h.login().await;
    assert!(h
        .accounts
        .complete_yggdrasil(&login.session_id, "not-owned")
        .await
        .is_err());
    h.accounts.cancel_yggdrasil(&login.session_id);
    assert!(h
        .accounts
        .complete_yggdrasil(&login.session_id, FIRST)
        .await
        .is_err());
    let login = h.login().await;
    h.accounts
        .yggdrasil_pending
        .lock()
        .unwrap()
        .get_mut(&login.session_id)
        .unwrap()
        .created -= Duration::from_secs(601);
    assert!(h
        .accounts
        .complete_yggdrasil(&login.session_id, FIRST)
        .await
        .is_err());
    assert!(h.accounts.list().is_empty());
}

#[tokio::test]
async fn mismatched_profile_and_service_errors_do_not_save_or_leak_credentials() {
    let h = Harness::new().await;
    let login = h.login().await;
    h.state.lock().unwrap().wrong_profile = true;
    assert!(h
        .accounts
        .complete_yggdrasil(&login.session_id, SECOND)
        .await
        .is_err());
    assert!(h.accounts.list().is_empty());
    h.state.lock().unwrap().reject = true;
    let error = h
        .accounts
        .begin_yggdrasil(&h.url, "account", "sensitive-password")
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("验证失败"));
    assert!(!error.contains("sensitive-password"));
    h.state.lock().unwrap().reject = false;
    h.state.lock().unwrap().empty = true;
    assert!(h
        .accounts
        .begin_yggdrasil(&h.url, "account", "password")
        .await
        .err()
        .unwrap()
        .to_string()
        .contains("还没有游戏角色"));
}

#[test]
fn legacy_accounts_and_credentials_remain_readable_and_urls_are_validated() {
    let offline: Player = serde_json::from_value(
        json!({"uuid": FIRST, "name": "Steve", "online": false, "skin": ""}),
    )
    .unwrap();
    let online: Player =
        serde_json::from_value(json!({"uuid": SECOND, "name": "Alex", "online": true, "skin": ""}))
            .unwrap();
    assert!(offline.yggdrasil.is_none() && online.yggdrasil.is_none());
    let credentials: Tokens =
        serde_json::from_value(json!({"access": "old", "refresh": "refresh", "expires_at": 42}))
            .unwrap();
    assert!(credentials.client_token.is_empty());
    assert_eq!(
        server_url("skin.example/api/yggdrasil").unwrap().as_str(),
        "https://skin.example/api/yggdrasil/"
    );
    for value in [
        "http://skin.example",
        "https://user:pass@skin.example",
        "https://skin.example/?token=secret",
        "file:///tmp/a",
        "https://skin.example/#fragment",
    ] {
        assert!(server_url(value).is_err(), "{value}");
    }
    assert_ne!(
        storage_id("https://one/", FIRST),
        storage_id("https://two/", FIRST)
    );
}
