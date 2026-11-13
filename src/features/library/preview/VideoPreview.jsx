import { t } from "../../../../shared/i18n.js";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { prepareVideoSource, unsupportedVideo } from "../../../lib/video.js";
import { decodeImage } from "../../../lib/image-preview.js";
import { afterOverlayEntry } from "../../../lib/overlay-entry.js";
import { Icon } from "../../../components/Icon.jsx";

export function VideoPreview({
  item,
  client,
  open,
  playOnRequest = false,
  retainOnClose = false,
  closingThumbnail,
  onCoverReady,
  onDimensions,
  onError,
  onPlayer,
}) {
  const player = useRef(null);
  const start = useRef(null);
  const report = useRef(null);
  const playback = useRef(null);
  playback.current = { open, closingThumbnail, onDimensions };
  const attached = open || retainOnClose;
  const [ready, setReady] = useState(false);
  const [poster, setPoster] = useState(null);
  const [largePoster, setLargePoster] = useState(null);
  const [largePosterUnavailable, setLargePosterUnavailable] = useState(false);
  const [starting, setStarting] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [error, setError] = useState("");
  const sharpCover = useRef(null);
  const controlsReady = ready && !error && (!playOnRequest || hasFrame);
  useLayoutEffect(() => {
    if (!controlsReady || !onPlayer) return;
    onPlayer(player.current);
    return () => onPlayer(null);
  }, [controlsReady, onPlayer]);

  useLayoutEffect(() => {
    if (!playback.current.open) return;
    const element = player.current;
    const controller = new AbortController();
    let connection, pending;
    const stop = () => {
      controller.abort();
      if (connection) {
        element.pause();
        element.removeAttribute("src");
        element.load();
        connection.dispose();
        connection = null;
      }
    };
    const fail = (reason) => {
      if (controller.signal.aborted || !playback.current.open) return;
      setStarting(false);
      setError(reason.message);
      onError(reason.message);
      stop();
    };
    report.current = fail;
    setReady(false);
    setStarting(false);
    setHasFrame(false);
    setError("");
    const connect = (value) => {
      if (controller.signal.aborted || !playback.current.open) {
        value.dispose();
        return false;
      }
      connection = value;
      value.attach(element, fail);
      setReady(true);
      return true;
    };
    start.current = async () => {
      if (!playback.current.open || controller.signal.aborted || pending)
        return;
      pending = true;
      if (playOnRequest) setStarting(true);
      try {
        if (!connection) {
          const source = prepareVideoSource(client, item, controller.signal);
          // Native playback can attach and play within the original click.
          if (!connect(source.mode === "direct" ? source : await source))
            return;
        }
        if (playOnRequest) await element.play();
      } catch (reason) {
        // A browser can require another gesture after an async MSE setup.
        if (reason.name !== "NotAllowedError" || !connection) fail(reason);
      } finally {
        pending = false;
        if (!controller.signal.aborted && playback.current.open)
          setStarting(false);
      }
    };
    if (!playOnRequest) void start.current();
    return stop;
  }, [item, client, attached, playOnRequest]);

  useLayoutEffect(() => {
    if (!playback.current.open) return;
    const controller = new AbortController();
    const { signal } = controller;
    let posterURL, largePosterURL;
    setPoster(null);
    setLargePoster(null);
    setLargePosterUnavailable(false);
    const loadPoster = async () => {
      const thumbnail = playback.current.closingThumbnail;
      // The grid can revoke its Blob URL while the preview is still open.
      const gridImage = thumbnail?.startsWith("blob:")
        ? await fetch(thumbnail, { signal })
            .then((response) => response.blob())
            .catch(() => null)
        : null;
      if (signal.aborted) return;
      const blob =
        gridImage || (await client.images?.image(item, 384, signal))?.blob;
      if (!blob || signal.aborted) return;
      posterURL = URL.createObjectURL(blob);
      if (playOnRequest) await decodeImage(posterURL, signal);
      setPoster(posterURL);
    };
    void loadPoster().catch(() => {});
    if (playOnRequest) {
      void (async () => {
        const image = await client.images?.image(item, 1600, signal);
        if (signal.aborted) return;
        if (!image) {
          setLargePosterUnavailable(true);
          return;
        }
        largePosterURL = URL.createObjectURL(image.blob);
        await decodeImage(largePosterURL, signal);
        setLargePoster(largePosterURL);
        if (playback.current.open && !player.current?.videoWidth)
          playback.current.onDimensions(image.width, image.height);
      })().catch(() => {
        if (!signal.aborted) setLargePosterUnavailable(true);
      });
    }
    return () => {
      controller.abort();
      if (posterURL) URL.revokeObjectURL(posterURL);
      if (largePosterURL) URL.revokeObjectURL(largePosterURL);
    };
  }, [item, client, attached, playOnRequest]);
  useLayoutEffect(() => {
    if (!open) player.current?.pause();
  }, [open]);
  const showCover = playOnRequest && !hasFrame;
  const cover = poster || closingThumbnail;
  useLayoutEffect(() => {
    if (!open || !onCoverReady) return;
    if (hasFrame || (largePosterUnavailable && poster)) {
      onCoverReady(true);
    } else if (largePoster && sharpCover.current) {
      return afterOverlayEntry(sharpCover.current, () => onCoverReady(true));
    }
  }, [
    open,
    onCoverReady,
    hasFrame,
    largePosterUnavailable,
    poster,
    largePoster,
  ]);
  const playButton = useRef(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!open || starting || !restoreFocus.current) return;
    restoreFocus.current = false;
    const dialog = player.current.closest("dialog");
    const frame = requestAnimationFrame(() => {
      if (
        document.activeElement === document.body ||
        document.activeElement === dialog
      )
        (
          playButton.current ||
          dialog?.querySelector(".album-video-controls button")
        )?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, starting, hasFrame]);
  return (
    <>
      {showCover && (
        <div
          class="album-video-cover"
          data-lifted={onCoverReady ? "" : undefined}
        >
          {cover && <img src={cover} alt="" draggable={false} />}
          {largePoster && (
            <img
              ref={sharpCover}
              class="album-video-cover-sharp"
              src={largePoster}
              alt=""
              draggable={false}
            />
          )}
        </div>
      )}
      {open && showCover && !starting && !error && (
        <button
          ref={playButton}
          type="button"
          class="icon-button album-video-play"
          aria-label={t("library.playVideo")}
          onClick={(event) => {
            restoreFocus.current =
              event.currentTarget.matches(":focus-visible");
            void start.current?.();
          }}
        >
          <Icon name="play" />
        </button>
      )}
      {(error || (!playOnRequest && !ready)) && (
        <div class="preview-placeholder">
          <Icon name="video" />
          <p role="status">{error || t("library.loadingVideo")}</p>
        </div>
      )}
      {playOnRequest && open && showCover && starting && (
        <span
          class="album-video-loading"
          role="status"
          aria-label={t("library.loadingVideo")}
        />
      )}
      <video
        ref={player}
        hidden={!!error || !ready}
        data-waiting-for-frame={showCover ? "" : undefined}
        poster={poster || undefined}
        controls={!onPlayer}
        tabIndex={onPlayer ? -1 : undefined}
        playsInline
        preload="metadata"
        onPlaying={() => {
          if (playback.current.open) setHasFrame(true);
        }}
        aria-label={t("library.videoPreviewNamed", { name: item.name })}
        onLoadedMetadata={(event) => {
          if (!open) return;
          onDimensions(
            event.currentTarget.videoWidth,
            event.currentTarget.videoHeight,
          );
        }}
        onError={(event) => {
          const code = event.currentTarget.error?.code;
          if (!open || !code || code === 1) return;
          report.current?.(
            new Error(
              code === 3 || code === 4
                ? unsupportedVideo
                : t("library.videoLoadFailed"),
            ),
          );
        }}
      />
      {retainOnClose && cover && (hasFrame || largePoster) && (
        <img
          class="album-video-exit-thumbnail"
          src={cover}
          alt=""
          draggable={false}
        />
      )}
    </>
  );
}
