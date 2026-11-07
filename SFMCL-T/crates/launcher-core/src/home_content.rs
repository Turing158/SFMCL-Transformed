use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path, sync::Mutex};

const FILE: &str = "HomeContent.json";
const MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeContent {
    pub schema_version: u32,
    pub widgets: Vec<HomeWidget>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HomeWidget {
    pub id: String,
    pub visible: bool,
    #[serde(flatten)]
    pub content: WidgetContent,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum WidgetContent {
    Notices,
    Notice {
        notice_key: String,
    },
    Player,
    Info {
        title: String,
        content: String,
        note: String,
    },
    Announcement {
        title: String,
        content: String,
    },
    Links,
    Version,
}
impl Default for HomeContent {
    fn default() -> Self {
        Self {
            schema_version: 1,
            widgets: vec![HomeWidget {
                id: "builtin:notices".into(),
                visible: true,
                content: WidgetContent::Notices,
            }],
        }
    }
}
impl HomeContent {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 1 {
            bail!("首页组件配置版本不受支持");
        }
        if self
            .widgets
            .iter()
            .filter(|item| !matches!(item.content, WidgetContent::Notice { .. }))
            .count()
            > 30
            || self.widgets.len() > 1024
        {
            bail!("首页最多支持 30 个自定义与固定组件");
        }
        let mut ids = HashSet::new();
        let mut singletons = HashSet::new();
        for item in &self.widgets {
            if item.id.trim().is_empty()
                || item.id.encode_utf16().count()
                    > if matches!(item.content, WidgetContent::Notice { .. }) {
                        4096
                    } else {
                        128
                    }
                || !ids.insert(&item.id)
            {
                bail!("首页组件标识无效或重复");
            }
            let singleton = match &item.content {
                WidgetContent::Notices => Some("新闻资讯".to_owned()),
                WidgetContent::Notice { notice_key } => {
                    if !notice_key.starts_with("notice:")
                        || notice_key.encode_utf16().count() > 4096
                    {
                        bail!("新闻资讯引用无效");
                    }
                    Some(notice_key.clone())
                }
                WidgetContent::Player => Some("角色卡片".to_owned()),
                WidgetContent::Links => Some("快捷入口".to_owned()),
                WidgetContent::Version => Some("版本卡片".to_owned()),
                WidgetContent::Info {
                    title,
                    content,
                    note,
                } => {
                    validate_text(title, content)?;
                    if note.chars().count() > 120 {
                        bail!("组件备注超过 120 个字符");
                    }
                    None
                }
                WidgetContent::Announcement { title, content } => {
                    validate_text(title, content)?;
                    None
                }
            };
            if let Some(name) = singleton {
                if !singletons.insert(name.clone()) {
                    bail!("{name}只能添加一个");
                }
            }
        }
        Ok(())
    }
}
fn validate_text(title: &str, content: &str) -> Result<()> {
    if title.trim().is_empty() || title.chars().count() > 120 {
        bail!("组件标题不能为空且不能超过 120 个字符");
    }
    if content.trim().is_empty() || content.chars().count() > 100_000 {
        bail!("组件内容不能为空且不能超过 100000 个字符");
    }
    Ok(())
}
pub struct HomeContentStore {
    lock: Mutex<()>,
}
impl Default for HomeContentStore {
    fn default() -> Self {
        Self {
            lock: Mutex::new(()),
        }
    }
}
impl HomeContentStore {
    pub fn load(&self, directory: &Path) -> Result<HomeContent> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| anyhow::anyhow!("首页组件配置锁不可用"))?;
        let path = crate::paths::safe_join(directory, FILE)?;
        if !path.exists() {
            return Ok(HomeContent::default());
        }
        if std::fs::metadata(&path)?.len() > MAX_BYTES as u64 {
            bail!("首页组件配置超过 4 MB");
        }
        let source = std::fs::read_to_string(&path)?;
        let value: HomeContent = serde_json::from_str(source.trim_start_matches('\u{feff}'))
            .context("首页组件配置格式无效")?;
        value.validate()?;
        Ok(value)
    }
    pub fn save(&self, directory: &Path, value: HomeContent) -> Result<HomeContent> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| anyhow::anyhow!("首页组件配置锁不可用"))?;
        value.validate()?;
        let bytes = serde_json::to_vec_pretty(&value)?;
        if bytes.len() > MAX_BYTES {
            bail!("首页组件配置超过 4 MB");
        }
        crate::paths::atomic_write(&crate::paths::safe_join(directory, FILE)?, &bytes)
            .context("保存首页组件配置失败")?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decode(value: serde_json::Value) -> HomeContent {
        serde_json::from_value(value).unwrap()
    }
    #[test]
    fn fixed_widgets_are_unique_even_when_hidden() {
        for kind in ["notices", "player", "links", "version"] {
            let value = decode(json!({"schemaVersion":1,"widgets":[
                {"id":"first","type":kind,"visible":false},
                {"id":"second","type":kind,"visible":true}
            ]}));
            assert!(value
                .validate()
                .unwrap_err()
                .to_string()
                .contains("只能添加一个"));
        }
    }
    #[test]
    fn separate_news_references_persist_and_cannot_duplicate_the_same_article() {
        let directory = tempfile::tempdir().unwrap();
        let value = decode(json!({"schemaVersion":1,"widgets":[
            {"id":"notice:first","type":"notice","noticeKey":"notice:first","visible":false},
            {"id":"player","type":"player","visible":true},
            {"id":"notice:second","type":"notice","noticeKey":"notice:second","visible":true}
        ]}));
        let store = HomeContentStore::default();
        store.save(directory.path(), value).unwrap();
        let mut saved = store.load(directory.path()).unwrap();
        assert_eq!(saved.widgets[0].id, "notice:first");
        assert_eq!(saved.widgets[1].id, "player");
        let mut duplicate = saved.widgets[0].clone();
        duplicate.id = "another-id".into();
        saved.widgets.push(duplicate);
        assert!(saved.validate().is_err());
    }
    #[test]
    fn custom_instances_roundtrip_with_identity_and_visibility() {
        let directory = tempfile::tempdir().unwrap();
        let store = HomeContentStore::default();
        let value = decode(json!({"schemaVersion":1,"widgets":[
            {"id":"builtin:notices","type":"notices","visible":true},
            {"id":"first","type":"info","title":"清单","content":"**内容**","note":"备注","visible":false},
            {"id":"second","type":"info","title":"清单","content":"**内容**","note":"备注","visible":true},
            {"id":"third","type":"announcement","title":"公告","content":"正文","visible":true},
            {"id":"fourth","type":"announcement","title":"公告","content":"正文","visible":false}
        ]}));
        store.save(directory.path(), value.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(store.load(directory.path()).unwrap()).unwrap(),
            serde_json::to_value(value).unwrap()
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
    #[test]
    fn missing_defaults_and_invalid_saves_preserve_existing_data() {
        let directory = tempfile::tempdir().unwrap();
        let store = HomeContentStore::default();
        assert_eq!(
            store.load(directory.path()).unwrap().widgets[0].id,
            "builtin:notices"
        );
        assert!(!directory.path().join(FILE).exists());
        store
            .save(directory.path(), HomeContent::default())
            .unwrap();
        let before = std::fs::read(directory.path().join(FILE)).unwrap();
        for value in [
            json!({"schemaVersion":2,"widgets":[]}),
            json!({"schemaVersion":1,"widgets":[{"id":"x","type":"announcement","title":" ","content":"正文","visible":true}]}),
            json!({"schemaVersion":1,"widgets":[{"id":"x","type":"info","title":"标题","content":"正文","note":"x".repeat(121),"visible":true}]}),
        ] {
            assert!(store.save(directory.path(), decode(value)).is_err());
            assert_eq!(std::fs::read(directory.path().join(FILE)).unwrap(), before);
        }
    }
    #[test]
    fn damaged_and_unknown_configs_are_not_overwritten_on_load() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(FILE);
        for source in [
            "invalid",
            r#"{"schemaVersion":1,"widgets":[{"id":"x","type":"future","visible":true}]}"#,
        ] {
            std::fs::write(&path, source).unwrap();
            assert!(HomeContentStore::default().load(directory.path()).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), source);
        }
    }
    #[test]
    fn failed_atomic_write_leaves_no_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join(FILE)).unwrap();
        assert!(HomeContentStore::default()
            .save(directory.path(), HomeContent::default())
            .is_err());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
