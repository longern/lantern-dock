import { useEffect, useId, useState } from "preact/hooks";
import { t } from "../../shared/i18n.js";
import { checkResponse } from "../lib/dav.js";
import { bytes, date } from "../lib/format.js";
import { Dialog } from "./Dialog.jsx";
import { Icon } from "./Icon.jsx";

export function FileDetails({
  item,
  client,
  open,
  onClose,
  onExited,
  fallbackFocus,
}) {
  const id = useId();
  const [metadata, setMetadata] = useState(item);
  const [status, setStatus] = useState({ loading: true });
  let displayPath;
  try {
    displayPath = decodeURIComponent(item.path);
  } catch {
    displayPath = item.path;
  }
  useEffect(() => {
    const controller = new AbortController();
    setMetadata(item);
    setStatus({ loading: true });
    (async () => {
      try {
        const response = await client.read(
          item.path,
          controller.signal,
          {},
          "HEAD",
        );
        if ([404, 410].includes(response.status)) {
          await response.body?.cancel();
          if (!controller.signal.aborted) setStatus({ missing: true });
          return;
        }
        checkResponse(response);
        await response.body?.cancel();
        if (controller.signal.aborted) return;
        const size = response.headers.get("Content-Length");
        setMetadata({
          ...item,
          size: size !== null && /^\d+$/.test(size) ? Number(size) : item.size,
          mime: response.headers.get("Content-Type") || item.mime,
          modified: response.headers.get("Last-Modified") || item.modified,
        });
        setStatus({});
      } catch (error) {
        if (!controller.signal.aborted) setStatus({ error: error.message });
      }
    })();
    return () => controller.abort();
  }, [item, client]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      onExited={onExited}
      class="settings-dialog"
      aria-labelledby={id}
      fallbackFocus={fallbackFocus}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div class="dialog-heading">
        <h2 id={id}>{t("library.mediaDetails")}</h2>
        <button
          class="icon-button edge-end"
          aria-label={t("library.closeDetails")}
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </div>
      <dl class="file-details">
        <div>
          <dt>{t("library.name")}</dt>
          <dd>{item.name}</dd>
        </div>
        <div>
          <dt>{t("library.filePath")}</dt>
          <dd>{displayPath}</dd>
        </div>
        <div>
          <dt>{t("library.type")}</dt>
          <dd>
            {item.isDirectory
              ? t("library.folder")
              : metadata.mime || item.name.split(".").pop().toUpperCase()}
          </dd>
        </div>
        {!item.isDirectory && (
          <div>
            <dt>{t("library.size")}</dt>
            <dd>{bytes(metadata.size)}</dd>
          </div>
        )}
        <div>
          <dt>{t("library.modifiedAt")}</dt>
          <dd>{date(metadata.modified, true)}</dd>
        </div>
      </dl>
      {status.loading && (
        <p class="dialog-intro" role="status">
          {t("library.checkingFile")}
        </p>
      )}
      {status.missing && (
        <p class="dialog-intro" role="status">
          {t("library.fileNotFound")}
        </p>
      )}
      {status.error && (
        <p class="dialog-intro" role="status">
          {status.error}
        </p>
      )}
    </Dialog>
  );
}
