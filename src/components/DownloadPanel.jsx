import { Icon } from "./Icon.jsx";
import { bytes } from "../lib/format.js";

export function DownloadPanel({ progress, onCancel }) {
  if (!progress) return null;
  return (
    <div class="download-panel" role="status">
      <Icon name="download" />
      <div>
        <strong>{progress.name}</strong>
        <p>
          {progress.received
            ? `${bytes(progress.received)}${progress.total ? " / " + bytes(progress.total) : ""}`
            : "正在连接文件…"}
        </p>
        <progress
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
