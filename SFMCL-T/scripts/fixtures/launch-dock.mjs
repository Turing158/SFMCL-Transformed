// Extends pixelAppFixture inside an isolated browser, never a real desktop.
export function launchDockFixture() {
  const test = window.__pixelTest;
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const scenario = new URL(location.href).searchParams.get("dock-test");
  const names = [
    "检查游戏与 Java",
    "检查资源索引",
    "补全游戏文件",
    "准备运行环境",
    "游戏运行",
  ];
  let serial = 0;
  test.failures = {};
  test.holdLaunch = false;
  if (scenario === "jobs-only") {
    test.data.settings.downloadTaskDisplay = "active";
    test.tasks.downloads = [];
    test.tasks.jobs = [];
  }
  if (scenario === "empty") test.data.settings.activeVersion = "";
  if (scenario === "no-player") test.data.settings.activePlayer = "";
  if (scenario === "no-dir") {
    test.data.settings.activeDir = "";
    test.data.settings.activeVersion = "";
    test.data.settings.gameDirs = [];
  }
  test.advanceLaunch = (index) => {
    const job = test.latestLaunch;
    job.currentStep = index;
    job.status = "running";
    job.steps = names.map((name, i) => ({
      name,
      status: i < index ? "completed" : i === index ? "running" : "queued",
      detail: i === index ? name : "",
    }));
    delete job.downloadId;
    delete job.error;
  };
  test.publishLaunch = () => {
    test.tasks.jobs.unshift(test.latestLaunch);
    test.holdLaunch = false;
  };
  test.downloadState = (status) => {
    test.advanceLaunch(2);
    const job = test.latestLaunch;
    const id = `files-${job.id}`;
    job.status = status;
    job.downloadId = id;
    job.steps[2].status = status;
    test.tasks.downloads = test.tasks.downloads.filter(
      (item) => item.id !== id,
    );
    test.tasks.downloads.unshift({
      id,
      title: `${test.data.settings.activeVersion} · 启动检查`,
      status,
      downloaded: 50,
      total: 100,
      unknownSize: false,
      completed: 5,
      failed: status === "failed" ? 1 : 0,
      fileCount: 10,
      speed: 0,
      workers: 1,
      steps: [],
      error: status === "failed" ? "资源服务器连接中断" : undefined,
    });
  };
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command !== "request") return invoke(command, args);
    const { operation, payload = {} } = args;
    const own =
      operation === "launch" ||
      operation === "jobs.cancel" ||
      operation === "downloads.control";
    if (!own && !test.failures[operation]) {
      const result = await invoke(command, args);
      if (operation === "versions.list") {
        test.versions = result;
        if (scenario === "invalid") result[0].error = "版本 JSON 无法解析";
        if (scenario === "many" && result.length === 2) {
          for (let index = 1; index <= 24; index++) {
            result.push({
              ...result[1],
              id: `我的长期生存世界与大型模组整合包-${index}`,
              path: `C:/Pixel-Test/Minecraft/.minecraft/versions/modpack-${index}`,
            });
          }
        }
      }
      return result;
    }
    test.requests.push({ operation, payload: structuredClone(payload) });
    if (test.delays[operation])
      await new Promise((resolve) =>
        setTimeout(resolve, test.delays[operation]),
      );
    if (test.failures[operation]) throw new Error(test.failures[operation]);
    if (operation === "launch") {
      test.latestLaunch = {
        id: `launch-${++serial}`,
        title: `启动 ${test.data.settings.activeVersion}`,
        status: "running",
        currentStep: 0,
        steps: [],
        log: [],
      };
      test.advanceLaunch(0);
      if (!test.holdLaunch) test.tasks.jobs.unshift(test.latestLaunch);
      return test.latestLaunch.id;
    }
    if (operation === "jobs.cancel") {
      const job = test.tasks.jobs.find((item) => item.id === payload.id);
      job.status = "cancelled";
      job.steps[job.currentStep].status = "cancelled";
      const file = test.tasks.downloads.find(
        (item) => item.id === job.downloadId,
      );
      if (file) file.status = "cancelled";
      return true;
    }
    if (operation === "downloads.control") {
      const file = test.tasks.downloads.find((item) => item.id === payload.id);
      if (file) {
        file.status = payload.action === "resume" ? "running" : "paused";
        file.error = undefined;
      }
      const job = test.tasks.jobs.find(
        (item) => item.downloadId === payload.id,
      );
      if (job) {
        job.status = file.status;
        job.steps[job.currentStep].status = file.status;
      }
      return true;
    }
  };
}
