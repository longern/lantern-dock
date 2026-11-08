import { t } from "../../shared/i18n.js";
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
            ? progress.total
              ? t("library.downloadTransferred", { received: bytes(progress.received), total: bytes(progress.total) })
              : bytes(progress.received)
            : t("library.connectingFile")}
        </p>
        <progress
          aria-label={t("library.downloadProgress")}
          max={progress.total || 1}
          value={progress.total ? progress.received : undefined}
        />
      </div>
      <button class="icon-button" aria-label={t("library.cancelDownload")} onClick={onCancel}>
        <Icon name="x" />
      </button>
    </div>
  );
}
