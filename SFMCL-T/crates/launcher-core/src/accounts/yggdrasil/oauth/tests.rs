use super::*;
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Uri},
    response::{IntoResponse, Response},
    Json, Router,
};
use std::collections::VecDeque;

const FIRST: &str = "11111111111141118111111111111111";
const SECOND: &str = "22222222222242228222222222222222";
#[derive(Default)]
struct Service {
    origin: String,
    requests: Vec<(String, Value, String, Instant)>,
    errors: VecDeque<String>,
    begin_error: String,
    empty: bool,
    denied_profiles: bool,
    wrong_profile: bool,
    redirect: bool,
    fail_mint: bool,
    delay_token: bool,
    delay_mint: bool,
    rotation: usize,
}
async fn serve(
    State(state): State<Arc<Mutex<Service>>>,
    uri: Uri,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let path = uri.path();
    let body = if headers.get("content-type").is_some_and(|v| {
        v.to_str()
            .unwrap_or("")
            .starts_with("application/x-www-form-urlencoded")
    }) {
        let url = Url::parse(&format!(
            "http://local/?{}",
            String::from_utf8_lossy(&bytes)
        ))
        .unwrap();
        Value::Object(
            url.query_pairs()
                .map(|(k, v)| (k.into_owned(), Value::String(v.into_owned())))
                .collect(),
        )
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    let delay = {
        let s = state.lock().unwrap();
        (s.delay_token && path == "/oauth/token")
            || (s.delay_mint && path.ends_with("authserver/oauth"))
    };
    let response = {
        let mut s = state.lock().unwrap();
        let bearer = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        s.requests
            .push((path.into(), body.clone(), bearer.clone(), Instant::now()));
        assert!(body.get("client_secret").is_none());
        if path == "/oauth/device_code" {
            assert_eq!(body["client_id"], "sfmcl-test");
            assert_eq!(body["scope"], SCOPE);
            assert!(!body["scope"]
                .as_str()
                .unwrap()
                .contains("PlayerProfiles.Select"));
            if !s.begin_error.is_empty() {
                (
                    StatusCode::BAD_REQUEST,
                    Json(
                        json!({"error": s.begin_error, "error_description": "never expose secret"}),
                    ),
                )
                    .into_response()
            } else {
                Json(json!({"user_code": "TEST-CODE", "device_code": "private-device", "verification_uri": format!("{}/oauth/link", s.origin), "verification_uri_complete": format!("{}/oauth/link?user_code=TEST-CODE", s.origin), "expires_in":300, "interval":1})).into_response()
            }
        } else if path == "/oauth/token" {
            assert_eq!(body["client_id"], "sfmcl-test");
            if s.redirect {
                (
                    StatusCode::TEMPORARY_REDIRECT,
                    [("location", "/credential-trap")],
                )
                    .into_response()
            } else if let Some(error) = s.errors.pop_front() {
                (StatusCode::BAD_REQUEST, Json(json!({"error":error, "error_description":"private-device private-refresh"}))).into_response()
            } else {
                if body["grant_type"] == "refresh_token" {
                    assert_eq!(
                        body["refresh_token"],
                        format!("private-refresh-{}", s.rotation)
                    );
                    s.rotation += 1;
                } else {
                    assert_eq!(
                        body["grant_type"],
                        "urn:ietf:params:oauth:grant-type:device_code"
                    );
                    assert_eq!(body["device_code"], "private-device");
                }
                Json(json!({"token_type":"Bearer", "access_token":format!("private-oauth-{}",s.rotation), "refresh_token":format!("private-refresh-{}",s.rotation), "expires_in":259200})).into_response()
            }
        } else if path.ends_with("/profiles") {
            assert_eq!(bearer, format!("Bearer private-oauth-{}", s.rotation));
            if s.denied_profiles {
                Json(json!({"code":403})).into_response()
            } else if s.empty {
                Json(json!([])).into_response()
            } else {
                Json(json!([{"id":FIRST,"name":"First"},{"id":SECOND,"name":"Second"}]))
                    .into_response()
            }
        } else if path.ends_with("authserver/oauth") {
            assert_eq!(bearer, format!("Bearer private-oauth-{}", s.rotation));
            assert_eq!(body.as_object().unwrap().len(), 1);
            if s.fail_mint {
                (StatusCode::SERVICE_UNAVAILABLE, Json(json!({}))).into_response()
            } else {
                Json(json!({"accessToken":format!("private-minecraft-{}",s.rotation),"clientToken":format!("server-client-{}",s.rotation),"selectedProfile":{"id":if s.wrong_profile {FIRST} else {body["uuid"].as_str().unwrap()},"name":"Second"}})).into_response()
            }
        } else if path.contains("/profile/") {
            Json(json!({"id":path.rsplit('/').next().unwrap(),"name":"Second","properties":[]}))
                .into_response()
        } else {
            StatusCode::NOT_FOUND.into_response()
        }
    };
    if delay {
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    response
}
struct Harness {
    accounts: Arc<Accounts>,
    state: Arc<Mutex<Service>>,
    dir: tempfile::TempDir,
    server: tokio::task::JoinHandle<()>,
}
impl Harness {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(Service {
            origin: origin.clone(),
            ..Service::default()
        }));
        let router = Router::new().fallback(serve).with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let config = Arc::new(ConfigStore::open(dir.path()).unwrap());
        let service_directory = dir.path().join("service-credentials");
        std::fs::create_dir(&service_directory).unwrap();
        std::fs::write(
            service_directory.join("littleskin.dat"),
            crate::vault::protect(b"sfmcl-test").unwrap(),
        )
        .unwrap();
        let mut accounts = Accounts::open(
            dir.path(),
            Arc::new(Vault::open_with_service_directory(dir.path(), service_directory).unwrap()),
            config,
            Arc::new(Jobs::default()),
        )
        .unwrap();
        Arc::get_mut(&mut accounts).unwrap().littleskin_endpoints = Endpoints {
            oauth: format!("{origin}/oauth/"),
            yggdrasil: format!("{origin}/api/yggdrasil/"),
        };
        Self {
            accounts,
            state,
            dir,
            server,
        }
    }
    async fn device(&self) -> OAuthDeviceLogin {
        self.accounts.begin_littleskin().await.unwrap()
    }
    async fn fast_device(&self) -> OAuthDeviceLogin {
        let device = self.device().await;
        self.accounts
            .littleskin_pending
            .lock()
            .unwrap()
            .get(&device.session_id)
            .unwrap()
            .grant
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .interval = Duration::from_millis(10);
        device
    }
    async fn login(&self) -> YggdrasilLogin {
        let device = self.fast_device().await;
        self.accounts
            .wait_littleskin(&device.session_id)
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
async fn device_authorization_selection_refresh_and_reopen_keep_credentials_private() {
    let h = Harness::new().await;
    let device = h.fast_device().await;
    let public = serde_json::to_string(&device).unwrap();
    assert!(public.contains("TEST-CODE") && !public.contains("private-device"));
    let login = h
        .accounts
        .wait_littleskin(&device.session_id)
        .await
        .unwrap();
    assert_eq!(login.profiles.len(), 2);
    assert!(!serde_json::to_string(&login).unwrap().contains("private-"));
    assert!(h.accounts.list().is_empty());
    assert!(!h.dir.path().join("credentials.dat").exists());
    let player = h
        .accounts
        .complete_yggdrasil(&login.session_id, SECOND)
        .await
        .unwrap();
    assert_eq!(player.yggdrasil.as_ref().unwrap().profile_id, SECOND);
    let saved = h.accounts.vault.get(&player.uuid).unwrap();
    assert_eq!(saved.client_token, "server-client-0");
    assert_eq!(saved.littleskin.unwrap().refresh, "private-refresh-0");
    let disk = std::fs::read(h.dir.path().join("credentials.dat")).unwrap();
    assert!(!String::from_utf8_lossy(&disk).contains("private-"));
    assert!(!std::fs::read_to_string(h.dir.path().join("players.json"))
        .unwrap()
        .contains("private-"));
    std::fs::write(
        h.dir.path().join("service-credentials/littleskin.dat"),
        crate::vault::protect(b"changed-after-login").unwrap(),
    )
    .unwrap();
    let mut reopened = Accounts::open(
        h.dir.path(),
        Arc::new(
            Vault::open_with_service_directory(
                h.dir.path(),
                h.dir.path().join("service-credentials"),
            )
            .unwrap(),
        ),
        h.accounts.config.clone(),
        h.accounts.jobs.clone(),
    )
    .unwrap();
    let origin = &h.state.lock().unwrap().origin.clone();
    Arc::get_mut(&mut reopened).unwrap().littleskin_endpoints = Endpoints {
        oauth: format!("{origin}/oauth/"),
        yggdrasil: format!("{origin}/api/yggdrasil/"),
    };
    let identity = reopened.launch_identity(&player.uuid).await.unwrap();
    assert_eq!(identity.uuid, SECOND);
    assert_eq!(identity.access_token, "private-minecraft-1");
    assert!(identity.auth_server.is_some());
    assert_eq!(
        reopened
            .vault
            .get(&player.uuid)
            .unwrap()
            .littleskin
            .unwrap()
            .refresh,
        "private-refresh-1"
    );
    reopened.remove(&player.uuid).unwrap();
    assert!(reopened.vault.get(&player.uuid).is_none());
}

#[tokio::test]
async fn polling_obeys_server_interval_and_slow_down() {
    let h = Harness::new().await;
    h.state.lock().unwrap().errors = ["authorization_pending".into(), "slow_down".into()].into();
    let device = h.device().await;
    let started = Instant::now();
    h.accounts
        .wait_littleskin(&device.session_id)
        .await
        .unwrap();
    let s = h.state.lock().unwrap();
    let polls: Vec<_> = s
        .requests
        .iter()
        .filter(|(path, _, _, _)| path == "/oauth/token")
        .collect();
    assert_eq!(polls.len(), 3);
    assert!(polls[0].3.duration_since(started) >= Duration::from_millis(950));
    assert!(polls[1].3.duration_since(polls[0].3) >= Duration::from_secs(1));
    assert!(polls[2].3.duration_since(polls[1].3) >= Duration::from_secs(6));
}

#[tokio::test]
async fn cancellation_interrupts_network_and_cannot_publish_a_late_login() {
    let h = Harness::new().await;
    h.state.lock().unwrap().delay_token = true;
    let device = h.fast_device().await;
    let accounts = h.accounts.clone();
    let session = device.session_id.clone();
    let wait = tokio::spawn(async move { accounts.wait_littleskin(&session).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(h
        .accounts
        .wait_littleskin(&device.session_id)
        .await
        .is_err());
    h.accounts.cancel_yggdrasil(&device.session_id);
    assert!(tokio::time::timeout(Duration::from_millis(200), wait)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert!(h.accounts.yggdrasil_pending.lock().unwrap().is_empty());
    assert!(h.accounts.list().is_empty());
}

#[tokio::test]
async fn expired_denied_invalid_scope_and_redirect_responses_stop_without_leaking_secrets() {
    let h = Harness::new().await;
    for code in [
        "access_denied",
        "expired_token",
        "invalid_scope",
        "invalid_grant",
    ] {
        h.state.lock().unwrap().errors.push_back(code.into());
        let device = h.fast_device().await;
        let error = h
            .accounts
            .wait_littleskin(&device.session_id)
            .await
            .err()
            .unwrap()
            .to_string();
        assert_eq!(error, oauth_error(code));
        assert!(!error.contains("private-"));
    }
    let device = h.device().await;
    // An expiry deadline also stops polling while a network response is pending.
    let flow = h
        .accounts
        .littleskin_pending
        .lock()
        .unwrap()
        .remove(&device.session_id)
        .unwrap();
    let grant = flow.grant.lock().unwrap().take();
    h.accounts.littleskin_pending.lock().unwrap().insert(
        device.session_id.clone(),
        Arc::new(Flow {
            cancel: CancellationToken::new(),
            deadline: Instant::now(),
            grant: Mutex::new(grant),
        }),
    );
    assert!(h
        .accounts
        .wait_littleskin(&device.session_id)
        .await
        .err()
        .unwrap()
        .to_string()
        .contains("过期"));
    h.state.lock().unwrap().redirect = true;
    let device = h.fast_device().await;
    assert!(h
        .accounts
        .wait_littleskin(&device.session_id)
        .await
        .is_err());
    assert!(!h
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .any(|r| r.0 == "/credential-trap"));
    assert!(h.accounts.list().is_empty());
}

#[tokio::test]
async fn empty_or_denied_profile_lists_and_wrong_profile_selection_do_not_save() {
    let h = Harness::new().await;
    h.state.lock().unwrap().empty = true;
    let device = h.fast_device().await;
    assert!(h
        .accounts
        .wait_littleskin(&device.session_id)
        .await
        .err()
        .unwrap()
        .to_string()
        .contains("没有游戏角色"));
    h.state.lock().unwrap().empty = false;
    h.state.lock().unwrap().denied_profiles = true;
    let device = h.fast_device().await;
    assert!(h
        .accounts
        .wait_littleskin(&device.session_id)
        .await
        .err()
        .unwrap()
        .to_string()
        .contains("权限"));
    h.state.lock().unwrap().denied_profiles = false;
    let login = h.login().await;
    assert!(h
        .accounts
        .complete_yggdrasil(&login.session_id, "not-owned")
        .await
        .is_err());
    h.state.lock().unwrap().wrong_profile = true;
    assert!(h
        .accounts
        .complete_yggdrasil(&login.session_id, SECOND)
        .await
        .is_err());
    assert!(h.accounts.list().is_empty());
}

#[tokio::test]
async fn cancelled_profile_exchange_cannot_save_and_rotated_refresh_survives_api_failure() {
    let h = Harness::new().await;
    let login = h.login().await;
    h.state.lock().unwrap().delay_mint = true;
    let accounts = h.accounts.clone();
    let session = login.session_id.clone();
    let completion =
        tokio::spawn(async move { accounts.complete_yggdrasil(&session, SECOND).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    h.accounts.cancel_yggdrasil(&login.session_id);
    assert!(completion.await.unwrap().is_err());
    assert!(h.accounts.list().is_empty());
    h.state.lock().unwrap().delay_mint = false;
    let login = h.login().await;
    let player = h
        .accounts
        .complete_yggdrasil(&login.session_id, SECOND)
        .await
        .unwrap();
    h.state.lock().unwrap().fail_mint = true;
    assert!(h.accounts.refresh(&player.uuid).await.is_err());
    assert_eq!(
        h.accounts
            .vault
            .get(&player.uuid)
            .unwrap()
            .littleskin
            .unwrap()
            .refresh,
        "private-refresh-1"
    );
    h.state.lock().unwrap().fail_mint = false;
    h.accounts.refresh(&player.uuid).await.unwrap();
    assert_eq!(
        h.accounts.vault.get(&player.uuid).unwrap().access,
        "private-minecraft-2"
    );
}

#[tokio::test]
async fn missing_client_and_whitelist_errors_are_actionable() {
    let h = Harness::new().await;
    h.state.lock().unwrap().begin_error = "invalid_client".into();
    assert!(h
        .accounts
        .begin_littleskin()
        .await
        .err()
        .unwrap()
        .to_string()
        .contains("白名单"));
    std::fs::remove_file(h.dir.path().join("service-credentials/littleskin.dat")).unwrap();
    assert!(h
        .accounts
        .begin_littleskin()
        .await
        .err()
        .unwrap()
        .to_string()
        .contains("维护者"));
    assert_eq!(h.state.lock().unwrap().requests.len(), 1);
    let old: Tokens =
        serde_json::from_value(json!({"access":"old", "refresh":"", "expires_at":0})).unwrap();
    assert!(old.littleskin.is_none());
    let settings = serde_json::to_string(&h.accounts.config.get()).unwrap();
    assert!(!settings.contains("littleskinClientId") && !settings.contains("sfmcl-test"));
}

#[tokio::test]
async fn expired_token_during_selection_rotates_once_and_revoked_saved_grant_stops_launch() {
    let h = Harness::new().await;
    let login = h.login().await;
    h.accounts
        .yggdrasil_pending
        .lock()
        .unwrap()
        .get_mut(&login.session_id)
        .unwrap()
        .tokens
        .littleskin
        .as_mut()
        .unwrap()
        .expires_at = 0;
    h.state.lock().unwrap().fail_mint = true;
    assert!(h
        .accounts
        .complete_yggdrasil(&login.session_id, SECOND)
        .await
        .is_err());
    h.state.lock().unwrap().fail_mint = false;
    let player = h
        .accounts
        .complete_yggdrasil(&login.session_id, SECOND)
        .await
        .unwrap();
    assert_eq!(h.state.lock().unwrap().rotation, 1);
    h.state
        .lock()
        .unwrap()
        .errors
        .push_back("invalid_grant".into());
    let before = h
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .filter(|r| r.0.ends_with("authserver/oauth"))
        .count();
    assert!(h.accounts.launch_identity(&player.uuid).await.is_err());
    assert_eq!(
        h.state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|r| r.0.ends_with("authserver/oauth"))
            .count(),
        before
    );
}
