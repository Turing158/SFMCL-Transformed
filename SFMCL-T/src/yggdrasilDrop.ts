const prefix = "authlib-injector:yggdrasil-server:";
const invalidCard = "外置登录卡片中的服务器地址无效，请从皮肤站重新拖入。";

// authlib-injector cards carry a percent-encoded API URL, never credentials.
export function parseYggdrasilDrop(text: string): string | null {
  if (text.length > 16384) throw new Error(invalidCard);
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const cards = lines.filter((line) => line.toLowerCase().startsWith(prefix));
  if (!cards.length) return null;
  const servers = cards.map((card) => {
    let address: string;
    let url: URL;
    try {
      const value = card.slice(prefix.length);
      // Accept both encoded cards and the unescaped form used by some sites.
      address = /^https?:\/\//i.test(value) ? value : decodeURIComponent(value);
      url = new URL(address);
    } catch {
      throw new Error(invalidCard);
    }
    const local =
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127\./.test(url.hostname);
    if (
      address.length > 2048 ||
      /[\s\x00-\x1f\x7f\\]/.test(address) ||
      !/^https?:\/\//i.test(address) ||
      !(url.protocol === "https:" || (url.protocol === "http:" && local)) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[?#]/.test(address)
    )
      throw new Error(invalidCard);
    return url.href.replace(/\/+$/, "");
  });
  if (new Set(servers).size !== 1)
    throw new Error("请一次拖入一个外置登录卡片。");
  return servers[0];
}

export function isLittleSkinServer(server: string): boolean {
  const url = new URL(server);
  return (
    url.protocol === "https:" &&
    !url.port &&
    ["littleskin.cn", "littlesk.in"].includes(url.hostname) &&
    url.pathname.replace(/\/+$/, "") === "/api/yggdrasil"
  );
}

export function yggdrasilServerLabel(server: string): string {
  return isLittleSkinServer(server) ? "LittleSkin" : new URL(server).hostname;
}

export function readYggdrasilDrop(
  data: Pick<DataTransfer, "types" | "getData">,
): string | null {
  if (Array.from(data.types).includes("Files")) return null;
  for (const type of ["text/plain", "text/uri-list", "text/x-moz-url"]) {
    const server = parseYggdrasilDrop(data.getData(type));
    if (server) return server;
  }
  return null;
}
