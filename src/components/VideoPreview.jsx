import { t } from "../../shared/i18n.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { createVideoSource, unsupportedVideo } from "../lib/video.js";
import { Icon } from "./Icon.jsx";

export function VideoPreview({ item, client, open, onDimensions, onError }) {
  const player = useRef(null);
  const report = useRef(null);
  const [ready, setReady] = useState(false);
  const [poster, setPoster] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let connection, posterURL;
    const stop = () => {
      controller.abort();
      player.current?.pause();
      if (player.current) {
        player.current.removeAttribute("src");
        player.current.load();
      }
      connection?.dispose();
      if (posterURL) {
        URL.revokeObjectURL(posterURL);
        posterURL = null;
      }
    };
    const fail = (reason) => {
      if (controller.signal.aborted) return;
      setError(reason.message);
      onError(reason.message);
      stop();
    };
    report.current = fail;
    setReady(false);
    setPoster(null);
    setError("");
    createVideoSource(client, item, controller.signal).then((value) => {
      if (controller.signal.aborted) {
        value.dispose();
        return;
      }
      connection = value;
      try {
        value.attach(player.current, fail);
        setReady(true);
      } catch (reason) {
        fail(reason);
      }
    }, fail);
    // Playback never waits for the optional server-generated poster.
    client.images?.image(item, 384, controller.signal).then(
      (image) => {
        if (!image || controller.signal.aborted) return;
        posterURL = URL.createObjectURL(image.blob);
        setPoster(posterURL);
      },
      () => {},
    );
    return stop;
  }, [item, client, open]);
  return (
    <>
      {(error || !ready) && (
        <div class="preview-placeholder">
          <Icon name="video" />
          <p role="status">{error || t("library.loadingVideo")}</p>
        </div>
      )}
      <video
        ref={player}
        hidden={!!error || !ready}
        poster={poster || undefined}
        controls
        playsInline
        preload="metadata"
        aria-label={t("library.videoPreviewNamed", { name: item.name })}
        onLoadedMetadata={(event) =>
          onDimensions(
            event.currentTarget.videoWidth,
            event.currentTarget.videoHeight,
          )
        }
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
    </>
  );
}
