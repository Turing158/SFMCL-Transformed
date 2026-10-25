import { useId, useState } from "react";
import { CalendarDays, HardDrive } from "lucide-react";
import { bytes } from "../api";
import { Badge, PixelFrame } from "../components";
import type { ResourceFile } from "../types";
import { resourceDependencyKinds } from "../resourceDownloads";
import { ProjectFileTags } from "./ProjectFileTags";

export function ProjectFileItem({
  resource,
  disabled,
  onSelect,
}: {
  resource: ResourceFile;
  disabled: boolean;
  onSelect: () => void;
}) {
  const name = resource.name || resource.version || "未命名版本";
  const descriptionId = useId();
  const dependencyDescriptionId = `${descriptionId}-dependencies`;
  const [focused, setFocused] = useState(false);
  return (
    <button
      type="button"
      className="project-file catalog-project has-surface"
      disabled={!resource.file || disabled}
      aria-label={
        resource.file ? `选择 ${name} 的下载位置` : `${name}，暂时无法下载`
      }
      aria-describedby={
        resource.dependencies.length > 0
          ? `${descriptionId} ${dependencyDescriptionId}`
          : descriptionId
      }
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={onSelect}
    >
      <PixelFrame />
      <span className="project-file-main">
        <span className="project-file-title">
          <strong>{name}</strong>
        </span>
        <ProjectFileTags
          resource={resource}
          descriptionId={descriptionId}
          focused={focused}
        />
        {resource.dependencies.length > 0 && (
          <span
            id={dependencyDescriptionId}
            className="project-file-dependencies"
          >
            {resource.dependencies
              .map(
                (dependency) =>
                  `前置${resourceDependencyKinds[dependency.kind] || "未知类型"}：${dependency.name?.trim() || "名称暂不可用"}`,
              )
              .join("；")}
          </span>
        )}
        {!resource.file && (
          <Badge className="project-file-unavailable">暂时无法下载</Badge>
        )}
      </span>
      <span className="project-file-meta">
        <span>
          <CalendarDays size={13} aria-hidden="true" />
          {resource.date ? (
            <time dateTime={resource.date}>{resource.date.slice(0, 10)}</time>
          ) : (
            "日期未知"
          )}
        </span>
        <span>
          <HardDrive size={13} aria-hidden="true" />
          {resource.file?.size ? bytes(resource.file.size) : "大小未知"}
        </span>
      </span>
    </button>
  );
}
