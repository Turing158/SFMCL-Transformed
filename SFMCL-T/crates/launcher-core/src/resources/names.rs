use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::OnceLock};

const MODS: &str = include_str!("../../resources/hmcl/mod.csv");
const MODPACKS: &str = include_str!("../../resources/hmcl/modpack.csv");

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LocalizedName {
    pub name: String,
    pub aliases: Vec<String>,
}

#[derive(Clone, Copy)]
pub enum NameKind {
    Mod,
    Modpack,
}

struct Record {
    name: String,
    aliases: Vec<String>,
    search_names: [String; 2],
    slugs: [String; 2],
}

#[derive(Default)]
struct Registry {
    records: Vec<Record>,
    curseforge: HashMap<String, Vec<usize>>,
    modrinth: HashMap<String, Vec<usize>>,
    mod_ids: HashMap<String, Vec<usize>>,
    names: HashMap<String, Vec<usize>>,
}

// HMCL uses backslash escapes instead of quoted CSV fields. Decode UTF-16
// escapes together so supplementary characters represented by surrogate pairs survive.
fn decode(field: &str) -> Option<String> {
    let mut units = Vec::new();
    let mut chars = field.chars();
    while let Some(mut ch) = chars.next() {
        if ch == '\\' {
            ch = match chars.next() {
                None => '\\',
                Some('0') => '\0',
                Some('n') => '\n',
                Some('r') => '\r',
                Some('t') => '\t',
                Some('c') => ',',
                Some('\\') => '\\',
                Some('u') => {
                    let mut value = 0;
                    for _ in 0..4 {
                        value = value * 16 + chars.next()?.to_digit(16)?;
                    }
                    units.push(value as u16);
                    continue;
                }
                _ => return None,
            };
        }
        units.extend(ch.encode_utf16(&mut [0; 2]).iter().copied());
    }
    String::from_utf16(&units).ok()
}

fn normalize(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn index(map: &mut HashMap<String, Vec<usize>>, key: String, row: usize) {
    if !key.is_empty() {
        let rows = map.entry(key).or_default();
        if !rows.contains(&row) {
            rows.push(row);
        }
    }
}

impl Registry {
    fn parse(data: &str, kind: NameKind) -> Self {
        let mut registry = Self::default();
        let columns = match kind {
            NameKind::Mod => 7,
            NameKind::Modpack => 6,
        };
        for line in data.trim_start_matches('\u{feff}').lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some(fields) = line.split(',').map(decode).collect::<Option<Vec<_>>>() else {
                continue;
            };
            if fields.len() != columns || fields[0].parse::<u32>().is_err() || fields[3].is_empty()
            {
                continue;
            }
            let row = registry.records.len();
            let mut aliases = Vec::new();
            for field in &fields[3..6] {
                if !field.is_empty() && !aliases.contains(field) {
                    aliases.push(field.clone());
                    index(&mut registry.names, normalize(field), row);
                }
            }
            let mod_ids: Vec<String> = fields.get(6).map_or_else(Vec::new, |ids| {
                ids.split(';')
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
                    .collect()
            });
            for id in &mod_ids {
                index(&mut registry.mod_ids, id.clone(), row);
            }
            index(&mut registry.curseforge, fields[1].clone(), row);
            index(&mut registry.modrinth, fields[2].clone(), row);
            registry.records.push(Record {
                name: fields[3].clone(),
                aliases,
                search_names: [1, 2].map(|column| {
                    if !fields[4].is_empty() {
                        fields[4].clone()
                    } else if !fields[column].is_empty() {
                        fields[column].replace('-', " ")
                    } else {
                        fields[5].clone()
                    }
                }),
                slugs: [fields[1].clone(), fields[2].clone()],
            });
        }
        registry
    }

    fn unique(&self, rows: &[usize]) -> Option<LocalizedName> {
        if rows.len() != 1 {
            return None;
        }
        let record = &self.records[rows[0]];
        Some(LocalizedName {
            name: record.name.clone(),
            aliases: record.aliases.clone(),
        })
    }

    fn platform(&self, source: &str, id: &str, slug: &str) -> Option<LocalizedName> {
        let map = match source {
            "curseforge" => &self.curseforge,
            "modrinth" => &self.modrinth,
            _ => return None,
        };
        let mut rows = Vec::new();
        for key in [id, slug] {
            for row in map.get(key).into_iter().flatten() {
                if !rows.contains(row) {
                    rows.push(*row);
                }
            }
        }
        self.unique(&rows)
    }

    fn local(&self, ids: &[String], name: &str) -> Option<LocalizedName> {
        if ids.is_empty() {
            return self.unique(self.names.get(&normalize(name))?);
        }
        let mut rows = Vec::new();
        for id in ids {
            for row in self.mod_ids.get(id).into_iter().flatten() {
                if !rows.contains(row) {
                    rows.push(*row);
                }
            }
        }
        if rows.len() > 1 {
            let name = normalize(name);
            rows.retain(|row| {
                self.records[*row]
                    .aliases
                    .iter()
                    .any(|alias| normalize(alias) == name)
            });
        }
        self.unique(&rows)
    }

    fn search(&self, source: &str, query: &str) -> Option<String> {
        let source = match source {
            "curseforge" => 0,
            "modrinth" => 1,
            _ => return None,
        };
        let query = normalize(query);
        // Prefer the complete name over similarly named addons. For a partial
        // name, only rewrite when every match resolves to the same search term.
        let rows = self.names.get(&query).cloned().unwrap_or_else(|| {
            self.records
                .iter()
                .enumerate()
                .filter(|(_, record)| {
                    record
                        .aliases
                        .iter()
                        .any(|alias| normalize(alias).contains(&query))
                })
                .map(|(row, _)| row)
                .collect()
        });
        let first = &self.records[*rows.first()?].search_names[source];
        if first.is_empty()
            || rows
                .iter()
                .any(|row| normalize(&self.records[*row].search_names[source]) != normalize(first))
        {
            return None;
        }
        Some(first.clone())
    }

    fn search_slugs(&self, source: &str, query: &str) -> Vec<String> {
        let source = match source {
            "curseforge" => 0,
            "modrinth" => 1,
            _ => return Vec::new(),
        };
        let query = normalize(query);
        let terms = query.split_whitespace().collect::<Vec<_>>();
        let mut matches = self
            .records
            .iter()
            .enumerate()
            .filter_map(|(row, record)| {
                let slug = &record.slugs[source];
                let text = normalize(&record.aliases.join(" "));
                if slug.is_empty() || !terms.iter().all(|term| text.contains(term)) {
                    return None;
                }
                let rank = record
                    .aliases
                    .iter()
                    .map(|alias| {
                        let alias = normalize(alias);
                        if alias == query {
                            0
                        } else if alias.starts_with(&query) {
                            1
                        } else {
                            2
                        }
                    })
                    .min()
                    .unwrap_or(2);
                Some(((rank, record.name.chars().count(), row), slug.clone()))
            })
            .collect::<Vec<_>>();
        matches.sort_by_key(|(rank, _)| *rank);
        let mut seen = std::collections::HashSet::new();
        matches
            .into_iter()
            .map(|(_, slug)| slug)
            .filter(|slug| seen.insert(slug.clone()))
            .collect()
    }
}

fn registry(kind: NameKind) -> &'static Registry {
    static MOD_REGISTRY: OnceLock<Registry> = OnceLock::new();
    static MODPACK_REGISTRY: OnceLock<Registry> = OnceLock::new();
    match kind {
        NameKind::Mod => MOD_REGISTRY.get_or_init(|| Registry::parse(MODS, kind)),
        NameKind::Modpack => MODPACK_REGISTRY.get_or_init(|| Registry::parse(MODPACKS, kind)),
    }
}

pub fn platform(kind: NameKind, source: &str, id: &str, slug: &str) -> Option<LocalizedName> {
    registry(kind).platform(source, id, slug)
}

pub fn local_mod(ids: &[String], name: &str) -> Option<LocalizedName> {
    registry(NameKind::Mod).local(ids, name)
}

pub fn local_modpack(name: &str) -> Option<LocalizedName> {
    registry(NameKind::Modpack).local(&[], name)
}

pub(super) fn contains_han(query: &str) -> bool {
    static HAN: OnceLock<regex::Regex> = OnceLock::new();
    HAN.get_or_init(|| regex::Regex::new(r"\p{Han}").unwrap())
        .is_match(query)
}

pub fn search_query(kind: &str, source: &str, query: &str) -> String {
    let kind = match kind {
        "mod" => NameKind::Mod,
        "modpack" => NameKind::Modpack,
        _ => return query.to_owned(),
    };
    if !contains_han(query) {
        return query.to_owned();
    }
    registry(kind)
        .search(source, query)
        .unwrap_or_else(|| query.to_owned())
}

pub fn search_slugs(kind: &str, source: &str, query: &str) -> Vec<String> {
    if search_query(kind, source, query) != query {
        return Vec::new();
    }
    let kind = match kind {
        "mod" => NameKind::Mod,
        "modpack" => NameKind::Modpack,
        _ => return Vec::new(),
    };
    if !contains_han(query) || query.trim().is_empty() {
        return Vec::new();
    }
    registry(kind).search_slugs(source, query)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn translates_chinese_searches_using_the_same_name_registry() {
        for (kind, query, expected) in [
            ("mod", "钠", "Sodium"),
            ("mod", "  机械动力  ", "Create"),
            ("mod", "JEI物品管理器", "Just Enough Items"),
            ("modpack", "格雷科技：新视野", "GT: New Horizons"),
            ("modpack", "天空工厂4", "SkyFactory 4"),
            ("mod", "Sodium", "Sodium"),
            ("mod", "JEI", "JEI"),
            ("mod", "未收录的模组名称", "未收录的模组名称"),
            ("mod", "", ""),
            ("shader", "钠", "钠"),
            ("resourcepack", "机械动力", "机械动力"),
            ("datapack", "机械动力", "机械动力"),
        ] {
            assert_eq!(
                search_query(kind, "modrinth", query),
                expected,
                "{kind}: {query}"
            );
        }
    }

    #[test]
    fn searches_partial_names_and_aliases_without_picking_an_ambiguous_record() {
        let registry = Registry::parse(
            "1,alpha,alpha,测试模组,Alpha,中文别名,alpha\n2,addon,addon,测试模组附属,Alpha Addon,,addon\n3,no-english,other-slug,缺少英文,,,empty\n4,,,缩写模组,,AB,short\n5,,,缺少搜索名称,,,missing\n",
            NameKind::Mod,
        );
        assert_eq!(
            registry.search("modrinth", "测试模组").as_deref(),
            Some("Alpha")
        );
        assert_eq!(
            registry.search("modrinth", "中文别").as_deref(),
            Some("Alpha")
        );
        assert_eq!(
            registry.search("modrinth", "模组附属").as_deref(),
            Some("Alpha Addon")
        );
        assert_eq!(
            registry.search("modrinth", "缩写模组").as_deref(),
            Some("AB")
        );
        assert_eq!(
            registry.search("modrinth", "缺少英文").as_deref(),
            Some("other slug")
        );
        assert_eq!(
            registry.search("curseforge", "缺少英文").as_deref(),
            Some("no english")
        );
        assert!(registry.search("modrinth", "测试").is_none());
        assert!(registry.search("modrinth", "缺少搜索名称").is_none());
        assert_eq!(
            registry.search_slugs("modrinth", "测试"),
            ["alpha", "addon"]
        );
        assert_eq!(
            registry.search_slugs("modrinth", "测试 模组"),
            ["alpha", "addon"]
        );
    }

    #[test]
    fn ambiguous_chinese_keywords_include_all_matching_platform_projects() {
        for source in ["modrinth", "curseforge"] {
            let slugs = search_slugs("mod", source, "机械");
            assert!(slugs.len() > 100);
            assert!(slugs.iter().any(|slug| slug == "create"));
            assert!(slugs.iter().position(|slug| slug == "create").unwrap() < 20);
            assert!(search_slugs("mod", source, "钠").is_empty());
            assert!(search_slugs("mod", source, "未收录的模组名称").is_empty());
            assert!(search_slugs("shader", source, "机械").is_empty());
            assert!(search_slugs("mod", source, "Create").is_empty());
        }
    }

    #[test]
    fn pinned_resources_are_complete_and_match_recorded_checksums() {
        let metadata: serde_json::Value =
            serde_json::from_str(include_str!("../../resources/hmcl/source.json")).unwrap();
        for (data, kind, file) in [(MODS, NameKind::Mod, 0), (MODPACKS, NameKind::Modpack, 1)] {
            let registry = Registry::parse(data, kind);
            assert_eq!(
                registry.records.len(),
                data.lines()
                    .filter(|line| !line.is_empty() && !line.starts_with('#'))
                    .count()
            );
            assert_eq!(
                format!("{:x}", Sha256::digest(data.as_bytes())),
                metadata["files"][file]["sha256"].as_str().unwrap()
            );
        }
        assert!(registry(NameKind::Mod).records.len() > 30_000);
        assert!(registry(NameKind::Modpack).records.len() > 1_000);
    }

    #[test]
    fn resolves_real_platform_mod_ids_and_local_pack_names() {
        assert_eq!(
            platform(NameKind::Mod, "modrinth", "AANobbMI", "sodium")
                .unwrap()
                .name,
            "钠"
        );
        assert_eq!(
            platform(NameKind::Mod, "curseforge", "328085", "create")
                .unwrap()
                .name,
            "机械动力"
        );
        assert_eq!(
            local_mod(&["jei".into()], "Just Enough Items")
                .unwrap()
                .name,
            "JEI物品管理器"
        );
        assert_eq!(
            local_modpack("  GT:   New Horizons ").unwrap().name,
            "格雷科技：新视野"
        );
        assert_eq!(
            platform(NameKind::Modpack, "curseforge", "", "skyfactory-4")
                .unwrap()
                .name,
            "天空工厂4"
        );
        assert!(platform(NameKind::Modpack, "modrinth", "", "sodium").is_none());
        assert_eq!(local_modpack("SkyFactory 5").unwrap().name, "天空工厂 5");
        assert!(local_modpack("SkyFactory 9999").is_none());
        assert!(local_mod(&["unlisted-id".into()], "Create").is_none());
    }

    #[test]
    fn decodes_escapes_and_rejects_incomplete_records() {
        assert_eq!(
            decode(r"Dungeons\c Dragons\n\uD83D\uDE00\\"),
            Some("Dungeons, Dragons\n😀\\".into())
        );
        let data = "# comment\n1,a,b,名称,English\\c Name,EN,one;two\ninvalid\n2,a,b,坏\\q,,,x\n";
        let registry = Registry::parse(data, NameKind::Mod);
        assert_eq!(registry.records.len(), 1);
        assert_eq!(
            registry.local(&["two".into()], "").unwrap().aliases[1],
            "English, Name"
        );
    }

    #[test]
    fn duplicate_identifiers_need_unique_name_confirmation() {
        let registry = Registry::parse(
            "1,same,,甲,Alpha,,shared\n2,same,,乙,Beta,,shared\n",
            NameKind::Mod,
        );
        assert!(registry.platform("curseforge", "", "same").is_none());
        assert!(registry.local(&["shared".into()], "Unknown").is_none());
        assert_eq!(
            registry.local(&["shared".into()], "Beta").unwrap().name,
            "乙"
        );
        assert_eq!(registry.local(&[], "alpha").unwrap().name, "甲");
    }
}
