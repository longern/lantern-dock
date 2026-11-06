import { Icon } from "./Icon.jsx";
import { bytes } from "../lib/format.js";
import { useLayoutEffect, useRef } from "preact/hooks";

export function DownloadPanel({ progress, onCancel }) {
  const element = useRef(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    node.showPopover?.();
    return () => node.hidePopover?.();
  }, [!!progress]);
  if (!progress) return null;
  return (
    <div ref={element} popover="manual" class="download-panel" role="status">
      <Icon name="download" />
      <div>
        <strong>{progress.name}</strong>
        <p>
          {progress.received
            ? `${bytes(progress.received)}${progress.total ? " / " + bytes(progress.total) : ""}`
            : "正在连接文件…"}
        </p>
        <progress
          aria-label="下载进度"
          max={progress.total || 1}
          value={progress.total ? progress.received : undefined}
        />
      </div>
      <button class="icon-button" aria-label="取消下载" onClick={onCancel}>
        <Icon name="x" />
      </button>
    </div>
  );
}
