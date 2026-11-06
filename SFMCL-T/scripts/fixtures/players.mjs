// Extends pixelAppFixture with account operations. No real credentials or files.
export function playersFixture() {
  const fixture = window.__pixelTest;
  fixture.data.players = [
    { uuid: "steve", name: "Steve", online: false, skin: "", slim: false },
    { uuid: "alex", name: "Alex", online: true, skin: "", slim: true },
    {
      uuid: "builder",
      name: "Builder_07",
      online: false,
      skin: "",
      slim: false,
    },
  ];
  fixture.data.settings.activePlayer = "steve";
  fixture.tasks.jobs = [];
  fixture.confirm = true;
  fixture.pick = "C:/Test/skin.png";
  fixture.image = "/assets/steve.png";
  fixture.capes = [
    {
      id: "migrator-cape",
      name: "Migrator",
      url: "https://textures.minecraft.net/texture/cd",
      active: false,
    },
  ];
  fixture.data.players[1].capes = structuredClone(fixture.capes);
  fixture.nameChange = {
    nameChangeAllowed: true,
    changedAt: null,
    createdAt: "2015-01-01T00:00:00Z",
  };
  let serial = 0;
  const original = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command.startsWith("plugin:dialog|")) {
      fixture.requests.push({ operation: command, payload: args });
      return command.endsWith("open")
        ? fixture.pick
        : fixture.confirm
          ? "确认"
          : "取消";
    }
    if (command === "plugin:opener|open_url") {
      fixture.requests.push({ operation: command, payload: args });
      if (fixture.failures[command]) throw new Error(fixture.failures[command]);
      return;
    }
    if (
      command !== "request" ||
      !/^(players\.|image$|jobs.cancel$)/.test(args.operation)
    )
      return original(command, args);
    const { operation, payload = {} } = args;
    fixture.requests.push({ operation, payload: structuredClone(payload) });
    if (fixture.delays[operation])
      await new Promise((resolve) =>
        setTimeout(resolve, fixture.delays[operation]),
      );
    if (fixture.failures[operation])
      throw new Error(fixture.failures[operation]);
    const player = fixture.data.players.find((p) => p.uuid === payload.id);
    switch (operation) {
      case "image":
      case "players.skin.preview":
        if (fixture.imageDelays?.[payload.path])
          await new Promise((resolve) =>
            setTimeout(resolve, fixture.imageDelays[payload.path]),
          );
        if (fixture.imageFailures?.[payload.path])
          throw new Error(fixture.imageFailures[payload.path]);
        return fixture.images?.[payload.path] ?? fixture.image;
      case "players.select":
        fixture.data.settings.activePlayer = player.uuid;
        break;
      case "players.list":
        return structuredClone(fixture.data.players);
      case "players.reorder": {
        const ranks = new Map(payload.ids.map((id, index) => [id, index]));
        if (ranks.size !== payload.ids.length)
          throw new Error("重复的角色排序");
        fixture.data.players.sort(
          (a, b) =>
            (ranks.get(a.uuid) ?? payload.ids.length) -
            (ranks.get(b.uuid) ?? payload.ids.length),
        );
        return structuredClone(fixture.data.players);
      }
      case "players.skin":
        player.skin = payload.path || "";
        player.slim = payload.slim;
        break;
      case "players.refresh":
        break;
      case "players.capes":
        if (payload.refresh || player.capes == null)
          player.capes = structuredClone(fixture.capes);
        return structuredClone(player.capes);
      case "players.cape": {
        for (const cape of fixture.capes)
          cape.active = cape.id === payload.capeId;
        player.cape = fixture.capes.find((cape) => cape.active)?.url || "";
        player.capes = structuredClone(fixture.capes);
        break;
      }
      case "players.namechange":
        return structuredClone(fixture.nameChange);
      case "players.rename": {
        const active = fixture.data.settings.activePlayer === player.uuid;
        player.name = payload.name;
        if (!player.online) player.uuid = `renamed-${++serial}`;
        if (active) fixture.data.settings.activePlayer = player.uuid;
        break;
      }
      case "players.add": {
        const uuid = `offline-${++serial}`;
        fixture.data.players.push({
          uuid,
          name: payload.name,
          online: false,
          skin: "",
          slim: false,
        });
        fixture.data.settings.activePlayer = uuid;
        return structuredClone(fixture.data.players.at(-1));
      }
      case "players.remove":
        fixture.data.players = fixture.data.players.filter(
          (p) => p.uuid !== payload.id,
        );
        if (fixture.data.settings.activePlayer === payload.id)
          fixture.data.settings.activePlayer =
            fixture.data.players[0]?.uuid || "";
        break;
      case "players.login": {
        const jobId = `login-${++serial}`;
        fixture.tasks.jobs.push({
          id: jobId,
          title: "登录 Microsoft",
          status: "running",
          currentStep: 0,
          steps: [
            "等待浏览器授权",
            "验证 Xbox Live",
            "验证 Minecraft 账号",
            "保存角色",
          ].map((name, index) => ({
            name,
            status: index === 0 ? "running" : "queued",
            detail: "",
          })),
          log: [],
        });
        return {
          jobId,
          userCode: "TEST-CODE",
          verificationUri: "https://www.microsoft.com/link",
          expiresIn: fixture.loginExpiresIn ?? 900,
        };
      }
      case "jobs.cancel":
        fixture.tasks.jobs.find((j) => j.id === payload.id).status =
          "cancelled";
        break;
      default:
        throw new Error(`Unexpected player operation: ${operation}`);
    }
    return structuredClone(player || null);
  };
}
