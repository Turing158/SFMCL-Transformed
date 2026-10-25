use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Notice {
    pub title: String,
    pub content: String,
    pub icon: String,
    pub source: String,
    pub error: Option<String>,
}

fn read_text(path: &Path) -> Result<String> {
    if std::fs::metadata(path)?.len() > 4 * 1024 * 1024 {
        bail!("公告文件超过 4 MB");
    }
    Ok(std::fs::read_to_string(path)?
        .trim_start_matches('\u{feff}')
        .to_owned())
}

pub fn load(directory: &Path) -> Result<Vec<Notice>> {
    let path = directory.join("Notices.json");
    if !path.exists() {
        return Ok(vec![Notice {
            title: "一个轻巧的新起点".into(),
            content: "游戏文件保存在你的电脑上。旧版用户可以在设置中导入 JSON 配置文件。\n\n在配置目录的 `Notices.json` 中添加自己的公告；支持 Markdown 内容、文档来源与图片。".into(),
            ..Notice::default()
        }]);
    }
    let mut notices: Vec<Notice> = serde_json::from_str(&read_text(&path)?)
        .context("无法读取 Notices.json，请检查公告配置格式")?;
    for notice in &mut notices {
        if !notice.source.is_empty() {
            let source = directory.join(&notice.source);
            match read_text(&source) {
                Ok(content) => {
                    notice.content = content;
                    if notice.title.is_empty() {
                        let first = notice.content.lines().next().unwrap_or("").trim();
                        if first.is_empty() {
                            notice.title = source
                                .file_stem()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .into_owned();
                        } else {
                            notice.title = first.trim_start_matches('#').trim().into();
                            notice.content = notice
                                .content
                                .lines()
                                .skip(1)
                                .collect::<Vec<_>>()
                                .join("\n");
                        }
                    }
                }
                Err(error) => {
                    notice.error = Some(format!("读取公告 {} 失败：{error}", notice.source))
                }
            }
        }
        if !notice.icon.is_empty()
            && !notice.icon.starts_with("http")
            && !notice.icon.starts_with("data:")
        {
            notice.icon = if notice.icon.starts_with("pack:") {
                "/assets/DefaultGameIcon/Minecraft.png".into()
            } else {
                directory.join(&notice.icon).to_string_lossy().into_owned()
            };
        }
    }
    Ok(notices)
}

pub fn background(directory: &Path, settings: &crate::config::Settings) -> String {
    match settings.background_type.as_str() {
        "default" => ["bg.png", "bg.jpg", "bg.jpeg"]
            .into_iter()
            .map(|name| directory.join(name))
            .find(|p| p.is_file())
            .unwrap_or_else(PathBuf::new)
            .to_string_lossy()
            .into_owned(),
        "local" | "remote" => settings.background.clone(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn custom_notices_preserve_inline_markdown_and_resolve_documents() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("welcome.md"), "# 欢迎\n\n**开始冒险**").unwrap();
        std::fs::write(dir.path().join("Notices.json"), r##"[{"source":"welcome.md","icon":"icon.png"},{"title":"更新","content":"- 新版本"},{"source":"missing.md"}]"##).unwrap();
        let notices = load(dir.path()).unwrap();
        assert_eq!(notices[0].title, "欢迎");
        assert_eq!(notices[0].content, "\n**开始冒险**");
        assert_eq!(
            notices[0].icon,
            dir.path().join("icon.png").to_string_lossy()
        );
        assert_eq!(notices[1].content, "- 新版本");
        assert!(notices[2].error.is_some());
        std::fs::write(dir.path().join("bg.jpg"), b"image").unwrap();
        let settings = crate::config::Settings {
            background_type: "default".into(),
            ..Default::default()
        };
        assert!(background(dir.path(), &settings).ends_with("bg.jpg"));
    }
}
