import { useLayoutEffect, useRef, type CSSProperties } from "react";
import type { Download } from "./types";
import { usePageActive } from "./PageActivity";
import { downloadMiningState } from "./downloadMiningState";
import { createDownloadMiningMotion } from "./downloadMiningMotion";
import "./download-mining.css";

const assets = "/assets/minecraft/downloads/";

export function DownloadMining({ downloads }: { downloads: Download[] }) {
  const { state, label, detail, progress } = downloadMiningState(downloads);
  const active = usePageActive();
  const scene = useRef<HTMLDivElement>(null);
  const motion = useRef<ReturnType<typeof createDownloadMiningMotion> | null>(
    null,
  );
  useLayoutEffect(() => {
    const controller = createDownloadMiningMotion(scene.current!);
    motion.current = controller;
    return () => {
      controller.dispose();
      motion.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    motion.current?.setState(state);
  }, [state]);
  useLayoutEffect(() => {
    motion.current?.setVisible(active);
  }, [active]);
  return (
    <div className="download-mining" data-state={state}>
      <div className="download-mine-copy">
        <strong role="status">{label}</strong>
        <small>{detail}</small>
      </div>
      <div className="download-mine-viewport" aria-hidden="true">
        <div
          ref={scene}
          className="download-mine-scene"
          data-unknown={progress === null}
          style={{ "--mine-progress": progress ?? 0 } as CSSProperties}
        >
          <div className="download-mine-ground" />
          <i className="download-mine-grass" />
          <div className="download-mine-queue" />
          <div className="download-mine-idle-effects">
            <i className="download-mine-shadow" />
            {Array.from({ length: 4 }, (_, index) => (
              <i key={index} className="download-mine-spark" />
            ))}
          </div>
          <div className="download-mine-pick">
            <img src={`${assets}pickaxe.png`} alt="" draggable={false} />
          </div>
          <img
            className="download-mine-diamond"
            src={`${assets}diamond.png`}
            alt=""
            draggable={false}
          />
          <img
            className="download-mine-diamond two"
            src={`${assets}diamond.png`}
            alt=""
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}
