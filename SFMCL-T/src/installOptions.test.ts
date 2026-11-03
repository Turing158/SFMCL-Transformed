import { describe, expect, it } from "vitest";
import {
  matchesVersionFilter,
  compatibleOptifine,
  availableLoaderChoices,
  componentBlockReason,
  emptyInstallSelection,
  installSelectionPayload,
  installVersionName,
  selectInstallLoader,
} from "./installOptions";
import type { Loader, ResourceFile } from "./types";
describe("安装选项与原版分类兼容", () => {
  it.each(["26w14a", "22w13oneblockatatime", "22w13oneBlockAtATime"])(
    "%s 属于愚人节分类，排除普通快照分类",
    (id) => {
      const version = { id, type: "snapshot" };
      expect(matchesVersionFilter(version, "april")).toBe(true);
      expect(matchesVersionFilter(version, "snapshot")).toBe(false);
      expect(matchesVersionFilter(version, "all")).toBe(true);
    },
  );
  it("愚人节版本独立分类，历史版包含 alpha 与 beta", () => {
    const version = {
      id: "24w14potato",
      type: "snapshot",
      releaseTime: "",
      url: "",
    };
    expect(matchesVersionFilter(version, "april")).toBe(true);
    expect(matchesVersionFilter(version, "snapshot")).toBe(false);
    expect(
      matchesVersionFilter(
        { ...version, type: "old_alpha", id: "a1.2.6" },
        "old",
      ),
    ).toBe(true);
    expect(
      matchesVersionFilter(
        { ...version, type: "old_beta", id: "b1.7.3" },
        "old",
      ),
    ).toBe(true);
  });
  it("只允许元数据指定的 Forge 与 OptiFine 组合", () => {
    const choice = {
      kind: "OptiFine",
      version: "HD_U_I6",
      metadata: { forge: "Forge 47.2.18" },
    };
    expect(compatibleOptifine(choice, "47.2.18")).toBe(true);
    expect(compatibleOptifine(choice, "47.4.0")).toBe(false);
    expect(
      compatibleOptifine({ ...choice, metadata: { forge: "N/A" } }, "47.2.18"),
    ).toBe(false);
  });
});

describe("组合安装", () => {
  const forge: Loader = {
    kind: "Forge",
    version: "47.2.18",
    metadata: { mcversion: "1.20.1" },
  };
  const optifine: Loader = {
    kind: "OptiFine",
    version: "HD_U_I6",
    metadata: { forge: "Forge 47.2.18", mcversion: "1.20.1" },
  };
  const fabric: Loader = { kind: "Fabric", version: "0.16.10", metadata: {} };
  const fabricApi: ResourceFile = {
    id: "api",
    name: "Fabric API",
    version: "0.92.0",
    date: "",
    gameVersions: ["1.20.1"],
    loaders: ["fabric"],
    dependencies: [],
    file: { path: "fabric-api.jar", url: "https://example.com/api.jar" },
  };

  it("任意顺序选择 Forge 与 OptiFine 都生成加载器加模组请求", () => {
    for (const [first, second] of [
      [forge, optifine],
      [optifine, forge],
    ]) {
      let selected = selectInstallLoader(
        emptyInstallSelection,
        first.kind as "Forge" | "OptiFine",
        first,
      );
      selected = selectInstallLoader(
        selected,
        second.kind as "Forge" | "OptiFine",
        second,
      );
      expect(installSelectionPayload(selected)).toEqual({
        loader: forge,
        optifine,
        fabricApi: null,
      });
      expect(installVersionName("1.20.1", selected)).toBe(
        "1.20.1-forge-47.2.18",
      );
      expect(componentBlockReason("Fabric", selected)).toContain(
        "不能同时安装",
      );
    }
  });
  it("双向筛选只保留官网标注的 Forge 版本，不把 N/A 或缺失元数据当成通配符", () => {
    const unknown = { ...optifine, metadata: {} };
    const unavailable = { ...optifine, metadata: { forge: "Forge N/A" } };
    expect(
      availableLoaderChoices("OptiFine", [optifine, unknown, unavailable], {
        ...emptyInstallSelection,
        loader: forge,
      }),
    ).toEqual([optifine]);
    expect(
      availableLoaderChoices(
        "Forge",
        [forge, { ...forge, version: "47.4.0" }],
        { ...emptyInstallSelection, optifine },
      ),
    ).toEqual([forge]);
    expect(
      compatibleOptifine(
        { ...optifine, metadata: { forge: " forge 47.2.18 " } },
        forge.version,
      ),
    ).toBe(true);
    expect(
      componentBlockReason("Forge", {
        ...emptyInstallSelection,
        optifine: unavailable,
      }),
    ).toContain("未标注");
    expect(
      installSelectionPayload({
        ...emptyInstallSelection,
        optifine: unavailable,
      }).loader,
    ).toBe(unavailable);
  });
  it("取消 Forge 后保留独立 OptiFine，取消 Fabric 同时清除 API", () => {
    expect(
      installVersionName(
        "1.20.1",
        selectInstallLoader(
          { ...emptyInstallSelection, loader: forge, optifine },
          "Forge",
          null,
        ),
      ),
    ).toBe("1.20.1-optifine_1.20.1_HD_U_I6");
    expect(
      installVersionName("1.20.1", {
        ...emptyInstallSelection,
        loader: fabric,
        fabricApi,
      }),
    ).toBe("1.20.1-fabric-0.16.10");
    expect(
      installSelectionPayload(
        selectInstallLoader(
          { ...emptyInstallSelection, loader: forge, optifine },
          "Forge",
          null,
        ),
      ),
    ).toEqual({ loader: optifine, optifine: null, fabricApi: null });
    expect(
      selectInstallLoader(
        { ...emptyInstallSelection, loader: fabric, fabricApi },
        "Fabric",
        null,
      ),
    ).toEqual(emptyInstallSelection);
    expect(
      installSelectionPayload({
        ...emptyInstallSelection,
        loader: fabric,
        fabricApi,
      }),
    ).toEqual({ loader: fabric, optifine: null, fabricApi: fabricApi.file });
  });
  it("拒绝互斥、版本不匹配和缺少 Fabric 的组合", () => {
    const selected = { ...emptyInstallSelection, loader: fabric };
    expect(selectInstallLoader(selected, "Forge", forge)).toBe(selected);
    expect(() => installSelectionPayload({ ...selected, optifine })).toThrow(
      "不兼容",
    );
    expect(() =>
      installSelectionPayload({
        ...emptyInstallSelection,
        loader: { ...forge, version: "47.4.0" },
        optifine,
      }),
    ).toThrow("不兼容");
    expect(() =>
      installSelectionPayload({ ...emptyInstallSelection, fabricApi }),
    ).toThrow("Fabric Loader");
    expect(installSelectionPayload(emptyInstallSelection)).toEqual({
      loader: null,
      optifine: null,
      fabricApi: null,
    });
  });
});

describe("安装版本自动命名", () => {
  it("官网和镜像的旧版 NeoForge 使用相同名称，并保留实际安装版本", () => {
    for (const version of ["47.1.105", "1.20.1-47.1.105"]) {
      const loader: Loader = {
        kind: "NeoForge",
        version,
        metadata: { rawVersion: "1.20.1-forge-47.1.105" },
      };
      const selection = { ...emptyInstallSelection, loader };
      expect(installVersionName("1.20.1", selection)).toBe(
        "1.20.1-neoforge-47.1.105",
      );
      expect(installSelectionPayload(selection).loader?.version).toBe(version);
    }
  });

  it("保留新版 NeoForge 完整的加载器版本号", () => {
    expect(
      installVersionName("26.3", {
        ...emptyInstallSelection,
        loader: { kind: "NeoForge", version: "26.3.0.100", metadata: {} },
      }),
    ).toBe("26.3-neoforge-26.3.0.100");
  });

  it("Fabric 与 Quilt 省略 loader，空选择恢复原版名称", () => {
    for (const kind of ["Fabric", "Quilt"]) {
      expect(
        installVersionName("1.20.1", {
          ...emptyInstallSelection,
          loader: { kind, version: "0.27.0", metadata: {} },
        }),
      ).toBe(`1.20.1-${kind.toLowerCase()}-0.27.0`);
    }
    expect(installVersionName("1.20.1", emptyInstallSelection)).toBe("1.20.1");
  });
});
