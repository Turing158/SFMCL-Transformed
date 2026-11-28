import {
  BookOpen,
  Box,
  Cloud,
  CodeXml,
  ExternalLink,
  Languages,
  Layers,
  Network,
  ShieldCheck,
  Type,
  UserRound,
} from "lucide-react";
import { external } from "../api";
import {
  appIcon,
  BRAND_WORDMARK,
  BRAND_FULL_NAME,
  BRAND_EDITION,
  BRAND_TAGLINE,
} from "../branding";
import { PixelFrame } from "../components";
import { useApp } from "../store";
import { UpdateCheckButton, useUpdateCheck } from "../UpdateCheckButton";
import "../about.css";

const acknowledgements = [
  {
    name: "Turing158",
    description: "感谢 @Turing158 把我创造出来",
    url: "https://blog.turing158.cc.cd/",
    tone: "blue",
    icon: <CodeXml size={18} />,
  },
  {
    name: "Terracotta 陶瓦联机",
    description: "© burningtnt 与 Terracotta 贡献者",
    url: "https://github.com/burningtnt/Terracotta/blob/v0.4.2/README.md#许可",
    tone: "amber",
    icon: <Network size={17} />,
  },
  {
    name: "HMCL",
    description: "感谢 @HMCL 提供的模组与整合包中文名称数据",
    url: "https://hmcl.huangyuhui.net/",
    tone: "amber",
    icon: <Languages size={17} />,
  },
  {
    name: "bangbang93",
    description: "感谢 @bangbang93 提供的BMCLAPI支持",
    url: "https://blog.bangbang93.com/",
    tone: "teal",
    icon: <Cloud size={17} />,
  },
  {
    name: "MC MIRROR",
    description: "提供原版正式版、Fabric 与 Quilt 的完整文件与元数据",
    url: "https://us-west-01.mc-mirror.com/#guide",
    tone: "teal",
    icon: <Layers size={17} />,
  },
  {
    name: "MCIM",
    description: "感谢 @MCIM 提供的 Modrinth 与 CurseForge 镜像服务",
    url: "https://www.mcimirror.top/",
    tone: "teal",
    icon: <Cloud size={17} />,
  },
  {
    name: "Minecraft中文Wiki",
    description: "感谢 @Minecraft中文Wiki 提供启动参数信息",
    url: "https://zh.minecraft.wiki/",
    tone: "purple",
    icon: <BookOpen size={17} />,
  },
  {
    name: "Modrinth",
    description: "感谢 @Modrinth 提供的资源查询和下载服务",
    url: "https://modrinth.com/",
    tone: "green",
    icon: <img src="/assets/DefaultGameIcon/modrinth.png" alt="" />,
  },
  {
    name: "CurseForge",
    description: "感谢 @CurseForge 提供的资源查询和下载服务",
    url: "https://www.curseforge.com/minecraft",
    tone: "orange",
    icon: <img src="/assets/DefaultGameIcon/curseForge.png" alt="" />,
  },
  {
    name: "EasyTier",
    description: "感谢 @EasyTier 提供的联机组网与代理支持",
    url: "https://easytier.cn/",
    tone: "teal",
    icon: <Network size={17} />,
  },
  {
    name: "Cloudflare / cloudflared",
    description: "感谢 @Cloudflare 提供的 Cloudflare Tunnel 隧道服务",
    url: "https://www.cloudflare.com/zh-cn/products/tunnel/",
    tone: "orange",
    icon: <Cloud size={17} />,
  },
  {
    name: "LittleSkin",
    description: "感谢 @LittleSkin 提供的角色授权与外置登录服务",
    url: "https://littleskin.cn/",
    tone: "amber",
    icon: <UserRound size={17} />,
  },
  {
    name: "authlib-injector",
    description: "感谢 @authlib-injector 提供的第三方账号认证支持",
    url: "https://authlib-injector.yushi.moe/",
    tone: "purple",
    icon: <ShieldCheck size={17} />,
  },
  {
    name: "skinview3d",
    description: "感谢 @skinview3d 提供的皮肤与披风 3D 预览支持",
    url: "https://skinview3d-demo.vercel.app/",
    tone: "green",
    icon: <Box size={17} />,
  },
  {
    name: "Pixelify Sans",
    description: "感谢 @Pixelify Sans 提供的像素字体",
    url: "https://github.com/eifetx/Pixelify-Sans",
    tone: "blue",
    icon: <Type size={17} />,
  },
];

export function About({
  updateCheck,
}: {
  updateCheck: ReturnType<typeof useUpdateCheck>;
}) {
  const app = useApp();

  return (
    <div className="settings-stack about-container">
      <section className="panel about-card about-layout has-surface">
        <PixelFrame />
        <div className="about-brand" aria-label="SFMCL 品牌信息">
          <img
            className="about-mark"
            src={appIcon}
            alt={`${BRAND_WORDMARK} 软件图标`}
            draggable={false}
          />
          <div className="about-remade-kicker">
            <span className="about-remade-mark" aria-label="T 重制标记">
              T
            </span>
            <span className="about-remade-edition">{BRAND_EDITION}</span>
            <span className="about-remade-tagline">{BRAND_TAGLINE}</span>
          </div>
          <h2>{BRAND_WORDMARK}</h2>
          <p className="about-full-name">{BRAND_FULL_NAME}</p>
          <div className="about-brand-footer">
            <span className="badge has-surface">
              <PixelFrame />v{app.data.version} · Rust + Tauri
            </span>
            <UpdateCheckButton {...updateCheck} />
          </div>
        </div>
        <ul className="about-credits" aria-label="特别鸣谢">
          {acknowledgements.map(({ name, description, url, tone, icon }) => (
            <li key={name}>
              <a
                className="about-credit has-surface"
                data-tone={tone}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  void app.run(() => external(url));
                }}
              >
                <PixelFrame />
                <span
                  className="about-credit-icon has-surface"
                  aria-hidden="true"
                >
                  <PixelFrame />
                  {icon}
                </span>
                <span className="about-credit-copy">
                  <span className="about-credit-name">{name}</span>
                  <span
                    className="about-credit-description"
                    title={description}
                  >
                    {description}
                  </span>
                </span>
                <ExternalLink
                  className="about-credit-external"
                  size={13}
                  aria-hidden="true"
                />
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
