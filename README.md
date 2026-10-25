# SFMCL-T · StarFall Minecraft Launcher-Transformed

SFMCL-T（StarFall Minecraft Launcher-Transformed）是基于 Rust 核心、Tauri 2 和 React 的 Minecraft 启动器，由旧版 C# / WPF 实现迁移而来，保留角色、版本、资源、下载和设置的主要工作流程。按钮、卡片、Tab、标签和表单统一采用 Minecraft 像素圆角，支持浅色/深色主题与三种配色。

## Windows 使用

运行下文的打包脚本后，Windows x64 发布文件位于 `release/`。启动器需要 Microsoft WebView2 Runtime：安装版可按检测结果下载，便携版附带独立环境，单文件版使用系统已安装的环境。

1. 在「角色管理」创建离线角色，或通过 Microsoft 浏览器设备授权添加正版账号。
2. 在「版本管理」选择游戏所在的外层文件夹，安装 Minecraft 和需要的加载器。启动器自动使用其中的 `.minecraft`，目录选择器只显示外层路径；直接选择已有的 `.minecraft` 也能识别。
3. 在「设置 → 全局设置」扫描或手动添加 Java。1.12.2 / LiteLoader 使用 Java 8，1.20.1 使用 Java 17，较新游戏根据版本元数据选择 Java 21 等运行环境。
4. 从首页底部固定区域选择版本并启动。版本列表支持就地搜索与键盘选择；启动进度、取消、下载续传和失败重试都保留在底部。运行后可结束游戏或进入下载中心查看日志。

整合包可在「资源中心 → 整合包」通过 Modrinth / CurseForge 搜索，选择「安装新实例」或「下载到文件夹」。版本管理的「导入整合包」支持本地 MRPACK、ZIP、7Z、RAR、TAR、TAR.GZ 及完整客户端目录。安装按清单识别 Modrinth、CurseForge、MCBBS、MultiMC / Prism 或客户端目录格式，自动安装 Minecraft 与加载器，校验下载文件，并按格式合并覆盖文件；整合包默认独立游戏目录。

也可将单个安装包或客户端目录拖入桌面应用的任意页面：界面完整显示导入占位，拖出窗口可取消；松开后检查包内清单与客户端文件，支持的整合包直接进入已填好包信息的安装设置，不支持的文件通过气泡提示原因。处理过程中忽略重复拖放；已有对话框打开时提示先关闭对话框。

可选文件默认跳过。CurseForge 文件无法自动下载时，可从官网获取指定版本，在下载中心的文件详情中「补选已下载文件」，通过大小和哈希校验后继续安装。服务端包、加密/多卷压缩包、冲突清单、多个可启动实例和 MultiMC 自定义补丁会提示具体原因。RAR 单个文件限制 512 MB，其他格式单个文件限制 4 GB，总解压限制 20 GB。整合包安装失败或取消后清理临时实例；安装期间的文件下载可暂停、继续或重试，退出后需重新发起整合包安装。

Windows 上的 Java 扫描参考 StarFallMCL：读取 HKLM / HKCU 的 32 位和 64 位注册表视图，枚举 JavaSoft 下 JRE / JDK 各版本的 `JavaHome`。手动添加的路径、`JAVA_HOME`、`PATH` 和常见安装目录也参与发现；同一可执行文件去重后探测实际版本与架构，失效安装自动跳过。设置页扫描和启动时自动选择共用这套逻辑。

扫描、手动添加后，Java 列表立即写入全局配置或当前版本的独立配置，无需点击「保存设置」，其他未保存的设置保持原状。手动添加仅接受 `java.exe` 或 `javaw.exe`。下拉框中每项右侧可删除记录，也可用方向键定位后按 Delete；删除已选项会恢复自动选择，不会删除磁盘上的 Java。再次打开设置只读取已保存列表，主动扫描可以重新发现此前删除的安装；删除列表记录不影响启动时的自动发现。

全局设置是各版本默认使用的游戏配置。在「版本管理 → 游戏设置」中，Java、内存与游戏目录、游戏窗口、高级启动参数四张卡片分别提供「全局 / 独立」开关，切到「独立」后可单独编辑该组并保存。切回「全局」后该组跟随最新全局设置，原独立值仍保留，再次开启可恢复。旧版独立配置自动按四组独立处理。独立配置存放在对应版本目录的 `.tmcl/settings.json`，重命名版本时随目录保留，不同游戏目录下的同名版本也互不影响。

版本管理支持直接点击卡片或列表项选择版本，右侧图标分别打开本地资源、游戏设置和更多操作。搜索框旁的单个图标按钮切换卡片与列表，记住显示偏好，并通过卡片宽高变化和内容移动衔接两种布局。目录选择器静止时只显示路径，悬停或展开时显示边框。游戏设置和本地资源通过标题栏返回箭头回到版本管理。

侧栏收藏版本支持紧凑的像素风右键菜单，仅显示「启动版本、切换版本、查看资源、版本设置、取消收藏、更多」六项。「更多」直接打开版本管理对话框，可重命名、打开版本／native 目录、更换／恢复图标、补全资源和删除版本，复用版本管理的操作与删除确认。菜单支持 Shift+F10、方向键和 Esc，自动避开窗口边缘并保留完整展开动画；不同目录下的同名版本分别操作，查看资源和设置不会切换当前启动版本。

顶部采用 40px「融合导航」标题栏：拖动空白区域移动窗口，双击最大化或还原；右侧提供最小化、最大化／还原和关闭按钮。面包屑按「父页面 / 子页面」显示页面层级：「开始游戏」「角色管理」「版本管理」「资源中心」「设置」等主页面各自独立，只显示自身名称；进入子页面后，例如「版本管理 / 1.21.4 · 游戏设置」，可点击父页面返回。切换主页面时同步更新路径，窄窗口保留父页面与当前子页面。版本设置存在未保存修改时，返回仍会提示确认。关闭时会先暂停并保存下载任务；触屏下顶栏增至 44px，浏览器预览中的窗口按钮不可用。

首页启动区桌面高 112px，窄窗口改为两行；正文独立滚动。其他页面保留原状态栏。主导航不显示下载中心；侧栏的下载任务区域默认关闭，可在「设置 → 启动器设置 → 下载 → 侧栏下载任务」选择「下载时、始终、关闭」。选择「下载时」后，仅在下载进行、排队或正在暂停时显示，任务结束后自动隐藏；点击任务摘要可进入下载中心。此设置独立于旧版下载中心入口设置，升级后也默认关闭。布局与状态说明见 [固定启动区](docs/internal/launch-dock-design.md)。

开始游戏页的正文只保留标题与公告。公告参考 StarFallMCL，默认逐条收起，点击标题或按 Enter／空格展开，再次操作收起；各条公告互不影响，保留图标、Markdown、图片、链接与刷新。公告关闭时仅显示标题，底部版本选择与启动功能保持可用。

同一次运行中，主页面切换会保留离开时的子页面、搜索与筛选、未保存输入和滚动位置，再次点击当前主导航也不会重置页面。版本设置切换到其他主页面或下载中心时保留草稿；明确返回版本列表时仍确认放弃修改。下载中心保留筛选与日志，返回箭头指向本次进入前的页面。隐藏页面停用快捷键和弹出层，后台登录或安装完成不会强制切换当前页面。

`npm run test:notices` 验证首页精简布局、公告折叠、键盘交互、六种主题、窄窗口和刷新恢复；默认使用 `http://127.0.0.1:4180` 的生产预览，也可通过 `SFMCL_T_UI_URL` 指定地址。

默认配置保存到系统应用数据目录；可从「设置 → 关于与迁移 → 打开配置目录」定位。`SFMCL_T_DATA_DIR` 可指定独立配置目录。游戏、模组与存档保存在所选文件夹内的 `.minecraft`，开启隔离后使用其中的 `versions/<版本名>/` 目录。

应用标识为 `com.sfmcl-t.minecraft-launcher`。全新安装使用新标识的配置目录；若新目录尚不存在而旧版 `com.tmcl.minecraft-launcher` 目录存在，会自动沿用旧目录，保留角色、凭据、下载记录与界面偏好。`SFMCL_T_DATA_DIR` 优先于兼容的 `TMCL_DATA_DIR`。CurseForge 与 Microsoft Client ID 同样兼容旧环境变量，渠道凭据优先读取 `SFMCL-T/service-credentials/`，并兼容旧版目录。

启动动画与左上角字标统一显示 **SFMCL**，关于页显示 **SFMCL-T** 与全称。既有游戏存储格式（`.tmcl/`、`tmcl-downloads/`、下载断点文件及整合包元数据键）继续兼容，避免改名破坏版本设置、收藏、续传或旧整合包。

## 迁移与资源

- 在「设置 → 关于与迁移」显式导入旧版 JSON 配置文件。导入会替换当前启动设置并合并角色，原配置文件不被修改。凭据独立使用 Windows 系统保护保存。
- 离线角色的 PNG 皮肤用于启动器预览；正版角色改名/换肤会打开 Minecraft 官方账号页面。
- 支持 Forge、NeoForge、Fabric、Quilt、OptiFine 和 LiteLoader；Forge + OptiFine 按兼容版本组合，Fabric 可附带 Fabric API。
- Forge 联装 OptiFine 时将原始 OptiFine JAR 放入对应游戏目录的 `mods`，由 OptiFine 在运行时应用补丁；只有独立安装 OptiFine 才运行 `optifine.Patcher`，避免展开的 Minecraft 类与 Forge 模块冲突。
- 资源中心支持模组、材质包、光影和数据包的 Modrinth、CurseForge 搜索、筛选、详情和下载。数据包按游戏版本筛选并下载到所选文件夹，使用时放入世界存档的 `datapacks` 文件夹；Modrinth 固定获取数据包格式，避免下载为模组 JAR。本地可启停模组，查看材质包以及存档的完整 64 位种子、游戏规则、模式和天气。资源详情列出的前置依赖需按提示安装。
- CurseForge 文件缺少 `downloadUrl` 时，参考 StarFallMCL 拼接官网下载入口，在点击开始下载后通过独立后台 WebView 解析跳转。取得真实 CDN 地址后加入原有下载队列，保留大小／SHA-1 校验；超时或网站验证失败会提示重试或前往官网，不再将缺少直链直接标为作者未开放下载。
- CurseForge 凭据由 Rust 后端读取，界面不提供密钥输入、展示或导出。开发者可运行 `powershell -NoProfile -ExecutionPolicy Bypass -File SFMCL-T/scripts/import-curseforge-credential.ps1 -StarFallRoot <本地 StarFallMCL 根目录>`，脚本验证原项目中的凭据后，以 Windows DPAPI 加密保存到 `%LOCALAPPDATA%/SFMCL-T/service-credentials/curseforge.dat`，供当前用户的开发版和安装版共用。运行时也兼容 `SFMCL_T_CURSEFORGE_API_KEY` 与旧版加密凭据；空环境变量不会屏蔽已保存凭据。
- 凭据不写入源码、前端包、配置导出或发布程序；`.gitignore` 排除本地环境文件和凭据文件。分发给其他用户的程序不携带此密钥；若要让公众使用渠道且无法提取服务密钥，需将其保存在服务端并代理请求。客户端 DPAPI 保护不能阻止当前 Windows 用户或管理员主动提取凭据。
- Microsoft Client ID 可在设置中修改，默认值也可通过 `SFMCL_T_MICROSOFT_CLIENT_ID` 设置。不要将密码、令牌或 API Key 写入源码。
- 配置目录中的 `Notices.json` 支持 `[{"title":"欢迎","content":"**开始冒险**"}]`，也可用 `source` 引用 Markdown 文件。默认背景读取同目录的 `bg.png` / `bg.jpg`，首页和设置提供刷新入口。

## 开发

源码、资源、npm 与 Cargo 工程均位于 `SFMCL-T/`；启动／打包入口、文档、`.runtime/` 运行数据和 `release/` 发布产物位于外层。下文 `.\dev.cmd`、`.\build.cmd` 在外层执行；`npm`、`cargo` 和 `node scripts/...` 命令在 `SFMCL-T/` 内执行。也可从外层使用 `npm --prefix SFMCL-T run <脚本名>`。

像素组件接口与键盘交互见 [组件说明](docs/internal/pixel-components.md) 和 [表单说明](docs/internal/pixel-controls.md)。启动开发服务后，可运行 `npm run test:components`、`npm run test:controls` 检查界面交互和响应式布局。

`npm run test:launch-dock` 检查固定启动区的选择、启动、取消、错误恢复及响应式布局，使用隔离的内存接口，不会修改本机游戏和账号。启动状态单元测试包含在 `npm test` 中。

`npm run test:breadcrumbs` 检查父子页面层级、主页面切换、返回父页面、未保存设置确认与窄窗口键盘操作，使用隔离的内存接口。

`npm run test:page-retention` 检查首页公告、版本设置、本地资源、资源详情、全局设置、角色登录和下载中心的切页状态保留，以及隐藏页面的快捷键与弹窗。

`npm run test:resources` 包含数据包的两来源筛选、文件夹下载和前置资源跳转。`cargo run -p sfmcl-t-core --example check_datapack_downloads` 实测两平台下载并检查 ZIP 内容；`npm run test:datapack-desktop` 连接 `SFMCL_T_CDP`（默认 9445）的隔离桌面实例，检查真实数据包页面和 IPC 下载／哈希校验，原生文件夹选择器不在该脚本的实操范围内。

`npm run test:versions` 检查版本选择、图标操作、目录切换、布局动画及明暗主题响应式排版；`npm run test:version-settings` 检查每张卡片的全局 / 独立设置、保存与恢复，均使用隔离的内存接口。`npm test` 只扫描 `src` 下的前端单元测试，像素几何的 Node 测试由 `npm run check:corners` 单独运行。

需要 Windows 10/11 x64、Node.js 20.19+ 或 22.12+、Rust 的 `x86_64-pc-windows-msvc` 目标，以及 Visual Studio 的「使用 C++ 的桌面开发」工作负载和 Windows 10/11 SDK。启动桌面开发还需要 WebView2 Runtime；打包本身不要求本机安装 WebView2。

```powershell
.\dev.cmd                    # 检查环境、安装 npm 依赖并启动 Tauri + Vite
.\dev.cmd -Check             # 只检查开发环境
.\dev.cmd -Web               # 仅启动浏览器界面预览
.\dev.cmd -Port 1430         # 默认 1420 已占用时使用其他端口
.\dev.cmd -InstallDependencies # 强制重新执行 npm ci
```

脚本可从任意工作目录调用；`.cmd` 入口兼容 Windows 自带的 PowerShell 5.1，无需修改系统执行策略，也可直接运行 `dev.ps1`。依赖缺少或 `package-lock.json` 变化时自动执行 `npm ci`。`npm run desktop` 使用同一启动脚本；`npm run dev` 仅提供浏览器预览，文件操作、安装和游戏启动需在 Tauri 桌面内使用。

开发实例默认使用外层 `.runtime/dev-data/`，避免与日常使用的配置混在一起。已有 `SFMCL_T_DATA_DIR` 会保留，也可通过 `.\dev.cmd -DataDir D:\SFMCLTDevData` 指定；脚本退出后恢复原环境变量。通过这些入口使用的 `SFMCL_T_DATA_DIR`、`-DataDir` 和打包参数 `-WebView2Path`，其相对路径均以外层目录为基准。

## 打包

```powershell
.\build.cmd                  # 一次构建，生成三种包
.\build.cmd installer        # 安装包，不内置 WebView2
.\build.cmd portable         # 7z 便携包，内置 WebView2 Fixed Version Runtime
.\build.cmd potable          # portable 的兼容拼写
.\build.cmd single           # 单个 EXE，不内置 WebView2
.\build.cmd single -NoExeCompression # 保留编译优化，跳过 UPX 压缩
.\build.cmd portable -PortableFormat zip # 需要 ZIP 格式时使用
.\build.cmd -Check           # 只检查打包所需工具
```

也可使用 `build.ps1 -Mode <模式>`，或 `npm run package:installer`、`npm run package:portable`、`npm run package:single`；`npm run package` 默认生成全部模式。输出文件按应用版本命名：

| 模式 | `release/` 中的产物 | WebView2 行为 |
| --- | --- | --- |
| `installer` | `SFMCL_T_<版本>_x64_installer.exe` | 环境页检测 HKLM/HKCU 的 32/64 位注册表。缺少环境时默认勾选，可取消；已安装时禁用且不勾选。安装包只含下载脚本，勾选后联网下载微软引导程序，验证签名后安装。 |
| `portable` / `potable` | `SFMCL_T_<版本>_x64_portable.7z` | 完整解压后运行 `SFMCL-T.exe`，自动使用同目录的 `WebView2/`，无需安装系统环境。可用 `-PortableFormat zip` 输出 ZIP。 |
| `single` | `SFMCL_T_<版本>_x64_single.exe` | 仅分发这一个 EXE；前端已嵌入，需要目标机器已安装 WebView2。 |

这些模式仅处理启动器的 WebView2，不附带 Java、Node.js 或 Rust。VC 运行库和 WebView2 加载器静态链接，脚本检查 EXE 没有对相应外置 DLL 的依赖。安装器的 `/S` 静默模式和 `/P` 被动模式也会检测环境，缺少时自动下载；取消勾选的交互安装只安装应用。

发布构建采用体积优化、完整 LTO、符号剥离和 `panic = "abort"`，并只启用使用到的依赖功能。内部 Rust panic 会直接结束发布版进程；正常错误仍通过原来的错误处理返回。单文件默认再使用 UPX 的 `--ultra-brute` 压缩，保留重定位与附加数据；`-NoExeCompression` 可生成未经 UPX 处理的 EXE。

安装包和便携包直接压缩编译后的原始 EXE。安装包采用 NSIS 的 LZMA，便携包默认采用 7z 的 LZMA2 固实压缩、128 MiB 字典，保留 WebView2 全部文件。Windows 10 解压 `.7z` 需要 7-Zip 等工具；ZIP 选项使用标准 Deflate，可由资源管理器解压。高压缩率会增加打包时间和内存占用。

首次需要压缩工具时，脚本从 [UPX 官方发布](https://github.com/upx/upx/releases/tag/v5.2.1)和 [7-Zip 官方发布](https://github.com/ip7z/7zip/releases/tag/26.04)下载固定版本，校验归档与可执行文件的 SHA-256，缓存在 `.runtime/packaging/tools/`；后续可离线复用。工具只用于构建，不需要系统安装，也不随应用分发。

本轮产物：single 2.01 MiB、installer 2.28 MiB、portable 189.04 MiB。体积比较和验证范围见[验证记录](docs/internal/verification.md#发布体积优化2026-10-15)。

便携版首次构建自动从[微软官方页面](https://developer.microsoft.com/en-us/microsoft-edge/webview2)下载 x64 固定版环境，校验微软签名和架构，缓存在 `.runtime/packaging/webview2/x64/`。后续优先复用缓存。固定版不会自动更新；发布新版时可指定新版本，或使用已下载并解压的官方固定版目录：

```powershell
.\build.cmd portable -WebView2Version 155.0.4283.45
.\build.cmd portable -WebView2Path D:\SDKs\WebView2
```

`-WebView2Path` 应直接包含 `msedgewebview2.exe`、`msedge.dll`、`locales/` 等文件，不是 CAB 文件或系统 Edge 安装目录。仅指定版本时，该版本必须仍在微软下载页面提供，或已在本地缓存。网络受限时可提前准备本地环境及 npm/Cargo 依赖。便携版解压到可写的本地目录，运行时会为其 WebView2 目录设置微软要求的 AppContainer 读取/执行权限。配置仍默认保存在系统应用数据目录，可用 `SFMCL_T_DATA_DIR` 调整。

## 验证

以下命令在 `SFMCL-T/` 内执行，测试数据、截图和检查结果统一读写外层 `.runtime/`。

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm test
npm run build
npm run package
npm run test:packaging  # 需先构建一次 installer，验证实际 NSIS 复选框及返回时的选择保持
```

桌面自动化脚本通过 CDP 连接**隔离测试实例**，会创建测试角色、下载游戏或测试文件。请勿将测试脚本指向日常使用的数据目录。

```powershell
$env:SFMCL_T_DATA_DIR = [IO.Path]::GetFullPath((Join-Path $PWD '..\.runtime\ui-data'))
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9422'
npm run desktop
# 在另一个同样位于 SFMCL-T/ 的终端，测试实例需已添加外层 .runtime/smoke-game 并安装 1.20.1：
npm run test:e2e
node scripts/probe-services.mjs
npm run test:loaders
node scripts/verify-addons.mjs
# 启动验收还需要外层 .runtime/java8 与 .runtime/java17 中的 JRE：
npm run test:launches
```

发布版的 CDP 地址可通过 `SFMCL_T_CDP` 传给验证脚本。`scripts/verify-workflows.mjs` 默认连接 `9423` 的独立发布版实例。

## 验收范围

具体检查与证据见 [验证记录](docs/internal/verification.md)，功能对应关系见 [功能映射](docs/internal/feature-parity.md)。真人 Microsoft 授权与刷新仍按用户要求保留待验收；2026-10-19 已使用当前用户的加密凭据完成 CurseForge 分类、查询、详情、文件列表与真实下载校验。外部服务实测不能以单元测试或编译通过替代。当前版本的实测样本不代表所有历史 Minecraft / 加载器组合均已验证。

旧版 C# / WPF 项目在迁移期间仅作为只读参考。
