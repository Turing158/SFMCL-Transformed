import { ChevronRight, Clock3, Globe } from "lucide-react";
import { Badge, Button, PixelFrame } from "../components";
import { useApp } from "../store";

export function PlayerAuthorizationUnavailable() {
  const app = useApp();
  return (
    <div className="players-authorization-unavailable has-surface">
      <PixelFrame />
      <Badge>
        <Clock3 size={13} aria-hidden="true" />
        暂未开放
      </Badge>
      <div className="players-login-intro">
        <h3>LittleSkin登录暂未开放</h3>
        <p>你可以使用皮肤站的账号和密码登录，连接你的游戏角色。</p>
      </div>
      <Button
        primary
        disabled={app.busy}
        onClick={() => app.openPlayerLogin("yggdrasil")}
      >
        <Globe size={15} aria-hidden="true" />
        使用第三方登录
        <ChevronRight size={14} aria-hidden="true" />
      </Button>
    </div>
  );
}
