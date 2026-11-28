import { useId, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { CollapsiblePanel } from "../components";
import { Input, Textarea } from "../controls";

export function hasTerracottaCode(value: string) {
  // Upstream reads the least significant base-34 digit first.
  const alphabet = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const pattern = /(?=U\/([A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}))/gi;
  for (const match of value.matchAll(pattern)) {
    const digits = match[1]
      .toUpperCase()
      .replaceAll("I", "1")
      .replaceAll("O", "0")
      .replaceAll("-", "");
    let remainder = 0;
    for (const c of [...digits].reverse())
      remainder = (remainder * 34 + alphabet.indexOf(c)) % 7;
    if (!remainder) return true;
  }
  return false;
}

export function TerracottaOptions({
  host,
  disabled,
  room,
  setRoom,
  nodes,
  setNodes,
}: {
  host: boolean;
  disabled: boolean;
  room: string;
  setRoom: (v: string) => void;
  nodes: string;
  setNodes: (v: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <CollapsiblePanel
      className="multiplayer-terracotta-options"
      title="高级选项"
      icon={SlidersHorizontal}
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      {host && (
        <div className="multiplayer-field">
          <label htmlFor={id + "-old"}>自定义邀请码</label>
          <Input
            id={id + "-old"}
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            maxLength={4096}
            aria-invalid={!!room.trim() && !hasTerracottaCode(room)}
            placeholder="留空生成新邀请码"
          />
        </div>
      )}
      <div className="multiplayer-field">
        <label htmlFor={id + "-nodes"}>备用公共节点</label>
        <Textarea
          id={id + "-nodes"}
          value={nodes}
          onChange={(e) => setNodes(e.target.value)}
          disabled={disabled}
          rows={2}
          maxLength={16384}
          spellCheck={false}
          placeholder="每行一个节点地址，留空使用陶瓦内置节点"
        />
      </div>
    </CollapsiblePanel>
  );
}
