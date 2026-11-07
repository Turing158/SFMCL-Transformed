import { describe, expect, it } from "vitest";
import {
  createHomeWidget,
  defaultHomeContent,
  homeWidgetTypes,
  repeatableWidget,
  reorderHomeWidgets,
  validateHomeContent,
  withHomeWidget,
  reconcileHomeNotices,
} from "./homeContentConfig";

describe("home content configuration", () => {
  it("splits the old news anchor into independent references at its original rank", () => {
    const player = createHomeWidget("player");
    const config = {
      schemaVersion: 1 as const,
      widgets: [player, ...defaultHomeContent().widgets],
    };
    const keys = ["notice:first", "notice:second", "notice:third"];
    const expanded = reconcileHomeNotices(config, keys, [keys[1], keys[0]]);
    expect(expanded.widgets.map((item) => item.id)).toEqual([
      player.id,
      keys[1],
      keys[0],
      keys[2],
    ]);
    expect(
      expanded.widgets.filter((item) => item.type === "notices"),
    ).toHaveLength(0);
    expect(reconcileHomeNotices(expanded, keys)).toBe(expanded);
    expanded.widgets[1].visible = false;
    const extended = reconcileHomeNotices(expanded, [...keys, "notice:fourth"]);
    expect(extended.widgets[1]).toEqual(expanded.widgets[1]);
    expect(extended.widgets[4].id).toBe("notice:fourth");
  });
  it("retains hidden anchor visibility and prevents duplicate references to a news item", () => {
    const config = defaultHomeContent();
    config.widgets[0].visible = false;
    const expanded = reconcileHomeNotices(config, [
      "notice:first",
      "notice:second",
    ]);
    expect(expanded.widgets.every((item) => !item.visible)).toBe(true);
    const restored = withHomeWidget(expanded, {
      id: "replacement",
      type: "notice",
      noticeKey: "notice:first",
      visible: true,
    });
    expect(restored.widgets[0]).toEqual({
      ...expanded.widgets[0],
      visible: true,
    });
    expect(() =>
      validateHomeContent({
        ...restored,
        widgets: [
          ...restored.widgets,
          {
            id: "duplicate",
            type: "notice",
            noticeKey: "notice:first",
            visible: true,
          },
        ],
      }),
    ).toThrow();
  });
  it("mixes news and custom cards while unavailable news keeps its rank", () => {
    const config = reconcileHomeNotices(defaultHomeContent(), [
      "notice:first",
      "notice:missing",
      "notice:second",
    ]);
    const custom = createHomeWidget("info", "笔记", "内容");
    config.widgets.push(custom);
    const order = [custom.id, "notice:first", "notice:second"];
    const result = reorderHomeWidgets(config, order, [
      "notice:first",
      "notice:second",
      custom.id,
    ]);
    expect(result.widgets.map((item) => item.id)).toEqual([
      custom.id,
      "notice:missing",
      "notice:first",
      "notice:second",
    ]);
  });
  it("retains the existing notices as the only default content", () => {
    expect(defaultHomeContent().widgets).toEqual([
      { id: "builtin:notices", type: "notices", visible: true },
    ]);
  });
  it.each(homeWidgetTypes.filter((type) => !repeatableWidget(type)))(
    "restores the original hidden %s instance without changing its rank",
    (type) => {
      const widget = { ...createHomeWidget(type), visible: false };
      const first = createHomeWidget("info", "清单", "内容");
      const config = { schemaVersion: 1 as const, widgets: [first, widget] };
      const restored = withHomeWidget(config, createHomeWidget(type));
      expect(restored.widgets).toEqual([first, { ...widget, visible: true }]);
      expect(withHomeWidget(restored, createHomeWidget(type))).toEqual(
        restored,
      );
      expect(() =>
        validateHomeContent({
          ...config,
          widgets: [...config.widgets, createHomeWidget(type)],
        }),
      ).toThrow("只能添加一个");
    },
  );
  it.each(["info", "announcement"] as const)(
    "allows multiple %s instances with the same content",
    (type) => {
      const first = createHomeWidget(type, "相同标题", "相同内容");
      const second = createHomeWidget(type, "相同标题", "相同内容");
      const config = withHomeWidget(
        withHomeWidget(defaultHomeContent(), first),
        second,
      );
      expect(config.widgets.slice(1)).toEqual([first, second]);
      expect(first.id).not.toBe(second.id);
    },
  );
  it("reorders visible slots while keeping hidden content and rank", () => {
    const config = withHomeWidget(
      withHomeWidget(defaultHomeContent(), createHomeWidget("player")),
      createHomeWidget("info", "笔记", "正文"),
    );
    config.widgets[1].visible = false;
    const [news, hidden, info] = config.widgets;
    expect(reorderHomeWidgets(config, [info.id, news.id]).widgets).toEqual([
      info,
      hidden,
      news,
    ]);
    for (const invalid of [
      [news.id],
      [info.id, info.id],
      [hidden.id, news.id],
    ]) {
      expect(reorderHomeWidgets(config, invalid)).toBe(config);
    }
  });
  it("rejects damaged, unsupported, duplicate or over-limit configurations", () => {
    const news = defaultHomeContent().widgets[0];
    for (const value of [
      null,
      {},
      { schemaVersion: 2, widgets: [] },
      { schemaVersion: 1, widgets: [{ ...news, type: "unknown" }] },
      { schemaVersion: 1, widgets: [news, { ...news, type: "player" }] },
      { schemaVersion: 1, widgets: [{ ...news, visible: "yes" }] },
      { schemaVersion: 1, widgets: [createHomeWidget("info", " ", "正文")] },
      {
        schemaVersion: 1,
        widgets: Array.from({ length: 31 }, () =>
          createHomeWidget("info", "标题", "内容"),
        ),
      },
    ])
      expect(() => validateHomeContent(value)).toThrow();
  });
});
