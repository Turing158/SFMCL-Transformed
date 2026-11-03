use anyhow::{bail, Context, Result};
use reqwest::{Client, StatusCode};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const RELEASES_URL: &str =
    "https://api.github.com/repos/Turing158/SFMCL-Transformed/releases?per_page=1";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum UpdateCheck {
    Unpublished {
        current_version: String,
    },
    Latest {
        current_version: String,
        latest_version: String,
    },
    Available {
        current_version: String,
        latest_version: String,
        html_url: String,
    },
}

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
}

pub async fn check(client: &Client, current_version: &str) -> Result<UpdateCheck> {
    let releases = fetch_releases(client, RELEASES_URL).await?;
    compare_release(current_version, releases.first())
}

async fn fetch_releases(client: &Client, url: &str) -> Result<Vec<Release>> {
    let response = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("Cache-Control", "no-cache")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                anyhow::anyhow!("检测更新超时，请稍后重试")
            } else {
                anyhow::anyhow!("无法连接 GitHub，请检查网络后重试：{error}")
            }
        })?;
    if matches!(
        response.status(),
        StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS
    ) {
        bail!("GitHub 请求受限，请稍后重试");
    }
    response
        .error_for_status()
        .context("GitHub 更新接口请求失败")?
        .json()
        .await
        .context("GitHub 返回的发布信息无效")
}

fn parse_version(value: &str) -> Result<Version> {
    let value = value.trim();
    Version::parse(value.strip_prefix(['v', 'V']).unwrap_or(value))
        .with_context(|| format!("无法识别版本号：{value}"))
}

fn compare_release(current_version: &str, release: Option<&Release>) -> Result<UpdateCheck> {
    let current = parse_version(current_version)?;
    let Some(release) = release else {
        return Ok(UpdateCheck::Unpublished {
            current_version: current_version.into(),
        });
    };
    let latest = parse_version(&release.tag_name)?;
    let latest_version = latest.to_string();
    if latest.cmp_precedence(&current).is_gt() {
        Ok(UpdateCheck::Available {
            current_version: current_version.into(),
            latest_version,
            html_url: release.html_url.clone(),
        })
    } else {
        Ok(UpdateCheck::Latest {
            current_version: current_version.into(),
            latest_version,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};

    fn release(tag: &str) -> Release {
        Release {
            tag_name: tag.into(),
            html_url: format!("https://github.com/Turing158/SFMCL-Transformed/releases/tag/{tag}"),
        }
    }

    #[test]
    fn compares_version_numbers_instead_of_text() {
        let result = compare_release("0.9.0", Some(&release("v0.10.0"))).unwrap();
        assert!(
            matches!(&result, UpdateCheck::Available { latest_version, .. } if latest_version == "0.10.0")
        );
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["currentVersion"], "0.9.0");
        assert_eq!(json["status"], "available");
        assert!(json["htmlUrl"].as_str().unwrap().ends_with("/v0.10.0"));
    }

    #[test]
    fn equal_or_older_releases_do_not_offer_a_downgrade() {
        for tag in ["0.1.0", "v0.1.0", "V0.1.0", "0.0.9"] {
            assert!(matches!(
                compare_release("0.1.0", Some(&release(tag))).unwrap(),
                UpdateCheck::Latest { .. }
            ));
        }
    }

    #[test]
    fn respects_prerelease_precedence_and_ignores_build_metadata() {
        for (current, tag, newer) in [
            ("0.1.0-beta.2", "v0.1.0-beta.10", true),
            ("0.1.0-beta.10", "v0.1.0", true),
            ("0.1.0", "v0.1.0-rc.1", false),
            ("0.1.0", "v0.2.0-beta.1", true),
            ("0.1.0+build.1", "0.1.0+build.2", false),
        ] {
            let result = compare_release(current, Some(&release(tag))).unwrap();
            assert_eq!(matches!(result, UpdateCheck::Available { .. }), newer);
        }
    }

    #[test]
    fn distinguishes_no_releases_from_latest() {
        assert_eq!(
            compare_release("0.1.0", None).unwrap(),
            UpdateCheck::Unpublished {
                current_version: "0.1.0".into()
            }
        );
    }

    #[test]
    fn invalid_versions_fail_instead_of_claiming_latest() {
        assert!(compare_release("0.1.0", Some(&release("nightly"))).is_err());
        assert!(compare_release("invalid", None).is_err());
    }

    #[tokio::test]
    async fn reads_the_releases_array_and_handles_github_errors() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new()
                .route("/releases", get(|| async {
                    axum::Json(serde_json::json!([
                        { "tag_name": "v0.2.0", "html_url": "https://github.com/Turing158/SFMCL-Transformed/releases/tag/v0.2.0" }
                    ]))
                }))
                .route("/empty", get(|| async { axum::Json(serde_json::json!([])) }))
                .route("/limited", get(|| async { StatusCode::TOO_MANY_REQUESTS }))
                .route("/forbidden", get(|| async { StatusCode::FORBIDDEN }))
                .route("/failed", get(|| async { StatusCode::INTERNAL_SERVER_ERROR }))
                .route("/invalid", get(|| async { axum::Json(serde_json::json!({ "message": "invalid" })) }))
            ).await.unwrap();
        });
        let client = crate::http_client().unwrap();
        let base = format!("http://{address}");
        let releases = fetch_releases(&client, &format!("{base}/releases?per_page=1"))
            .await
            .unwrap();
        assert!(matches!(
            compare_release("0.1.0", releases.first()).unwrap(),
            UpdateCheck::Available { .. }
        ));
        assert!(fetch_releases(&client, &format!("{base}/empty"))
            .await
            .unwrap()
            .is_empty());
        for path in ["limited", "forbidden"] {
            assert!(fetch_releases(&client, &format!("{base}/{path}"))
                .await
                .unwrap_err()
                .to_string()
                .contains("请求受限"));
        }
        for path in ["failed", "invalid"] {
            assert!(fetch_releases(&client, &format!("{base}/{path}"))
                .await
                .is_err());
        }
        server.abort();
    }
}
