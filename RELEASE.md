# SFMCL-T v0.1.0

发布日期：2026-11-03

SFMCL-T（StarFall Minecraft Launcher-Transformed）是基于 Rust、Tauri 2 和 React 的 Minecraft Java 版启动器。本版本提供 Windows x64 与 x86 的安装版和单文件版，延续原启动器的角色、版本、资源、下载和游戏启动流程。

## 本次发布

- 使用 Minecraft 像素风界面，支持浅色、深色和跟随系统主题，以及森林绿、Puce、Ebony 三种配色。
- 支持创建离线角色和 Microsoft 设备授权登录，可管理皮肤、模型、官方披风与 Java 版游戏名。
- 支持 Minecraft 原版、Forge、NeoForge、Fabric、Quilt、OptiFine 和 LiteLoader 的安装与启动，并支持兼容的 Forge + OptiFine、Fabric API 组合。
- 支持从 Modrinth、CurseForge 搜索和安装整合包，也支持导入 MRPACK、ZIP、7Z、RAR、TAR、TAR.GZ 和完整客户端目录。
- 提供模组、材质包、光影和数据包的搜索、筛选、详情、依赖提示与下载；本地模组可启用或禁用，世界存档可查看种子和规则等信息。
- 下载任务支持进度、日志、暂停、继续、重试、断点续传、备用地址切换以及大小和哈希校验。
- 支持扫描或手动添加 Java，配置内存、游戏目录隔离、窗口和启动参数，并为单个版本覆盖全局设置。
- 首页公告支持 Markdown、图片、链接、刷新、隐藏和自定义；主页面切换会保留搜索、草稿和滚动位置。
- 保留旧版 `.tmcl/`、`tmcl-downloads/`、下载断点、整合包元数据和兼容环境变量，便于迁移已有数据。

## 下载

发布文件位于 [`release/`](release/) 目录。文件名中的 `x64` 和 `x86` 表示目标架构。

| 类型 | x64 | x86 | 说明 |
| --- | --- | --- | --- |
| 安装版 | [`SFMCL-T_v0.1.0_x64_installer.exe`](release/SFMCL-T_v0.1.0_x64_installer.exe) | [`SFMCL-T_v0.1.0_x86_installer.exe`](release/SFMCL-T_v0.1.0_x86_installer.exe) | NSIS 安装程序；启动时检测 WebView2，缺少时可联网下载安装。 |
| 单文件版 | [`SFMCL-T_v0.1.0_x64.exe`](release/SFMCL-T_v0.1.0_x64.exe) | [`SFMCL-T_v0.1.0_x86.exe`](release/SFMCL-T_v0.1.0_x86.exe) | 直接运行的单文件程序；需要系统已安装 WebView2 Runtime。 |

## 文件校验

以下为 SHA-256 校验值：

| 文件 | 大小 | SHA-256 |
| --- | ---: | --- |
| `SFMCL-T_v0.1.0_x64_installer.exe` | 2.96 MiB | `26C0CBFAC8A5EA59F5C9494808BBA6F839D61D4299DD409D955F7873FDE27688` |
| `SFMCL-T_v0.1.0_x64.exe` | 2.81 MiB | `B9C0AFF0F0C8823A36CBB8DF432EBDDC9639112DF0BE876FCBDB93719516D264` |
| `SFMCL-T_v0.1.0_x86_installer.exe` | 2.76 MiB | `145160A7E46034288BC7F90A2D1AFEFE40094692F259F818971AADB138149843` |
| `SFMCL-T_v0.1.0_x86.exe` | 2.41 MiB | `0D618ADF4BCEBDE620F0831041E9AF1680FD3D155BAE011D304A345E1D8B76E1` |

PowerShell 校验命令：

```powershell
Get-FileHash .\release\SFMCL-T_v0.1.0_x64_installer.exe -Algorithm SHA256
```

## 运行要求

- Windows 10 或 Windows 11。
- x64 版适用于 64 位 Windows；x86 版适用于 32 位 Windows，也可在 64 位 Windows 上运行。
- Minecraft 运行所需的 Java 需要单独安装。启动器会根据游戏版本元数据匹配 Java；例如 Minecraft 1.12.2 通常使用 Java 8，1.20.1 通常使用 Java 17，较新的版本可能需要 Java 21。
- 安装版会检测 WebView2 Runtime；单文件版需要系统已有 WebView2 Runtime。
- CurseForge 访问需要可用的渠道凭据。发布程序不附带开发者本机的 API Key。

## 已验证范围

- `cargo fmt --all -- --check`、`cargo test --workspace --locked`。
- `npm test`、`npm run build` 及像素几何检查。
- Windows x64 / x86 的安装包与单文件包已生成，文件版本均为 `0.1.0`。
- 已对 Minecraft 1.20.1 的原版、Fabric、Quilt、Forge、NeoForge、OptiFine、Forge + OptiFine 和 Fabric API 组合，以及 Minecraft 1.12.2 的 LiteLoader 进行安装或启动样本验证。
- 已验证下载暂停、继续、断点续传、重试、哈希校验、资源下载、整合包导入和主要界面流程。

验证样本不能代表所有 Minecraft 历史版本、加载器组合或第三方模组。Microsoft 真人授权、令牌刷新、正版启动和长期运行资源趋势仍需在目标环境中继续验收。

## 构建发布包

在仓库根目录运行：

```powershell
.\build.ps1                            # x64 和 x86，各生成安装版与单文件版
.\build.ps1 -Architecture x64          # 仅生成 x64
.\build.ps1 -Architecture x86          # 仅生成 x86
.\build.ps1 -Check                     # 只检查打包环境
```

构建产物写入 `release/`。完整的开发、配置迁移和验证说明见 [`README.md`](README.md)。

## 许可

项目采用 [MIT License](LICENSE)。RAR 解压使用 UnRAR，其使用与分发条款见 [`UNRAR-LICENSE.txt`](UNRAR-LICENSE.txt)；Pixelify Sans 字体许可见 [`SFMCL-T/public/assets/players/PixelifySans-OFL.txt`](SFMCL-T/public/assets/players/PixelifySans-OFL.txt)。
