use serde::{Deserialize, Serialize};

pub const MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
pub const BMCL: &str = "https://bmclapi2.bangbang93.com";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MinecraftDownloadSource {
    #[default]
    Auto,
    Official,
    Bmclapi,
}

impl MinecraftDownloadSource {
    /// Select a mirror at request time, keeping version metadata and hashes intact.
    pub fn url(self, original: &str) -> String {
        if self != Self::Bmclapi {
            return original.into();
        }
        let Ok(url) = reqwest::Url::parse(original) else {
            return original.into();
        };
        if !matches!(url.scheme(), "http" | "https") {
            return original.into();
        }
        let prefix = match url.host_str() {
            Some(
                "piston-meta.mojang.com"
                | "piston-data.mojang.com"
                | "launchermeta.mojang.com"
                | "launcher.mojang.com",
            ) => "",
            Some("libraries.minecraft.net") => "/maven",
            Some("resources.download.minecraft.net") => "/assets",
            _ => return original.into(),
        };
        let mut target = format!("{BMCL}{prefix}{}", url.path());
        if let Some(query) = url.query() {
            target.push('?');
            target.push_str(query);
        }
        if let Some(fragment) = url.fragment() {
            target.push('#');
            target.push_str(fragment);
        }
        target
    }
}
