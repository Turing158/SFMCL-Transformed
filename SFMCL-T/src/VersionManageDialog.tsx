import { useState } from "react";
import {
  FolderOpen,
  ImagePlus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { Button, Modal, ResourceImage } from "./components";
import { Input } from "./controls";
import { useApp } from "./store";
import type { Version } from "./types";
import { useVersionActions } from "./versionActions";

export function VersionManageDialog({
  version,
  onClose,
}: {
  version: Version;
  onClose: () => void;
}) {
  const app = useApp();
  const [name, setName] = useState(version.id);
  const actions = useVersionActions(version, onClose);
  return (
    <Modal title={`管理 ${version.id}`} onClose={onClose}>
      <div className="details-meta">
        <ResourceImage path={version.icon} alt="版本图标" />
        <div>
          <h3>{version.loader}</h3>
          <p className="path-text">{version.path}</p>
        </div>
      </div>
      <label className="field">
        版本名称
        <div className="input-action">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button
            disabled={name === version.id || !name.trim() || app.busy}
            onClick={() => void actions.rename(name)}
          >
            重命名
          </Button>
        </div>
      </label>
      <div className="action-grid">
        <Button
          onClick={() => {
            app.openVersionPage("settings", version);
            onClose();
          }}
        >
          <Settings2 size={16} />
          游戏设置
        </Button>
        <Button
          onClick={() => {
            app.openVersionPage("resources", version);
            onClose();
          }}
        >
          <FolderOpen size={16} />
          本地资源
        </Button>
        <Button disabled={app.busy} onClick={() => void actions.openFolder()}>
          <FolderOpen size={16} />
          打开版本目录
        </Button>
        <Button
          disabled={app.busy}
          onClick={() => void actions.openFolder(true)}
        >
          打开 native 目录
        </Button>
        <Button disabled={app.busy} onClick={() => void actions.changeIcon()}>
          <ImagePlus size={16} />
          更换图标
        </Button>
        <Button
          disabled={app.busy}
          onClick={() => void actions.changeIcon(true)}
        >
          恢复默认图标
        </Button>
        <Button disabled={app.busy} onClick={() => void actions.repair()}>
          <RefreshCw size={16} />
          补全资源文件
        </Button>
        <Button
          danger
          disabled={app.busy}
          onClick={() => void actions.remove()}
        >
          <Trash2 size={16} />
          删除版本
        </Button>
      </div>
    </Modal>
  );
}
