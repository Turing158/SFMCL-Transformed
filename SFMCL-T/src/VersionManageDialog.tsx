import { useState } from "react";
import {
  FolderOpen,
  ImagePlus,
  Package,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button, Modal, PixelFrame, ResourceImage } from "./components";
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
        <div
          className="split-button split-button-equal has-surface"
          role="group"
          aria-label="整合包操作"
        >
          <PixelFrame />
          <button
            type="button"
            disabled={app.busy || !!version.error}
            onClick={() => {
              app.openVersionPage("modpack-update", version);
              onClose();
            }}
          >
            <RefreshCw size={16} aria-hidden="true" />
            更新
          </button>
          <button
            type="button"
            className="split-button-secondary"
            disabled={app.busy || !!version.error}
            onClick={() => {
              app.openVersionPage("modpack-export", version);
              onClose();
            }}
          >
            <Package size={16} aria-hidden="true" />
            导出
          </button>
        </div>
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
        <div
          className="split-button has-surface"
          role="group"
          aria-label="版本图标操作"
        >
          <PixelFrame />
          <button
            type="button"
            disabled={app.busy}
            onClick={() => void actions.changeIcon()}
          >
            <ImagePlus size={16} aria-hidden="true" />
            更换图标
          </button>
          <button
            type="button"
            className="split-button-secondary"
            aria-label="恢复默认图标"
            data-tooltip="恢复默认图标"
            disabled={app.busy}
            onClick={() => void actions.changeIcon(true)}
          >
            <RotateCcw size={14} aria-hidden="true" />
          </button>
        </div>
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
