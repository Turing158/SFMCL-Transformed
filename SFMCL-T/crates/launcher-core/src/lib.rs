pub mod accounts;
pub mod brand;
pub mod config;
pub mod downloads;
pub mod jobs;
pub mod minecraft;
pub mod notices;
pub mod paths;
pub mod resources;
pub mod vault;

pub fn http_client() -> anyhow::Result<reqwest::Client> {
    Ok(http_client_builder().build()?)
}

pub(crate) fn http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(concat!(
            "SFMCL-T/",
            env!("CARGO_PKG_VERSION"),
            " (Rust; https://github.com/Turing158/StarFall-Minecraft-Launcher)"
        ))
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(30))
}
