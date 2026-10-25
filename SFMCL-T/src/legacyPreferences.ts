// Copy only known view preferences. New choices win and legacy values stay intact.
export function migrateLegacyPreferences(
  storage: Pick<Storage, "getItem" | "setItem">,
) {
  for (const page of ["players", "resources", "versions"]) {
    const key = `sfmcl-t.${page}.view`;
    if (storage.getItem(key) !== null) continue;
    const value = storage.getItem(`tmcl.${page}.view`);
    if (value !== null) storage.setItem(key, value);
  }
}
