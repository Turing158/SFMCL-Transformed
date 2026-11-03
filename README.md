<div align="center">

<img src="docs/assets/sfmcl-t.png" alt="SFMCL-T" width="96" height="96" />

# SFMCL-T

**用像素风界面管理 Minecraft，准备好下一次冒险。**

StarFall Minecraft Launcher-Transformed · 基于 Rust、Tauri 2 和 React 的 Minecraft Java 版启动器

<p>
  <img src="https://img.shields.io/badge/平台-Windows%20x64%20%2F%20x86-0078D4?style=flat-square" alt="Windows x64 / x86" />
  <img src="https://img.shields.io/badge/版本-0.1.0-4C8BF5?style=flat-square" alt="版本 0.1.0" />
  <img src="https://img.shields.io/badge/核心-Rust-DEA584?style=flat-square" alt="Rust 核心" />
  <img src="https://img.shields.io/badge/界面-Tauri%202%20%2B%20React-24C8D8?style=flat-square" alt="Tauri 2 + React" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/许可-MIT-2EA043?style=flat-square" alt="MIT License" /></a>
</p>

[快速上手](#快速上手) · [从源码运行](#从源码运行) · [构建发布包](#构建发布包) · [问题反馈](https://github.com/Turing158/SFMCL-Transformed/issues)

</div>

---

## 这是什么？

SFMCL-T 是 [StarFall Minecraft Launcher](https://github.com/Turing158/StarFall-Minecraft-Launcher) 的 Rust / Tauri 重写版本。它延续了原项目的角色、版本、资源和下载工作流程，将游戏安装、加载器选择、整合包导入与启动设置放在同一个桌面应用中。

界面采用 Minecraft 像素风控件，支持浅色、深色和跟随系统主题，以及森林绿、Puce、Ebony 三种配色。游戏文件保存在你选择的本地目录中，启动器配置与账号凭据单独保存。

## 它能帮你做什么

| | 能力 | 说明 |
| :---: | --- | --- |
| 👤 | **管理角色** | 创建离线角色，或通过 Microsoft 设备授权添加正版账号；支持皮肤上传与重置、已有官方披风切换、游戏名修改、角色切换与皮肤预览。 |
| 🎮 | **安装与启动游戏** | 管理多个游戏目录，搜索、选择和收藏版本，从首页底部启动区启动或结束游戏。 |
| 🧩 | **安装加载器** | 支持 Forge、NeoForge、Fabric、Quilt、OptiFine 和 LiteLoader；可选择兼容的 Forge + OptiFine 组合，或为 Fabric 附带 Fabric API。 |
| 📦 | **导入整合包** | 从 Modrinth / CurseForge 安装整合包，或导入本地压缩包与完整客户端目录；支持拖入窗口安装。 |
| 🔎 | **查找社区资源** | 搜索、筛选和下载模组、材质包、光影与数据包，查看项目详情、文件版本和前置依赖。 |
| 🗂️ | **管理本地资源** | 启用或禁用模组，查看材质包与存档信息，包括种子、游戏规则、游戏模式和天气。 |
| ⬇️ | **管理下载** | 查看下载进度与日志，暂停、继续或重试文件下载；按来源提供的大小与哈希校验文件。 |
| ☕ | **配置游戏环境** | 扫描或手动添加 Java，设置内存、游戏目录隔离、窗口与启动参数，按版本覆盖全局设置。 |
| 🎨 | **调整界面** | 切换主题与背景，配置 Markdown 公告；切换主页面时保留搜索、草稿和滚动位置。 |

## 快速上手

**1. 启动应用**

使用已构建的 Windows x64 / x86 程序。x64 版适用于 Windows 10 / 11 64 位系统；x86 版适用于 Windows 10 32 位系统，也可在 64 位 Windows 上运行：

| 形式 | 启动方式 | WebView2 环境 |
| --- | --- | --- |
| 安装版 | 运行安装程序，再打开 SFMCL-T。 | 缺少环境时，安装器可联网下载并安装。 |
| 单文件版 | 直接运行 `SFMCL-T_v<版本>_<架构>.exe`。 | 需要系统已安装 WebView2 Runtime。 |

从源码启动或生成这些文件，见下文的[开发](#给开发者)与[打包](#构建发布包)说明。Minecraft 需要的 Java 需另行准备。

**2. 添加角色与游戏版本**

在「角色管理」创建离线角色，或选择 Microsoft 登录并在浏览器中完成设备授权。随后在「版本管理」添加游戏所在的外层文件夹，安装 Minecraft 与需要的加载器。

选中正版角色后，可在启动器内上传 PNG 皮肤并选择经典或纤细模型、恢复默认皮肤、切换账号已有的官方披风，或修改 Java 版游戏名。改名前会检查资格和名称是否可用；通常每 30 天可修改一次，正版 UUID 保持不变。操作成功后会同步角色资料和预览，登录凭据过期时会自动尝试刷新。

启动器会使用所选文件夹内的 `.minecraft/`；直接选择已有的 `.minecraft` 目录也能识别。

**3. 配置 Java，开始游戏**

在「设置 → 全局设置」扫描 Java，或手动选择 `java.exe` / `javaw.exe`。在「角色管理」选好角色并调整游戏设置后，回到首页，在底部选择版本，点击「开始游戏」。启动器设置、全局设置和版本独立设置的修改都会自动保存，无需手动保存或撤销。

| 游戏示例 | 常用 Java 版本 |
| --- | --- |
| Minecraft 1.12.2 / LiteLoader | Java 8 |
| Minecraft 1.20.1 | Java 17 |
| 较新的 Minecraft 版本 | 根据游戏版本元数据选择，通常需要 Java 21 等环境。 |

启动器会探测 Java 的实际版本与架构，并在自动选择时结合游戏要求匹配环境。

## 版本与游戏设置

版本管理支持卡片和列表两种布局，可搜索版本、切换游戏目录、收藏常用版本，并进入本地资源或游戏设置。更多操作中可重命名版本、打开版本或 native 目录、更换图标、补全资源和删除版本。

在「版本管理 → 游戏设置」中，以下四组配置可以分别选择「全局」或「独立」：

- Java；
- 内存与游戏目录；
- 游戏窗口；
- 高级启动参数。

切到「独立」后，该组使用当前版本自己的配置；切回「全局」后会跟随全局设置，原独立值仍保留，再次开启即可恢复。版本设置保存在对应目录的 `.tmcl/settings.json`，不同游戏目录下的同名版本互不影响。

Java 扫描会检查 Windows 注册表、`JAVA_HOME`、`PATH`、常见安装目录和手动添加的路径。扫描与手动添加后的 Java 列表立即保存；删除列表记录只移除启动器中的记录，删除已选项会恢复自动选择。

Forge 与 OptiFine 联装时，OptiFine JAR 放入对应游戏目录的 `mods/`；独立安装 OptiFine 时才执行其补丁程序。

「设置 → 启动器设置 → 下载 → 下载源策略」可选择「速度优先（推荐）」「官网优先」或「镜像优先」，修改后自动保存。速度优先会自动测速，在官网和镜像中选择当前较快的可用源；官网优先会先尝试官方源。Minecraft 本体、加载器和社区资源均使用所选策略，失败或校验不通过时切换备用源。已加入 BMCLAPI、Forge 官方仓库、NeoForge 官方仓库与 CDN、Fabric 镜像、MC Mirror、MCIM 和腾讯 Maven 镜像；文件哈希校验保持不变，详见 [下载源说明](docs/download-sources.md)。

## 整合包与社区资源

### 安装整合包

在「资源中心 → 整合包」搜索 Modrinth 或 CurseForge 项目，选择文件后可「安装新实例」或「下载到文件夹」。

本地整合包可通过版本管理中的「导入整合包」选择，也可将单个压缩包或客户端目录拖入桌面窗口。识别成功后会打开已填好包信息的安装设置。

| 项目 | 支持范围 |
| --- | --- |
| 压缩格式 | MRPACK、ZIP、7Z、RAR、TAR、TAR.GZ |
| 整合包格式 | Modrinth、CurseForge、MCBBS、MultiMC / Prism，以及完整客户端目录 |
| 安装流程 | 识别清单、安装 Minecraft 与加载器、校验下载文件、合并覆盖文件 |
| 游戏目录 | 整合包默认使用独立游戏目录。 |
| 可选文件 | 默认跳过，可在安装设置中选择。 |

整合包安装失败或取消后会清理临时实例。安装过程中的文件下载可暂停、继续或重试；退出启动器后，需要重新发起整合包安装。

服务端包、加密或多卷压缩包、冲突清单、多个可启动实例及 MultiMC 自定义补丁会提示具体原因。RAR 单个文件限制 512 MiB，其他格式单个文件限制 4 GiB，总解压大小限制 20 GiB。

### 下载与管理资源

资源中心提供模组、材质包、光影和数据包的搜索、分类、版本筛选、详情与下载。安装资源时，请根据详情中的前置依赖提示准备所需组件。

数据包下载到所选文件夹后，需放入目标世界存档的 `datapacks/` 目录。

CurseForge 文件缺少直链时，桌面应用会在开始下载后尝试解析官网的下载跳转，再交给下载队列。整合包中的文件需要手动下载时，可从官网下载指定版本，在下载中心的文件详情中「补选已下载文件」，通过大小与哈希校验后继续安装。

CurseForge 访问需要后端渠道凭据。发布程序不附带开发者的本机密钥，凭据配置见[渠道凭据](#渠道凭据)。

## 下载、外观与公告

下载中心可查看任务、文件进度和日志。侧栏任务摘要默认关闭，可在「设置 → 启动器设置 → 下载 → 侧栏下载任务」选择「下载时」「始终」或「关闭」；点击摘要可进入下载中心。关闭应用时会先暂停并保存下载任务。

设置中还可调整下载并发数与缓存文件夹。缓存路径修改后会自动保存并用于新任务，已有任务继续使用原目录；文件下载完成后自动清理对应缓存。

外观设置支持主题、配色、纯色背景、本地图片和网络图片。默认背景模式读取配置目录中的 `bg.png` / `bg.jpg`，也支持 `bg.jpeg`。

「设置 → 启动器设置 → 角色管理 · 皮肤预览」可选择默认预览方式（正面、背面或 3D）、3D 预览帧数（1–144，默认 30）、3D 预览背景（当前场景、纯色、本地图片或网络图片）和 3D 默认动作。背景图加载失败时回退到当前场景；纯色与自定义背景只影响 3D 预览，2D 画面继续使用林间营地或方块展台。

首页默认展示最近 3 条 Minecraft 官方新闻、1 条最新 Java 版更新和 1 条中文 Minecraft Wiki 版本介绍，并标明来源与日期。中文 Wiki 介绍通过版本清单跟随最新 Java 版本（含快照），展开后可阅读中文摘要并打开完整条目；官方新闻与更新日志保留英文。启动时先读取 `cache/official-notices.json`，页面显示后再联网更新，每小时自动检查一次；点击刷新可立即重新获取。各来源独立缓存，网络失败时保留已有内容，首次离线时显示欢迎公告。

首页公告默认逐条收起，点击标题或按 Enter / 空格展开。官方新闻、Java 更新、中文 Wiki 介绍等预设公告可在右侧隐藏，隐藏后才出现在右上角「新增公告 → 预设」中，可重新添加到首页。隐藏状态保存到配置目录的 `HiddenNotices.json`，刷新和重启后继续生效；新发布的公告会正常显示。

「设置 → 启动器设置 → 开始游戏界面」可开启干净模式（默认关闭），只保留开始游戏页顶部的问候区域，隐藏公告及新增、刷新按钮。公告布局默认「双列瀑布布局」，也可选择「一行一个折叠面板」或「双列平行布局」；平行布局按行对齐，瀑布布局根据卡片高度紧凑排列，窄窗口自动回到单列。设置自动保存，干净模式关闭后恢复所选布局。

点击刷新按钮旁的「新增公告」，可填写标题和 Markdown 正文。自定义公告只提供删除操作，删除后不会出现在预设列表；公告保存在配置目录的 `Notices.json`，显示在官方内容之前。也可手动创建该文件：

```json
[
  {
    "title": "欢迎回来",
    "content": "**准备好下一次冒险。**"
  },
  {
    "title": "整合包说明",
    "source": "modpack-notes.md"
  }
]
```

公告支持 Markdown、图片与链接；`source` 可引用 Markdown 文件。修改后可从首页或设置中刷新。

## 数据存储

在「设置 → 启动器设置 → 本地数据」点击「打开配置目录」，即可定位当前应用数据。全新安装的默认目录为：

```text
%AppData%/com.sfmcl-t.minecraft-launcher/
├── settings.json      # 全局设置与当前角色、版本选择
├── players.json       # 角色列表
├── credentials.dat    # Windows DPAPI 保护的账号凭据
├── skins/             # 本地角色皮肤
├── downloads/         # 下载任务记录
│   └── cache/         # 默认下载缓存
├── webview/           # WebView 用户数据
├── Notices.json       # 可自行创建的公告配置
├── HiddenNotices.json # 首页逐条公告的隐藏状态
└── bg.png / bg.jpg    # 可自行放入的默认背景
```

游戏文件保存在所选游戏文件夹中：

```text
<所选游戏文件夹>/
└── .minecraft/
    ├── assets/
    ├── libraries/
    └── versions/
        └── <版本名>/
            ├── <版本名>.json
            ├── <版本名>.jar
            └── .tmcl/settings.json
```

开启游戏目录隔离后，模组、存档等使用对应的 `versions/<版本名>/` 目录。备份时应一并保留应用配置与游戏目录；账号凭据由当前 Windows 用户保护，跨用户复制可能无法读取。

可通过 `SFMCL_T_DATA_DIR` 指定独立配置目录。若新配置目录尚不存在、旧版 `com.tmcl.minecraft-launcher` 目录已经存在，启动器会沿用旧目录。原有 `.tmcl/`、`tmcl-downloads/` 和下载断点格式继续兼容。

## 给开发者

当前源码位于 `SFMCL-T/`，桌面开发与打包入口位于仓库根目录。下文的 `npm`、`cargo` 命令在 `SFMCL-T/` 内执行，`dev.ps1` 与 `build.ps1` 在根目录执行：

```text
SFMCL-Transformed/
├── README.md
├── dev.ps1                    # 开发入口
├── build.ps1                  # 打包入口
├── SFMCL-T/
│   ├── src/                  # React / TypeScript 界面
│   ├── public/               # 静态资源
│   ├── crates/launcher-core/  # Rust 核心：账号、安装、启动、资源与下载
│   ├── src-tauri/            # Tauri 桌面应用与 IPC 接口
│   ├── scripts/              # 构建辅助与验证脚本
│   └── tests/fixtures/        # 测试数据
├── .runtime/                 # 本地开发数据、工具缓存与验证产物
└── release/                  # Windows 发布文件
```

### 开发环境

- Windows 10 / 11 x64；
- [Node.js](https://nodejs.org/) 20.19+ 或 22.12+；
- [Rust](https://rustup.rs/) 1.90+ MSVC 工具链（当前锁定的依赖要求），x64 打包需要 `x86_64-pc-windows-msvc` 目标，x86 打包需要 `i686-pc-windows-msvc` 目标；
- Windows PowerShell 5.1 或更高版本；
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) 的「使用 C++ 的桌面开发」工作负载及 Windows 10 / 11 SDK；
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)：桌面开发时需要，构建发布包时无需预先安装系统环境。

### 从源码运行

克隆仓库后，在仓库根目录启动：

```powershell
git clone https://github.com/Turing158/SFMCL-Transformed.git
cd SFMCL-Transformed
.\dev.cmd
```

开发入口会检查环境、按需执行 `npm ci`，再启动 Tauri 与 Vite。其他常用选项：

```powershell
.\dev.cmd -Check                       # 只检查开发环境
.\dev.cmd -Web                         # 仅预览浏览器界面
.\dev.cmd -Port 1430                   # 使用其他开发端口
.\dev.cmd -DataDir D:\SFMCLTDevData      # 指定开发配置目录
.\dev.cmd -InstallDependencies         # 重新执行 npm ci
```

脚本兼容 Windows PowerShell 5.1，可从任意工作目录调用。`npm run desktop` 使用同一入口；`npm run dev` 提供浏览器预览，文件操作、安装和游戏启动需要 Tauri 桌面环境。

开发实例默认使用根目录的 `.runtime/dev-data/`。已有的 `SFMCL_T_DATA_DIR` 会保留，也可用 `-DataDir` 覆盖；相对路径以仓库根目录为基准。

### 渠道凭据

Microsoft Client ID 的默认值可通过 `SFMCL_T_MICROSOFT_CLIENT_ID` 设置。

CurseForge API Key 由 Rust 后端读取。开发环境可通过 `SFMCL_T_CURSEFORGE_API_KEY` 提供，或从本机的旧版 StarFallMCL 项目导入：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File SFMCL-T/scripts/import-curseforge-credential.ps1 -StarFallRoot D:\Projects\StarFall-Minecraft-Launcher
```

导入脚本验证凭据后，以 Windows DPAPI 密文保存到 `%LOCALAPPDATA%/SFMCL-T/service-credentials/curseforge.dat`，供当前用户的开发版和安装版共用。

配置目录、Microsoft Client ID 与 CurseForge Key 均兼容旧版 `TMCL_` 环境变量；非空的 `SFMCL_T_` 值优先。渠道凭据也兼容旧版目录。

凭据不写入源码、前端包或发布程序，相关本地文件已由 `.gitignore` 排除。面向公众提供统一渠道时，可将服务密钥保存在服务端并代理请求；客户端 DPAPI 用于本机保护，无法阻止当前 Windows 用户或管理员主动提取凭据。

### 构建发布包

以下命令在仓库根目录执行，产物写入 `release/`。默认生成 x64 和 x86 两种架构的安装版、单文件版，共四个文件：

```powershell
.\build.ps1                            # 两个架构，各生成安装版和单文件版
.\build.ps1 -Architecture x86          # 仅生成 x86 的两种包
.\build.ps1 -Architecture x64          # 仅生成 x64 的两种包
.\build.ps1 installer -Architecture x86 # x86 安装版
.\build.ps1 single -Architecture x86    # x86 单文件 EXE
.\build.ps1 single -NoExeCompression    # 跳过 UPX 压缩
.\build.ps1 -Check                     # 只检查打包环境
```

| 模式 | 输出文件 | 说明 |
| --- | --- | --- |
| `installer` | `SFMCL-T_v<版本>_<架构>_installer.exe` | NSIS 安装包；检测系统 WebView2，缺少时可下载安装。 |
| `single` | `SFMCL-T_v<版本>_<架构>.exe` | 前端嵌入 EXE，使用系统 WebView2；默认通过 UPX 压缩。 |

版本号前统一带 `v`，单文件版省略类型后缀，例如 `SFMCL-T_v0.1.0_x86.exe`。`<架构>` 为 `x64` 或 `x86`。可通过 `rustup target add x86_64-pc-windows-msvc i686-pc-windows-msvc` 准备两个 Rust 目标，Windows SDK 也需包含对应架构的库。

也可调用 `build.ps1 -Mode <模式> -Architecture <架构>`，或在 `SFMCL-T/` 内运行 `npm run package`、`npm run package:x86`、`npm run package:x64`。`npm run package:installer -- -Architecture x86` 和 `npm run package:single -- -Architecture x86` 可分别生成 x86 安装版和单文件版。

打包工具缓存位于 `.runtime/packaging/`；UPX 会按需下载并校验，后续可复用缓存。Tauri 会准备 NSIS 安装工具。Java 由使用者另行安装。

为兼容 x86，当前使用带有 C 调用约定修正的本地 `unrar_sys` 依赖，说明与许可见 [UnRAR 兼容补丁](SFMCL-T/vendor/unrar-sys/PATCHES.md)。

### 验证

以下命令在 `SFMCL-T/` 内执行：

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm test
npm run build
```

前端单元测试通过 `npm test` 运行；像素几何检查包含在 `npm run build` 中，也可单独运行 `npm run check:corners`。

x86 工作区测试可运行 `cargo test --workspace --target i686-pc-windows-msvc --locked`。构建安装包后，`npm run test:packaging` 验证两个架构的环境检测及注册表视图，也可加 `-- -Architecture x86` 或 `-- -Architecture x64` 选择架构。

界面验证脚本通常使用 `http://127.0.0.1:4180` 的生产预览，可通过 `SFMCL_T_UI_URL` 修改地址。先在一个终端启动预览，再在另一个终端执行检查：

```powershell
# 终端一：已执行 npm run build
npm run preview -- --port 4180

# 终端二
npm run test:notices
npm run test:versions
npm run test:resources
npm run test:modpacks
```

桌面验证脚本通过 CDP 连接测试实例，会创建测试角色、下载游戏或测试文件，请使用独立数据目录。验证产物统一写入根目录的 `.runtime/`。`npm run test:packaging` 需先构建安装包。

Microsoft 真人授权、令牌刷新与正版启动仍待完整实测；已验证的游戏与加载器样本也不代表所有历史组合均已覆盖。

## 许可与致谢

项目采用 [MIT License](LICENSE)。RAR 解压使用 UnRAR，其使用与分发条款见 [UNRAR-LICENSE.txt](UNRAR-LICENSE.txt)；随附 Pixelify Sans 字体的许可见 [OFL 声明](SFMCL-T/public/assets/players/PixelifySans-OFL.txt)。

感谢 [StarFall Minecraft Launcher](https://github.com/Turing158/StarFall-Minecraft-Launcher) 提供原有实现与资源参考，以及 [Modrinth](https://modrinth.com/) 和 [CurseForge](https://www.curseforge.com/minecraft) 提供社区资源服务。

---

<div align="center">

**选好角色与版本，开始你的下一次冒险。**

</div>
