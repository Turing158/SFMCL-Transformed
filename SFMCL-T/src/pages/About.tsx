import {
  BookOpen,
  Cloud,
  CodeXml,
  ExternalLink,
  Languages,
  Layers,
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
    url: "https://turing158.github.io/",
    tone: "blue",
    icon: <CodeXml size={18} />,
  },
  {
    name: "HMCL",
    description: "感谢 @HMCL 提供的模组与整合包中文名称数据",
    url: "https://github.com/HMCL-dev/HMCL",
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
