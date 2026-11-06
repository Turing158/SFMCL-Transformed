import { describe, expect, it } from "vitest";
import {
  isLittleSkinServer,
  parseYggdrasilDrop,
  readYggdrasilDrop,
} from "./yggdrasilDrop";

const server = "https://littleskin.cn/api/yggdrasil";
const card = (server: string) =>
  `authlib-injector:yggdrasil-server:${encodeURIComponent(server)}`;

describe("authlib-injector drag configuration", () => {
  it("accepts encoded, raw, URI-list and Firefox link payloads", () => {
    for (const value of [
      card(server),
      `authlib-injector:yggdrasil-server:${server}`,
      `# comment\r\n${card(server)}\r\n`,
      `${card(server)}\nLittleSkin`,
      `${card(server)}\n${card(server + "/")}`,
    ]) {
      expect(parseYggdrasilDrop(value)).toBe(server);
    }
    expect(parseYggdrasilDrop(card("https://skin.example/中文/api"))).toBe(
      "https://skin.example/%E4%B8%AD%E6%96%87/api",
    );
    expect(parseYggdrasilDrop(card("http://127.0.0.1:4567/yggdrasil"))).toBe(
      "http://127.0.0.1:4567/yggdrasil",
    );
  });
  it("ignores ordinary links, HTML, selected text and lookalike schemes", () => {
    for (const value of [
      "",
      server,
      "hello",
      `<a href=\"${card(server)}\">login</a>`,
      `x-${card(server)}`,
    ]) {
      expect(parseYggdrasilDrop(value)).toBeNull();
    }
  });
  it.each([
    "https://user:password@skin.example/api",
    "https://skin.example/api?token=secret",
    "https://skin.example/#secret",
    "https://skin.example/?",
    "https://skin.example/#",
    "http://skin.example/api",
    "javascript:alert(1)",
    "file:///C:/data",
    "https://skin.example/\napi",
    "https://skin.example\\@other.example",
    "https://",
    "",
    "https://skin.example/" + "a".repeat(2048),
  ])("rejects invalid or credential-bearing server URLs: %s", (value) => {
    expect(() => parseYggdrasilDrop(card(value))).toThrow();
  });
  it("rejects malformed encoding, oversized payloads and multiple servers", () => {
    for (const value of [
      "authlib-injector:yggdrasil-server:%E0%A4",
      card(server) + "\n" + card("https://other.example/api"),
      "a".repeat(16385),
    ]) {
      expect(() => parseYggdrasilDrop(value)).toThrow();
    }
  });
  it("uses supported MIME formats without consuming file drops", () => {
    const data = (types: string[], values: Record<string, string>) => ({
      types,
      getData: (type: string) => values[type] ?? "",
    });
    expect(
      readYggdrasilDrop(
        data(["text/plain", "text/uri-list"], {
          "text/plain": "LittleSkin",
          "text/uri-list": card(server),
        }),
      ),
    ).toBe(server);
    expect(
      readYggdrasilDrop(
        data(["Files", "text/plain"], { "text/plain": card(server) }),
      ),
    ).toBeNull();
    expect(
      readYggdrasilDrop(
        data(["text/x-moz-url"], {
          "text/x-moz-url": `${card(server)}\nLittleSkin`,
        }),
      ),
    ).toBe(server);
  });
  it("only enables automatic LittleSkin OAuth for its exact API endpoints", () => {
    expect(isLittleSkinServer(server)).toBe(true);
    expect(isLittleSkinServer("https://littlesk.in/api/yggdrasil/")).toBe(true);
    for (const value of [
      "https://littleskin.cn.evil.example/api/yggdrasil",
      "https://skin.example/api/yggdrasil",
      "https://littleskin.cn/other",
      "https://littleskin.cn:444/api/yggdrasil",
    ])
      expect(isLittleSkinServer(value)).toBe(false);
  });
});
