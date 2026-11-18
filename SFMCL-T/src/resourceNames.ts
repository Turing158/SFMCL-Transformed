import type { LocalizedName, LocalResource } from "./types";

const normalize = (name: string) =>
  name.trim().replace(/\s+/g, " ").toLowerCase();

export function resourceName(
  original: string,
  localized?: LocalizedName | null,
) {
  const name = localized?.name.trim();
  if (!name || !/\p{Script=Han}/u.test(name)) return original;
  if (!original.trim() || normalize(name) === normalize(original)) return name;
  return `${name}（${original}）`;
}

export function localResourceSearchText(item: LocalResource) {
  return [
    item.name,
    item.localizedName?.name,
    ...(item.localizedName?.aliases ?? []),
    item.authors,
    item.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
