import { t } from "../../../../shared/i18n.js";
import { useEffect, useId, useLayoutEffect, useState } from "preact/hooks";
import { Icon } from "../../../components/Icon.jsx";
import { limitedBytes } from "../../../lib/dav.js";
import { bytes, date } from "../../../lib/format.js";
import {
  useBreakpointDown,
  useCompactLayout,
} from "../../../hooks/useMediaQuery.js";
import { Dialog } from "../../../components/Dialog.jsx";
import { VideoPreview } from "./VideoPreview.jsx";
import { PageHeader } from "../../../components/PageHeader.jsx";
import { SheetHandle } from "../../../components/SheetHandle.jsx";
import { dialogHeadingFocus } from "../../../lib/overlay-focus.js";

export function FilePreview({
  item,
  client,
  favorite,
  onFavorite,
  onDownload,
  onCopyLink,
  onError,
  onClose,
  onEntered,
  onExited,
  returnTarget,
  open,
  feedback,
}) {
  const modal = useBreakpointDown("lg");
  const compact = useCompactLayout();
  const [content, setContent] = useState(null);
  const [error, setError] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  const [drawerMounted, setDrawerMounted] = useState(false);
  useLayoutEffect(() => {
    if (compact && details && open) setDrawerMounted(true);
    else if (!compact) {
      setDetails(false);
      setDrawerMounted(false);
    }
  }, [compact, details, open]);

  useEffect(() => {
    const controller = new AbortController();
    let url;
    setContent(null);
    setError("");
    setDimensions("");
    (async () => {
      try {
        if (item.kind === "video") {
          setContent({ video: true });
          return;
        }
        if (!["image", "text"].includes(item.kind)) {
          setError(t("library.downloadToView"));
          return;
        }
        if (item.kind === "image" && client.images) {
          const show = (image) => {
            if (!image || controller.signal.aborted) return;
            if (url) URL.revokeObjectURL(url);
            url = URL.createObjectURL(image.blob);
            setContent({ url, width: image.width, height: image.height });
            setDimensions(`${image.width} × ${image.height}`);
          };
          show(client.images.peek(item, 1600));
          const image = await client.images.image(
            item,
            1600,
            controller.signal,
          );
          if (image) {
            show(image);
            return;
          }
        }
        const limit = (item.kind === "image" ? 25 : 1) * 1024 * 1024;
        if (item.size > limit) throw new Error(t("library.previewTooLarge"));
        const response = await client.get(item.path, controller.signal);
        const data = await limitedBytes(response, limit, controller.signal);
        if (controller.signal.aborted) return;
        if (item.kind === "text") {
          setContent({ text: new TextDecoder().decode(data) });
          return;
        }
        const mime = response.headers.get("Content-Type")?.split(";")[0];
        if (mime && !mime.startsWith("image/"))
          throw new Error(t("library.imageResponseInvalid"));
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(
          new Blob([data], { type: mime || "image/*" }),
        );
        setContent({ url });
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(t("library.filePreviewFailed"));
          onError(error.message);
        }
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [item, client, client.images?.revision]);

  return (
    <Dialog
      open={open}
      modal={modal}
      onClose={onClose}
      onEntered={onEntered}
      onExited={onExited}
      returnTarget={returnTarget}
      fallbackFocus=".main-area #file-list"
      id="preview-dialog"
      class="preview-dialog"
      aria-labelledby="preview-name"
    >
      <div class="preview-header" {...dialogHeadingFocus}>
        <button
          class="icon-button edge-start"
          aria-label={t("library.closePreview")}
          onClick={onClose}
        >
          <Icon name={modal ? "chevron-left" : "x"} />
        </button>
        <strong id="preview-name">{item.name}</strong>
      </div>
      <div
        class={`preview-scroll${item.kind === "image" || item.kind === "video" ? " preview-media" : ""}`}
      >
        <div class="preview-content">
          {error || !content ? (
            <div class="preview-placeholder">
              <Icon name={item.kind} />
              <p role="status">{error || t("library.loadingPreview")}</p>
            </div>
          ) : content.video ? (
            <VideoPreview
              item={item}
              client={client}
              open={open}
              onError={onError}
              onDimensions={(width, height) =>
                setDimensions(`${width} × ${height}`)
              }
            />
          ) : content.text !== undefined ? (
            <pre>{content.text}</pre>
          ) : (
            <img
              src={content.url}
              alt={item.name}
              onLoad={(event) =>
                setDimensions(
                  `${content.width || event.currentTarget.naturalWidth} × ${content.height || event.currentTarget.naturalHeight}`,
                )
              }
              onError={() => {
                setError(t("library.imagePreviewFailed"));
                onError(t("library.imagePreviewFailed"));
              }}
            />
          )}
        </div>
        {!compact && (
          <section
            id={detailsId}
            class="preview-details"
            aria-label={t("library.mediaDetails")}
          >
            <PreviewMetadata item={item} dimensions={dimensions} />
          </section>
        )}
      </div>
      <footer class="preview-actions">
        <button
          class="preview-action"
          aria-label={t("library.copyLink")}
          onClick={() => onCopyLink(item)}
        >
          <Icon name="copy" />
          <span>{t("library.copyLink")}</span>
        </button>
        <button
          class="preview-action"
          aria-label={
            favorite ? t("library.unfavoriteFile") : t("library.favoriteFile")
          }
          aria-pressed={favorite}
          onClick={() => onFavorite(item)}
        >
          <Icon name={favorite ? "star-filled" : "star"} />
          <span>
            {t(favorite ? "library.removeFavorites" : "library.addFavorites")}
          </span>
        </button>
        <button class="preview-action" onClick={() => onDownload(item)}>
          <Icon name="download" />
          <span>{t("library.download")}</span>
        </button>
        {compact && (
          <button
            class="preview-action"
            aria-label={t("library.mediaDetails")}
            aria-expanded={details}
            aria-controls={detailsId}
            onClick={() => setDetails((value) => !value)}
          >
            <Icon name="info" />
            <span>{t("library.info")}</span>
          </button>
        )}
      </footer>
      {compact && drawerMounted && (
        <Dialog
          id={detailsId}
          class="settings-dialog file-info-drawer"
          open={details && open}
          onClose={() => setDetails(false)}
          onExited={() => setDrawerMounted(false)}
          aria-labelledby={`${detailsId}-title`}
          fallbackFocus=".preview-action[aria-controls]"
        >
          <SheetHandle onDismiss={() => setDetails(false)} />
          <PageHeader
            className="file-info-header"
            title={t("library.mediaDetails")}
            titleId={`${detailsId}-title`}
            titleTag="h2"
            actions={
              <button
                class="icon-button edge-end"
                aria-label={t("library.closeDetails")}
                onClick={() => setDetails(false)}
              >
                <Icon name="x" />
              </button>
            }
            {...dialogHeadingFocus}
          />
          <div class="file-info-body">
            <PreviewMetadata item={item} dimensions={dimensions} />
          </div>
        </Dialog>
      )}
      {feedback}
    </Dialog>
  );
}

function PreviewMetadata({ item, dimensions }) {
  return (
    <dl class="file-details">
      <div>
        <dt>{t("library.type")}</dt>
        <dd>{item.mime || item.name.split(".").pop().toUpperCase()}</dd>
      </div>
      <div>
        <dt>{t("library.size")}</dt>
        <dd>{bytes(item.size)}</dd>
      </div>
      {dimensions && (
        <div>
          <dt>{t("library.dimensions")}</dt>
          <dd>{dimensions}</dd>
        </div>
      )}
      <div>
        <dt>{t("library.modifiedAt")}</dt>
        <dd>{date(item.modified, true)}</dd>
      </div>
    </dl>
  );
}
