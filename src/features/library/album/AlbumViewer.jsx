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
import { t } from "../../../../shared/i18n.js";
import {
  useCompactLayout,
  useReducedMotion,
} from "../../../hooks/useMediaQuery.js";
import { AlbumMedia } from "./AlbumMedia.jsx";
import { AlbumShareDialog } from "./AlbumShareDialog.jsx";
import { FileInfoDrawer } from "../preview/FileInfoDrawer.jsx";
import { PreviewMetadata } from "../preview/PreviewMetadata.jsx";
import {
  liftAlbumThumbnail,
  positionAlbumOrigin,
  revealAlbumTile,
  visibleAlbumOrigin,
} from "./album-thumbnail-transition.jsx";
import {
  AlbumVideoControls,
  useAlbumVideo,
  videoRates,
} from "./AlbumVideoControls.jsx";
import { Dialog } from "../../../components/Dialog.jsx";
import { Icon } from "../../../components/Icon.jsx";
import { Menu } from "../../../components/Menu.jsx";
import { useLiveMedia } from "../../../hooks/useLiveMedia.js";
import { dialogHeadingFocus } from "../../../lib/overlay-focus.js";

const detailsId = "album-viewer-details";

function fitAlbumMedia(width, height, viewportWidth, viewportHeight) {
  const ratio = width > 0 && height > 0 ? width / height : 1;
  const fittedWidth = Math.min(viewportWidth, viewportHeight * ratio);
  return { width: fittedWidth, height: fittedWidth / ratio };
}

export function AlbumViewer({
  gallery,
  item,
  client,
  open,
  onSelect,
  favorite,
  onFavorite,
  onDownload,
  shareURL,
  toast,
  onClose,
  onExited,
  returnTarget,
  feedback,
}) {
  const [container, setContainer] = useState(null);
  const [entered, setEntered] = useState(false);
  const [details, setDetails] = useState(null);
  const [sharing, setSharing] = useState(null);
  const [livePlaying, setLivePlaying] = useState(false);
  const [videoPlayer, setVideoPlayer] = useState(null);
  const [initialPath] = useState(item.path);
  const live = useLiveMedia(client, gallery.items);
  const stopLive = useCallback(() => setLivePlaying(false), []);
  const [viewport, setViewport] = useState({
    width: innerWidth,
    height: innerHeight,
  });
  const reducedMotion = useReducedMotion();
  const compact = useCompactLayout();
  const [lifetime] = useState(() => new AbortController());
  const [openingThumbnail, setOpeningThumbnail] = useState(null);
  const containerRef = useRef(null);
  containerRef.current = container;
  const thumbnailTransition = useRef(null);
  const releaseThumbnail = useCallback(() => {
    thumbnailTransition.current?.();
    thumbnailTransition.current = null;
    setOpeningThumbnail(null);
  }, []);
  const prepareThumbnail = () => {
    if (reducedMotion) return;
    const tile = gallery.findTile?.(item.path);
    const origin = visibleAlbumOrigin(tile);
    const image = origin?.tagName === "IMG" ? origin : null;
    if (!image?.complete || !image.naturalWidth) return;
    const transition = liftAlbumThumbnail(
      image,
      () => containerRef.current,
      releaseThumbnail,
    );
    if (!transition) return;
    thumbnailTransition.current = transition.release;
    setOpeningThumbnail({ path: item.path, ...transition });
  };
  const [snapshots] = useState(
    () =>
      new Map(
        gallery.items.map((entry) => {
          const origin = visibleAlbumOrigin(gallery.findTile?.(entry.path));
          const image = origin?.tagName === "IMG" ? origin : null;
          const cached =
            client.images?.peek(entry, 384) || client.images?.peek(entry, 1600);
          return [
            entry.path,
            {
              thumbnail:
                image?.complete && image.naturalWidth ? image.currentSrc : "",
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
  const exitOrigin = useRef(null);
  const exitRect = useRef(null);
  const exitTile = useRef(null);
  const index = gallery.items.findIndex((entry) => entry.path === item.path);
  useLayoutEffect(() => setLivePlaying(false), [index, open]);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    if (!reducedMotion) {
      exitTile.current = gallery.findTile?.(item.path);
      exitRect.current = revealAlbumTile(exitTile.current);
    }
    lifetime.abort();
    callbacks.current.onClose();
  }, [gallery, item.path, lifetime, reducedMotion]);

  useLayoutEffect(() => () => lifetime.abort(), [lifetime]);
  useLayoutEffect(() => () => thumbnailTransition.current?.(), []);
  useLayoutEffect(() => {
    if (openingThumbnail && item.path !== openingThumbnail.path)
      releaseThumbnail();
  }, [item.path, openingThumbnail, releaseThumbnail]);
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
        const motionPhoto = live.get(entry.path) || entry.live;
        const indicatorKind =
          entry.kind === "video" ? "video" : motionPhoto ? "live" : null;
        const tile =
          !reducedMotion && indicatorKind && index === position
            ? (open ? null : exitTile.current) || gallery.findTile?.(entry.path)
            : null;
        const originImage = tile ? visibleAlbumOrigin(tile) : null;
        const videoThumbnail =
          originImage?.tagName === "IMG" &&
          originImage.complete &&
          originImage.naturalWidth
            ? originImage.currentSrc
            : snapshots.get(entry.path)?.thumbnail;
        const lifted =
          openingThumbnail?.path === entry.path ? openingThumbnail : null;
        const size =
          (entry.kind === "image" && lifted) || sizes.get(entry.path) || {};
        const fitted = fitAlbumMedia(
          size.width,
          size.height,
          viewport.width,
          viewport.height,
        );
        const indicatorWidth = tile
          ? open
            ? !entered &&
              initialPath === entry.path &&
              (lifted || originImage?.tagName === "IMG") &&
              tile.querySelector(".album-indicator")
              ? tile.getBoundingClientRect().width
              : 0
            : exitRect.current?.width || tile.getBoundingClientRect().width
          : 0;
        return {
          key: entry.path,
          ...fitted,
          originRef: reducedMotion
            ? undefined
            : {
                get current() {
                  const tile = gallery.findTile?.(entry.path);
                  if (position === index && (!open || closing.current)) {
                    const rect = exitRect.current ?? revealAlbumTile(tile);
                    if (rect && exitOrigin.current) {
                      positionAlbumOrigin(exitOrigin.current, rect);
                      return exitOrigin.current;
                    }
                  }
                  return lifted?.originRef.current || visibleAlbumOrigin(tile);
                },
              },
          render: ({ attrs, scale }) => (
            <AlbumMedia
              attrs={attrs}
              scale={scale}
              fitted={fitted}
              item={entry}
              client={client}
              thumbnail={snapshots.get(entry.path)?.thumbnail}
              returningToTile={
                entry.kind === "image" &&
                index === position &&
                !open &&
                !reducedMotion &&
                !!(exitRect.current || gallery.findTile?.(entry.path))
              }
              videoThumbnail={videoThumbnail}
              indicator={
                indicatorWidth
                  ? { kind: indicatorKind, tile, width: indicatorWidth }
                  : undefined
              }
              thumbnailLayer={lifted?.picture}
              indicatorLayer={lifted?.indicatorLayer}
              onThumbnailSettled={releaseThumbnail}
              active={index === position}
              open={open}
              entered={entered}
              signal={lifetime.signal}
              onSize={onSize}
              live={motionPhoto}
              liveRequested={index === position && livePlaying}
              onLiveStop={stopLive}
              onVideoPlayer={setVideoPlayer}
            />
          ),
        };
      }),
    [
      gallery,
      client,
      index,
      initialPath,
      open,
      entered,
      sizes,
      viewport,
      snapshots,
      openingThumbnail,
      releaseThumbnail,
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
    setDetails(null);
    callbacks.current.onSelect(gallery.items[next]);
  };
  const keyboard = (event) => {
    if (event.target.closest("dialog") !== event.currentTarget) return;
    if (event.target.closest('[role="menu"]')) return;
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      if (details === "panel") setDetails(null);
      else close();
    } else if (event.target.closest("video, input, textarea, select")) {
      if (event.key.startsWith("Arrow")) event.stopPropagation();
    } else if (event.target.closest('[role="slider"]')) {
      // Let the timeline handle its keys before they reach the gallery.
      return;
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
  const size = sizes.get(item.path);
  const dimensions = size?.width > 0 ? `${size.width} × ${size.height}` : "";
  const showDetails = details === (compact ? "drawer" : "panel");
  return (
    <Dialog
      id="album-viewer"
      class="album-viewer"
      data-opening-thumbnail={
        openingThumbnail?.path === item.path ? "" : undefined
      }
      open={open}
      modal
      aria-labelledby="album-viewer-title"
      onClose={close}
      onBeforeOpen={prepareThumbnail}
      onExited={() => {
        releaseThumbnail();
        onExited?.();
      }}
      returnTarget={returnTarget}
      fallbackFocus=".main-area #file-list"
      onKeyDownCapture={keyboard}
    >
      <h2
        id="album-viewer-title"
        class="visually-hidden"
        {...dialogHeadingFocus}
      >
        {item.name}
      </h2>
      <img ref={exitOrigin} class="album-thumbnail-transition-origin" alt="" />
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
          pullClosable
          maskOpacity={1}
          speed={(type) => (reducedMotion ? 0 : type === 2 ? 240 : 300)}
          overlayRender={(params) => {
            controls.current = params;
            return (
              <AlbumControls
                showZoomControls={!compact}
                params={params}
                item={item}
                favorite={favorite}
                onFavorite={onFavorite}
                onDownload={onDownload}
                onShare={() => setSharing("open")}
                sharing={sharing === "open"}
                detailsDrawer={compact}
                details={showDetails}
                onDetails={() =>
                  setDetails(compact ? "drawer" : showDetails ? null : "panel")
                }
                dimensions={dimensions}
                live={live.get(item.path) || item.live}
                livePlaying={livePlaying}
                onLive={() => setLivePlaying((value) => !value)}
                videoPlayer={item.kind === "video" ? videoPlayer : null}
              />
            );
          }}
        />
      )}
      {(details === "drawer" || details === "closing") && (
        <FileInfoDrawer
          id={detailsId}
          open={open && compact && details === "drawer"}
          onClose={() => setDetails("closing")}
          onExited={() => setDetails(null)}
        >
          <PreviewMetadata item={item} dimensions={dimensions} />
        </FileInfoDrawer>
      )}
      {sharing && (
        <AlbumShareDialog
          key={item.path}
          item={item}
          client={client}
          url={shareURL}
          compact={compact}
          open={open && sharing === "open"}
          onClose={() => setSharing("closing")}
          onExited={() => setSharing(null)}
          toast={toast}
        />
      )}
      {feedback}
    </Dialog>
  );
}

function AlbumControls({
  showZoomControls,
  params,
  item,
  favorite,
  onFavorite,
  onDownload,
  onShare,
  sharing,
  detailsDrawer,
  details,
  onDetails,
  dimensions,
  live,
  livePlaying,
  onLive,
  videoPlayer,
}) {
  const root = useRef(null);
  const touchPress = useRef(null);
  const isVideo = item.kind === "video";
  const video = useAlbumVideo(videoPlayer);
  const endTouchPress = (event) => {
    const press = touchPress.current;
    if (press?.id !== event.pointerId) return;
    press.button.removeAttribute("data-touch-pressed");
    touchPress.current = null;
  };
  useLayoutEffect(() => {
    // Native Dialog owns modal semantics, focus containment and background inertness.
    root.current.closest(".PhotoView-Portal")?.removeAttribute("role");
  }, []);
  return (
    <div
      ref={root}
      class="album-viewer-controls"
      inert={!params.visible}
      onPointerDownCapture={(event) => {
        // Touch :active can be delayed, and a tablet can also have a mouse.
        if (event.pointerType !== "touch" || !event.isPrimary) return;
        const button = event.target.closest(".icon-button:enabled");
        if (!button || !event.currentTarget.contains(button)) return;
        touchPress.current?.button.removeAttribute("data-touch-pressed");
        touchPress.current = { id: event.pointerId, button };
        button.setAttribute("data-touch-pressed", "");
      }}
      onPointerUpCapture={endTouchPress}
      onPointerCancelCapture={endTouchPress}
      onLostPointerCapture={endTouchPress}
    >
      <header class="album-viewer-header">
        <button
          class="icon-button edge-start"
          onClick={params.onClose}
          aria-label={t("library.closePreview")}
        >
          <Icon name="chevron-left" />
        </button>
        <strong id="album-viewer-name">{item.name}</strong>
        {live && (
          <span class="album-live-label" aria-label={t("library.livePhoto")}>
            <Icon name="live" /> LIVE
          </span>
        )}
        <span class="album-viewer-counter" aria-live="polite">
          {params.index + 1} / {params.images.length}
        </span>
        {isVideo && !!video?.duration && (
          <Menu
            key={item.path}
            edge="end"
            label={t("library.videoOptions")}
            groups={[
              {
                key: "speed",
                label: t("library.videoPlaybackSpeed"),
                selected: video.rate,
                change: (rate) => {
                  video.player.playbackRate = rate;
                },
                options: videoRates.map((rate) => [rate, `${rate}×`]),
              },
            ]}
          />
        )}
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
      {isVideo && video && <AlbumVideoControls key={item.path} video={video} />}
      <footer
        class="album-viewer-actions"
        aria-label={t("library.fileActions")}
      >
        <button
          type="button"
          class="icon-button album-share-trigger"
          aria-label={t("library.share")}
          aria-haspopup="dialog"
          aria-expanded={sharing}
          aria-controls={sharing ? "album-share-dialog" : undefined}
          onClick={onShare}
        >
          <Icon name="share" />
        </button>
        {live && (
          <button
            class="icon-button album-live-toggle"
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
          class="icon-button album-favorite"
          aria-label={
            favorite ? t("library.unfavoriteFile") : t("library.favoriteFile")
          }
          aria-pressed={favorite}
          onClick={() => onFavorite(item)}
        >
          <Icon name={favorite ? "heart-filled" : "heart"} />
        </button>
        {item.kind === "image" && showZoomControls && (
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
          aria-haspopup={detailsDrawer ? "dialog" : undefined}
          aria-expanded={details}
          aria-controls={detailsId}
          onClick={onDetails}
        >
          <Icon name="info" />
        </button>
      </footer>
      {details && !detailsDrawer && (
        <section
          id={detailsId}
          class="album-viewer-details"
          aria-label={t("library.mediaDetails")}
        >
          <PreviewMetadata item={item} dimensions={dimensions} />
        </section>
      )}
    </div>
  );
}
