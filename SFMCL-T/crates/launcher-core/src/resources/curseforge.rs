use reqwest::Url;

/// The website resolves this entry through HTTP or JavaScript navigation.
/// It must be resolved in the desktop webview before entering the download queue.
pub fn download_entry(project_id: &str, file_id: u64) -> Option<String> {
    let project_id = project_id.parse::<u64>().ok().filter(|id| *id > 0)?;
    (file_id > 0).then(|| {
        format!("https://www.curseforge.com/api/v1/mods/{project_id}/files/{file_id}/download")
    })
}

pub fn is_download_entry(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if !is_website_url(value) || url.query().is_some() || url.fragment().is_some() {
        return false;
    }
    let parts: Vec<_> = url.path().split('/').collect();
    matches!(parts.as_slice(), ["", "api", "v1", "mods", project, "files", file, "download"]
        if download_entry(project, file.parse().unwrap_or(0)).as_deref() == Some(value))
}

pub fn is_website_url(value: &str) -> bool {
    Url::parse(value)
        .is_ok_and(|url| is_https(&url) && url.host_str() == Some("www.curseforge.com"))
}

pub fn is_download_cdn(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        is_https(&url)
            && matches!(
                url.host_str(),
                Some("mediafilez.forgecdn.net" | "edge.forgecdn.net")
            )
            && url.path().starts_with("/files/")
    })
}

fn is_https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_numeric_website_download_entries_are_resolved() {
        let entry = download_entry("306612", 1234567).unwrap();
        assert!(is_download_entry(&entry));
        for value in [
            entry.replace("https:", "http:"),
            entry.replace("www.curseforge.com", "www.curseforge.com.example.com"),
            entry.replace("306612", "0"),
            entry.replace("1234567", "not-a-file"),
            format!("{entry}?next=https://example.com"),
            "https://www.curseforge.com/minecraft/mc-mods/sodium".into(),
        ] {
            assert!(!is_download_entry(&value), "{value}");
        }
        assert!(download_entry("../mods", 123).is_none());
        assert!(download_entry("123", 0).is_none());
    }

    #[test]
    fn navigation_accepts_only_the_website_and_real_cdn_hosts() {
        assert!(is_website_url("https://www.curseforge.com/download"));
        for host in ["mediafilez.forgecdn.net", "edge.forgecdn.net"] {
            assert!(is_download_cdn(&format!(
                "https://{host}/files/1234/567/mod.jar"
            )));
        }
        for value in [
            "http://mediafilez.forgecdn.net/files/1234/567/mod.jar",
            "https://mediafilez.forgecdn.net.example.com/files/1234/567/mod.jar",
            "https://example.com/files/mod.jar?host=mediafilez.forgecdn.net",
            "https://user@mediafilez.forgecdn.net/files/1234/567/mod.jar",
            "https://mediafilez.forgecdn.net:444/files/1234/567/mod.jar",
            "https://mediafilez.forgecdn.net/not-a-file",
        ] {
            assert!(!is_download_cdn(value), "{value}");
        }
    }
}
