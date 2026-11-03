use super::{assign_local_ids, read_text, Notice};
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::path::Path;

const HIDDEN_PATH: &str = "HiddenNotices.json";
const MAX_BYTES: usize = 4 * 1024 * 1024;

fn records(path: &Path) -> Result<Vec<Value>> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = read_text(path)?;
    // Keep raw JSON to preserve document references, icon paths and extra fields.
    serde_json::from_str::<Vec<Notice>>(&text)
        .context("无法读取 Notices.json，请检查公告配置格式")?;
    Ok(serde_json::from_str(&text)?)
}

pub(super) fn hidden(directory: &Path) -> Result<Vec<String>> {
    let path = crate::paths::safe_join(directory, HIDDEN_PATH)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    serde_json::from_str(&read_text(&path)?)
        .context("隐藏公告配置读取失败，请检查 HiddenNotices.json")
}

pub(super) fn set_hidden(directory: &Path, id: &str, hide: bool) -> Result<Vec<String>> {
    if id.trim().is_empty() || id.len() > 512 {
        bail!("公告标识无效");
    }
    let mut ids = hidden(directory)?;
    ids.retain(|value| value != id);
    if hide {
        ids.push(id.to_owned());
    }
    let bytes = serde_json::to_vec_pretty(&ids)?;
    if bytes.len() > MAX_BYTES {
        bail!("隐藏公告配置超过 4 MB");
    }
    let path = crate::paths::safe_join(directory, HIDDEN_PATH)?;
    crate::paths::atomic_write(&path, &bytes).context("隐藏公告配置保存失败")?;
    Ok(ids)
}

pub(super) fn create(directory: &Path, title: &str, content: &str) -> Result<()> {
    let title = title.trim();
    let content = content.trim();
    if title.is_empty() || title.chars().count() > 120 {
        bail!("公告标题不能为空，且不能超过 120 个字符");
    }
    if content.is_empty() || content.chars().count() > 100_000 {
        bail!("公告内容不能为空，且不能超过 100000 个字符");
    }
    let path = crate::paths::safe_join(directory, "Notices.json")?;
    let mut records = records(&path)?;
    records.push(serde_json::json!({
        "id": format!("custom:{}", uuid::Uuid::new_v4()),
        "title": title,
        "content": content,
        "category": "自定义公告"
    }));
    let bytes = serde_json::to_vec_pretty(&records)?;
    if bytes.len() > MAX_BYTES {
        bail!("公告配置超过 4 MB，请减少公告内容");
    }
    crate::paths::atomic_write(&path, &bytes).context("新增公告保存失败")
}

pub(super) fn delete(directory: &Path, id: &str) -> Result<()> {
    let path = crate::paths::safe_join(directory, "Notices.json")?;
    let mut records = records(&path)?;
    let mut notices: Vec<Notice> = serde_json::from_value(Value::Array(records.clone()))?;
    assign_local_ids(&mut notices)?;
    let index = notices
        .iter()
        .position(|notice| notice.id == id)
        .context("只能删除自定义公告，或该公告已不存在")?;
    records.remove(index);
    let bytes = serde_json::to_vec_pretty(&records)?;
    if bytes.len() > MAX_BYTES {
        bail!("公告配置超过 4 MB，请减少公告内容");
    }
    crate::paths::atomic_write(&path, &bytes).context("删除公告保存失败")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notices::{load, OfficialNotices};

    #[test]
    fn legacy_ids_survive_reloads_document_edits_and_appends() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Notices.json");
        let original = r#"[{"source":"note.md","icon":"icon.png","extra":{"keep":true}},{"title":"相同"},{"title":"相同"}]"#;
        std::fs::write(&path, original).unwrap();
        std::fs::write(dir.path().join("note.md"), "# 原标题\n内容").unwrap();
        let before = load(dir.path()).unwrap();
        assert_ne!(before[1].id, before[2].id);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        std::fs::write(dir.path().join("note.md"), "# 新标题\n新内容").unwrap();
        create(dir.path(), " 新增 ", " **正文** ").unwrap();
        let after = load(dir.path()).unwrap();
        for index in 0..3 {
            assert_eq!(before[index].id, after[index].id);
        }
        let raw: Vec<Value> =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(raw[0]["source"], "note.md");
        assert_eq!(raw[0]["icon"], "icon.png");
        assert_eq!(raw[0]["extra"]["keep"], true);
        assert!(raw[0].get("title").is_none());
        assert_eq!(after[3].title, "新增");
        assert_eq!(after[3].content, "**正文**");
    }

    #[test]
    fn visibility_is_persistent_idempotent_and_reversible() {
        let dir = tempfile::tempdir().unwrap();
        let store = OfficialNotices::new(dir.path().into(), reqwest::Client::new());
        let welcome = store.list().unwrap()[0].id.clone();
        assert!(!welcome.is_empty());
        store.set_hidden(&welcome, true).unwrap();
        store.set_hidden(&welcome, true).unwrap();
        let reloaded = OfficialNotices::new(dir.path().into(), reqwest::Client::new());
        assert_eq!(reloaded.hidden().unwrap(), vec![welcome.clone()]);
        // The catalog retains hidden records so the UI can restore them.
        assert_eq!(reloaded.list().unwrap()[0].id, welcome);
        reloaded.set_hidden(&welcome, false).unwrap();
        assert!(reloaded.hidden().unwrap().is_empty());
        let created = reloaded.create("本地公告", "正文").unwrap();
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].title, "本地公告");
        assert!(!created[0].preset);
        assert!(reloaded.set_hidden(&created[0].id, true).is_err());
        reloaded.create("另一条", "正文").unwrap();
        assert!(reloaded.hidden().unwrap().is_empty());
        assert_eq!(reloaded.list().unwrap()[0].id, created[0].id);
    }

    #[test]
    fn delete_only_removes_the_selected_custom_record_and_preserves_raw_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Notices.json");
        let original = serde_json::json!([
            { "source": "notes.md", "icon": "icon.png", "extra": { "keep": true } },
            { "title": "相同" }, { "title": "相同" }
        ]);
        std::fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
        let store = OfficialNotices::new(dir.path().into(), reqwest::Client::new());
        let before = store.list().unwrap();
        assert!(store.delete("welcome:default").is_err());
        assert!(store.delete("java:test").is_err());
        let remaining = store.delete(&before[2].id).unwrap();
        assert_eq!(remaining.len(), 2);
        assert_eq!(remaining[0].id, before[0].id);
        assert_eq!(remaining[1].id, before[1].id);
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after[0], original[0]);
        assert_eq!(after[1], original[1]);
        store.delete(&remaining[0].id).unwrap();
        let last = store.list().unwrap();
        store.delete(&last[0].id).unwrap();
        let reloaded = OfficialNotices::new(dir.path().into(), reqwest::Client::new());
        assert!(reloaded.list().unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "[]");
    }

    #[test]
    fn invalid_input_and_damaged_files_are_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        assert!(create(dir.path(), " ", "正文").is_err());
        assert!(create(dir.path(), "标题", " ").is_err());
        assert!(create(dir.path(), &"长".repeat(121), "正文").is_err());
        assert!(!dir.path().join("Notices.json").exists());
        for text in ["broken", "{}", "[null]"] {
            std::fs::write(dir.path().join("Notices.json"), text).unwrap();
            assert!(create(dir.path(), "标题", "正文").is_err());
            assert!(delete(dir.path(), "local:custom:test").is_err());
            assert_eq!(
                std::fs::read_to_string(dir.path().join("Notices.json")).unwrap(),
                text
            );
        }
        std::fs::write(dir.path().join(HIDDEN_PATH), "broken").unwrap();
        assert!(set_hidden(dir.path(), "java:test", true).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join(HIDDEN_PATH)).unwrap(),
            "broken"
        );
    }

    #[test]
    fn failed_save_does_not_report_a_successful_mutation() {
        let dir = tempfile::tempdir().unwrap();
        // A directory occupying the file path simulates a blocked destination.
        std::fs::create_dir(dir.path().join(HIDDEN_PATH)).unwrap();
        assert!(set_hidden(dir.path(), "news:test", true).is_err());
        std::fs::create_dir(dir.path().join("Notices.json")).unwrap();
        assert!(create(dir.path(), "标题", "正文").is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[cfg(windows)]
    #[test]
    fn blocked_delete_preserves_the_original_record_and_cleans_its_temporary_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        create(dir.path(), "需要保留", "正文").unwrap();
        let id = load(dir.path()).unwrap()[0].id.clone();
        let path = dir.path().join("Notices.json");
        let before = std::fs::read(&path).unwrap();
        // Allow reads but block replacing the destination while it is in use.
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(delete(dir.path(), &id).is_err());
        drop(lock);
        assert_eq!(std::fs::read(path).unwrap(), before);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
