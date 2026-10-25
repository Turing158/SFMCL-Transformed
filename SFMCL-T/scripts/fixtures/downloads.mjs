export function downloadsFixture() {
  const test = window.__pixelTest;
  const invoke = window.__TAURI_INTERNALS__.invoke;
  test.tasks.downloads[0].fileCount = 205;
  test.tasks.jobs[0].log = ["正在检查游戏文件", "资源下载任务已创建"];
  test.fileDelay = 0;
  test.fileFailure = false;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "plugin:dialog|message") return true;
    if (command === "request" && args.operation === "downloads.files") {
      const { id, offset = 0 } = args.payload;
      test.requests.push({
        operation: args.operation,
        payload: { id, offset },
      });
      const total =
        test.tasks.downloads.find((item) => item.id === id)?.fileCount || 0;
      const rows = Array.from(
        { length: Math.min(100, Math.max(0, total - offset)) },
        (_, i) => ({
          spec: {
            path: `libraries/minecraft/download-file-${offset + i + 1}.jar`,
            url: "https://example.invalid/file",
          },
          status: i % 3 ? "completed" : "running",
          downloaded: 2048,
          total: 4096,
          attempts: 1,
        }),
      );
      if (test.fileDelay)
        await new Promise((resolve) => setTimeout(resolve, test.fileDelay));
      if (test.fileFailure) throw new Error("测试：文件清单暂时不可用");
      return rows;
    }
    if (command === "request" && args.operation === "jobs.cancel") {
      test.tasks.jobs.find((item) => item.id === args.payload.id).status =
        "cancelled";
      return true;
    }
    return invoke(command, args);
  };
}
