import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { PhotoSlider } from "react-photo-view";
import "react-photo-view/dist/react-photo-view.css";
import { t } from "../../shared/i18n.js";
import { bytes, date } from "../lib/format.js";
import { fitAlbumMedia } from "../lib/album-media.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { AlbumMedia } from "./AlbumMedia.jsx";
import { Dialog } from "./Dialog.jsx";
import { Icon } from "./Icon.jsx";
import { useLiveMedia } from "../hooks/useLiveMedia.js";

export function AlbumViewer({
  gallery,
  item,
  client,
  open,
  onSelect,
  favorite,
  onFavorite,
  onDownload,
  onCopyLink,
  onClose,
  onExited,
  feedback,
}) {
  const [container, setContainer] = useState(null);
  const [entered, setEntered] = useState(false);
  const [details, setDetails] = useState(false);
  const [livePlaying, setLivePlaying] = useState(false);
  const live = useLiveMedia(client, gallery.items);
  const stopLive = useCallback(() => setLivePlaying(false), []);
  const [viewport, setViewport] = useState({
    width: innerWidth,
    height: innerHeight,
  });
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [lifetime] = useState(() => new AbortController());
  const [snapshots] = useState(
    () =>
      new Map(
        gallery.items.map((entry) => {
          const image = gallery.origins.get(entry.path)?.current;
          const cached =
            client.images?.peek(entry, 384) || client.images?.peek(entry, 1600);
          return [
            entry.path,
            {
              thumbnail:
                image?.tagName === "IMG" && image.naturalWidth
                  ? image.currentSrc
                  : "",
              width: cached?.width || image?.naturalWidth || 0,
              height: cached?.height || image?.naturalHeight || 0,
            },
          ];
        }),
      ),
  );
  const [sizes, setSizes] = useState(() => new Map(snapshots));
  const callbacks = useRef(null);
  callbacks.current = { onClose, onSelect };
  const controls = useRef(null);
  const closing = useRef(false);
  const index = gallery.items.findIndex((entry) => entry.path === item.path);
  useLayoutEffect(() => setLivePlaying(false), [index, open]);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    lifetime.abort();
    callbacks.current.onClose();
  }, [lifetime]);

  useLayoutEffect(() => () => lifetime.abort(), [lifetime]);
  useEffect(() => {
    if (!open) lifetime.abort();
    const timer = setTimeout(() => setEntered(true), reducedMotion ? 0 : 320);
    return () => clearTimeout(timer);
  }, [open, reducedMotion, lifetime]);
  useEffect(() => {
    const resize = () =>
      setViewport({ width: innerWidth, height: innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const onSize = useCallback((path, width, height) => {
    if (!(width > 0 && height > 0)) return;
    setSizes((previous) => {
      const old = previous.get(path);
      if (old?.width === width && old?.height === height) return previous;
      return new Map(previous).set(path, { width, height });
    });
  }, []);
  const images = useMemo(
    () =>
      gallery.items.map((entry, position) => {
        const size = sizes.get(entry.path) || {};
        return {
          key: entry.path,
          ...fitAlbumMedia(
            size.width,
            size.height,
            viewport.width,
            viewport.height,
          ),
          originRef: reducedMotion
            ? undefined
            : gallery.origins.get(entry.path),
          render: ({ attrs }) => (
            <AlbumMedia
              attrs={attrs}
              item={entry}
              client={client}
              thumbnail={snapshots.get(entry.path)?.thumbnail}
              active={index === position}
              open={open}
              entered={entered}
              signal={lifetime.signal}
              onSize={onSize}
              live={live.get(entry.path) || entry.live}
              liveRequested={index === position && livePlaying}
              onLiveStop={stopLive}
            />
          ),
        };
      }),
    [
      gallery,
      client,
      index,
      open,
      entered,
      sizes,
      viewport,
      snapshots,
      lifetime,
      onSize,
      reducedMotion,
      live,
      livePlaying,
      stopLive,
    ],
  );

  const select = (next) => {
    if (!open || next === index || next < 0 || next >= gallery.items.length)
      return;
    setDetails(false);
    callbacks.current.onSelect(gallery.items[next]);
  };
  const keyboard = (event) => {
    if (event.key === "Escape" && details) {
      event.preventDefault();
      event.stopPropagation();
      setDetails(false);
    } else if (event.target.closest("video, input, textarea, select")) {
      // Arrow keys on a video seek/adjust volume, rather than changing slides.
      if (event.key.startsWith("Arrow")) event.stopPropagation();
    } else if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      controls.current?.onIndexChange(
        Math.max(
          0,
          Math.min(
            gallery.items.length - 1,
            index + (event.key === "ArrowLeft" ? -1 : 1),
          ),
        ),
      );
    }
  };
  return (
    <Dialog
      id="album-viewer"
      class="album-viewer"
      open={open}
      modal
      aria-label={t("library.album")}
      aria-labelledby="album-viewer-name"
      onClose={close}
      onExited={onExited}
      onKeyDownCapture={keyboard}
    >
      <div ref={setContainer} class="album-viewer-host" />
      {container && (
        <PhotoSlider
          images={images}
          visible={open}
          index={index}
          onIndexChange={select}
          onClose={close}
          loop={false}
          portalContainer={container}
          bannerVisible={false}
          maskClosable={false}
          photoClosable={false}
          pullClosable={item.kind !== "video"}
          maskOpacity={1}
          speed={(type) => (reducedMotion ? 0 : type === 2 ? 240 : 300)}
          overlayRender={(params) => {
            controls.current = params;
            return (
              <AlbumControls
                params={params}
                item={item}
                favorite={favorite}
                onFavorite={onFavorite}
                onDownload={onDownload}
                onCopyLink={onCopyLink}
                details={details}
                onDetails={() => setDetails((value) => !value)}
                size={sizes.get(item.path)}
                live={live.get(item.path) || item.live}
                livePlaying={livePlaying}
                onLive={() => setLivePlaying((value) => !value)}
              />
            );
          }}
        />
      )}
      {feedback}
    </Dialog>
  );
}

function AlbumControls({
  params,
  item,
  favorite,
  onFavorite,
  onDownload,
  onCopyLink,
  details,
  onDetails,
  size,
  live,
  livePlaying,
  onLive,
}) {
  const root = useRef(null);
  const closeButton = useRef(null);
  useLayoutEffect(() => {
    // Native Dialog owns modal semantics, focus containment and background inertness.
    root.current.closest(".PhotoView-Portal")?.removeAttribute("role");
    closeButton.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={root}
      class="album-viewer-controls"
      inert={params.visible ? undefined : true}
    >
      <header class="album-viewer-header">
        <button
          ref={closeButton}
          class="icon-button edge-start"
          onClick={params.onClose}
          aria-label={t("library.closePreview")}
        >
          <Icon name="x" />
        </button>
        <strong id="album-viewer-name">{item.name}</strong>
        <button class="icon-button" aria-label={t("library.copyLink")} onClick={() => onCopyLink(item)}><Icon name="copy" /></button>
        {live && (
          <span class="album-live-label" aria-label={t("library.livePhoto")}>
            <Icon name="live" /> LIVE
          </span>
        )}
        <span class="album-viewer-counter" aria-live="polite">
          {params.index + 1} / {params.images.length}
        </span>
      </header>
      <nav class="album-viewer-pager" aria-label={t("library.albumPaging")}>
        <button
          class="icon-button"
          disabled={params.index === 0}
          aria-label={t("library.previousMedia")}
          onClick={() => params.onIndexChange(params.index - 1)}
        >
          <Icon name="chevron-left" />
        </button>
        <button
          class="icon-button"
          disabled={params.index === params.images.length - 1}
          aria-label={t("library.nextMedia")}
          onClick={() => params.onIndexChange(params.index + 1)}
        >
          <Icon name="chevron-right" />
        </button>
      </nav>
      <footer class="album-viewer-actions">
        {live && (
          <button
            data-live-action
            class="icon-button"
            aria-label={t(
              livePlaying ? "library.stopLivePhoto" : "library.playLivePhoto",
            )}
            aria-pressed={livePlaying}
            onClick={onLive}
          >
            <Icon name="live" />
          </button>
        )}
        <button
          class="icon-button"
          aria-label={
            favorite ? t("library.unfavoriteFile") : t("library.favoriteFile")
          }
          aria-pressed={favorite}
          onClick={() => onFavorite(item)}
        >
          <Icon name="star" />
        </button>
        {item.kind === "image" && (
          <>
            <button
              class="icon-button"
              aria-label={t("library.zoomOut")}
              disabled={params.scale <= 1}
              onClick={() => params.onScale(Math.max(1, params.scale - 1))}
            >
              <Icon name="zoom-out" />
            </button>
            <button
              class="icon-button"
              aria-label={t("library.zoomIn")}
              disabled={params.scale >= 6}
              onClick={() => params.onScale(Math.min(6, params.scale + 1))}
            >
              <Icon name="zoom-in" />
            </button>
          </>
        )}
        <button
          class="icon-button"
          aria-label={t("library.download")}
          onClick={() => onDownload(item)}
        >
          <Icon name="download" />
        </button>
        <button
          class="icon-button"
          aria-label={t("library.mediaDetails")}
          aria-expanded={details}
          aria-controls="album-viewer-details"
          onClick={onDetails}
        >
          <Icon name="info" />
        </button>
      </footer>
      {details && (
        <section
          id="album-viewer-details"
          class="album-viewer-details"
          aria-label={t("library.mediaDetails")}
        >
          <dl class="file-details">
            <div>
              <dt>{t("library.type")}</dt>
              <dd>{item.mime || item.name.split(".").pop().toUpperCase()}</dd>
            </div>
            <div>
              <dt>{t("library.size")}</dt>
              <dd>{bytes(item.size)}</dd>
            </div>
            {size?.width > 0 && (
              <div>
                <dt>{t("library.dimensions")}</dt>
                <dd>
                  {size.width} × {size.height}
                </dd>
              </div>
            )}
            <div>
              <dt>{t("library.modifiedAt")}</dt>
              <dd>{date(item.modified, true)}</dd>
            </div>
          </dl>
        </section>
      )}
    </div>
  );
}
