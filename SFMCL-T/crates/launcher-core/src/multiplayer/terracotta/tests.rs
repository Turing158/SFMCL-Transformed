use super::*;
use serde_json::{json, Value};

const CODE: &str = "U/7000-0000-0000-0000";

#[test]
fn invitations_and_reusable_rooms_follow_upstream_little_endian_checksum() {
    assert_eq!(normalize("陶瓦：u/7ooo-oooo-oooo-oooo 加入").unwrap(), CODE);
    assert_eq!(
        normalize("U/1OOO-IOOO-OOOO-OOOO 或 U/7000-0000-0000-0000").unwrap(),
        CODE
    );
    assert_eq!(
        normalize("U/I600-0000-0000-0000").unwrap_err().to_string(),
        normalize("invalid").unwrap_err().to_string()
    );
    // 1 + 1*34 is divisible by seven.
    assert_eq!(
        normalize("U/II00-0000-0000-0000").unwrap(),
        "U/1100-0000-0000-0000"
    );
    for bad in ["12345678", "SFMCL2.fixture", "U/0001-0000-0000-0000"] {
        assert!(normalize(bad).is_err());
        assert!(serde_json::from_value::<Request>(json!({"room":bad}))
            .unwrap()
            .room(true, None)
            .is_err());
    }
    assert!(Request::default().room(true, None).is_ok());
    assert!(Request::default().room(false, None).is_err());
    for bad in [
        "file:///C:/node",
        "tcp://node",
        "tcp://node:0",
        "https://user@node/a",
    ] {
        assert!(node(bad).is_err());
    }
}

fn project(value: Value, host: bool) -> Result<Update> {
    serde_json::from_value::<State>(value)?.project(host)
}

#[test]
fn roles_exceptions_and_game_addresses_are_checked_before_publication() {
    for url in ["127.0.0.1", "127.0.0.1:44221"] {
        let v = project(json!({"state":"guest-ok","index":2,"profiles":[
            {"machine_id":"h","name":"Alex","kind":"HOST"}, {"machine_id":"l","name":"Steve","kind":"LOCAL"}],"url":url}),false).unwrap();
        assert!(v.ready && v.code.is_none() && v.members[1].local);
        assert_eq!(
            v.address.unwrap().port(),
            if url.contains(':') { 44221 } else { 25565 }
        );
    }
    for url in [
        "127.0.0.1:0",
        "localhost:25565",
        "127.0.0.2:25565",
        "http://127.0.0.1",
        "8.8.8.8:80",
    ] {
        assert!(project(
            json!({"state":"guest-ok","index":2,"profiles":[],"url":url}),
            false
        )
        .is_err());
    }
    for state in ["guest-starting", "guest-connecting"] {
        assert!(
            !project(json!({"state":state,"index":1}), false)
                .unwrap()
                .ready
        );
        assert!(project(json!({"state":state,"index":1}), true).is_err());
    }
    for (n, message) in [
        "无法连接房主",
        "连接已中断",
        "好友的陶瓦网络组件",
        "房主的陶瓦网络组件",
        "关闭局域网世界",
        "协议异常",
        "未知异常",
    ]
    .iter()
    .enumerate()
    {
        assert!(
            project(json!({"state":"exception","index":2,"type":n}), false)
                .err()
                .unwrap()
                .to_string()
                .contains(message)
        );
    }
    assert!(project(json!({"state":"new-state","index":2}), true).is_err());
}

#[tokio::test]
async fn http_timeout_reads_back_once_and_skips_stale_states() {
    use axum::{extract::OriginalUri, routing::get, Json, Router};
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };
    let states = Arc::new(Mutex::new(VecDeque::from([
        json!({"state":"waiting","index":0}),
        json!({"state":"host-scanning","index":1}),
        json!({"state":"host-starting","index":2,"room":CODE}),
        json!({"state":"host-ok","index":2}),
        json!({"state":"waiting","index":1}),
        json!({"state":"host-ok","index":3,"room":CODE,"profiles":[]}),
        json!({"state":"exception","index":4,"type":4}),
    ])));
    let calls = Arc::new(Mutex::new(vec![]));
    let requests = calls.clone();
    let app = Router::new()
        .route(
            "/state",
            get(move || {
                let value = states.lock().unwrap().pop_front().unwrap();
                async move { Json(value) }
            }),
        )
        .route(
            "/state/scanning",
            get(move |OriginalUri(uri): OriginalUri| {
                requests.lock().unwrap().push(uri);
                async {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let api = Control::new(port, || Ok(true)).unwrap();
    let mut updates = vec![];
    let room = serde_json::from_value::<Request>(
        json!({"room":CODE,"publicNodes":["tcp://example.org:22","https://example.org/a?q=a&x=b"]}),
    )
    .unwrap()
    .room(true, Some("小 明".into()))
    .unwrap();
    let error = api.monitor(&room, |s| updates.push(s)).await.unwrap_err();
    assert!(error.to_string().contains("世界"));
    assert_eq!(
        updates.iter().map(|s| s.phase.as_str()).collect::<Vec<_>>(),
        ["host-scanning", "host-starting", "host-ok"]
    );
    assert!(updates[1].code.is_none());
    assert_eq!(updates[2].code.as_deref(), Some(CODE));
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    let url = Url::parse(&format!("http://localhost{}", calls[0])).unwrap();
    assert_eq!(
        url.query_pairs().collect::<Vec<_>>(),
        [
            ("room".into(), CODE.into()),
            ("player".into(), "小 明".into()),
            ("public_nodes".into(), "tcp://example.org:22".into()),
            (
                "public_nodes".into(),
                "https://example.org/a?q=a&x=b".into()
            )
        ]
    );
    server.abort();
}

#[tokio::test]
async fn control_refuses_unowned_listener_and_http_200_without_transition() {
    use axum::{routing::get, Json, Router};
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = Router::new()
        .route(
            "/state",
            get(|| async { Json(json!({"state":"waiting","index":0})) }),
        )
        .route("/state/scanning", get(|| async {}));
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let room = Request::default().room(true, None).unwrap();
    let control = Control::new(port, || Ok(false)).unwrap();
    assert!(control.get("/state/scanning", Some(&room)).await.is_err());
    assert!(Control::new(port, || Ok(true))
        .unwrap()
        .monitor(&room, |_| panic!("unexpected update"))
        .await
        .unwrap_err()
        .to_string()
        .contains("未开始"));
    server.abort();
}
