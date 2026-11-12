import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../../../../shared/i18n.js";
import { createLiveVideoSource } from "../../../lib/live.js";
import { unsupportedVideo } from "../../../lib/video.js";

// Observe pointers without consuming the gallery's swipe/pinch events.
export function LivePhoto({ client, live, requested, onStop, target }) {
  const player = useRef(null);
  const control = useRef({});
  const [held, setHeld] = useState(false);
  const [started, setStarted] = useState(false);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(null);
  const wanted = held || requested;
  const hideLoading = playing && !error;
  const loadingLabel = t("library.loadingLivePhoto");
  const state = useRef(null);
  state.current = { wanted, onStop };
  const stop = () => {
    state.current.wanted = false;
    player.current?.pause();
    setHeld(false);
    setPlaying(false);
    state.current.onStop();
  };
  control.current.stop = stop;

  useEffect(() => {
    const element = target.current;
    let pointer, timer;
    const cancel = () => {
      clearTimeout(timer);
      pointer = null;
      control.current.stop();
    };
    const down = (event) => {
      if (event.button !== 0 || !event.isPrimary || pointer) {
        cancel();
        return;
      }
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      timer = setTimeout(() => setHeld(true), 250);
    };
    const move = (event) => {
      if (
        pointer &&
        event.pointerId === pointer.id &&
        Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 10
      )
        cancel();
    };
    const up = (event) => {
      if (pointer && pointer.id === event.pointerId) cancel();
    };
    const multiple = (event) => {
      if (!event.isPrimary) cancel();
    };
    const context = (event) => event.preventDefault();
    const visibility = () => {
      if (document.hidden) cancel();
    };
    element.addEventListener("pointerdown", down);
    element.addEventListener("contextmenu", context);
    window.addEventListener("pointerdown", multiple);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearTimeout(timer);
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("contextmenu", context);
      window.removeEventListener("pointerdown", multiple);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [target]);

  useEffect(() => {
    if (wanted) setStarted(true);
  }, [wanted]);
  useLayoutEffect(() => {
    if (!started) return;
    const element = player.current;
    const controller = new AbortController();
    let connection;
    const fail = () => {
      if (controller.signal.aborted) return;
      setError(unsupportedVideo);
      control.current.stop();
      controller.abort();
      element.pause();
      element.removeAttribute("src");
      element.load();
      connection?.dispose();
    };
    control.current.fail = fail;
    setProgress(null);
    createLiveVideoSource(
      client,
      live,
      controller.signal,
      (received, total) => {
        if (!controller.signal.aborted)
          setProgress(Math.min(100, Math.floor((received / total) * 100)));
      },
    ).then((source) => {
      if (controller.signal.aborted) {
        source.dispose();
        return;
      }
      connection = source;
      try {
        source.attach(element, fail);
        setReady(true);
      } catch {
        fail();
      }
    }, fail);
    return () => {
      controller.abort();
      element.pause();
      element.removeAttribute("src");
      element.load();
      connection?.dispose();
    };
  }, [started, client, live]);

  useLayoutEffect(() => {
    const element = player.current;
    let timer;
    if (wanted && ready && !error) {
      element.play().catch(() => {
        if (state.current.wanted) control.current.fail?.();
      });
    } else {
      element.pause();
      setPlaying(false);
      // Keep the last frame during the fade back to the still image.
      timer = setTimeout(() => {
        if (element.readyState) element.currentTime = 0;
      }, 160);
    }
    return () => clearTimeout(timer);
  }, [wanted, ready, error]);

  return (
    <>
      <video
        ref={player}
        class={`album-live-video${playing && wanted ? " is-playing" : ""}`}
        muted
        playsInline
        preload="metadata"
        aria-hidden="true"
        onPlaying={() => {
          if (state.current.wanted) setPlaying(true);
          else player.current.pause();
        }}
        onEnded={stop}
        onError={() => {
          if (player.current.error?.code > 1) control.current.fail?.();
        }}
      />
      {(error || wanted) && (
        <span
          class={`album-live-status${hideLoading ? " is-fading" : ""}`}
          role="status"
          aria-hidden={hideLoading || undefined}
        >
          {error || loadingLabel}
          {!error &&
            (progress === null ? (
              <span class="album-live-spinner" aria-hidden="true" />
            ) : (
              <svg
                class="album-live-progress"
                viewBox="0 0 16 16"
                role="progressbar"
                aria-label={loadingLabel}
                aria-valuenow={progress}
              >
                <circle cx="8" cy="8" r="6.5" />
                <circle
                  cx="8"
                  cy="8"
                  r="6.5"
                  pathLength="100"
                  stroke-dasharray="100"
                  stroke-dashoffset={100 - progress}
                />
              </svg>
            ))}
        </span>
      )}
    </>
  );
}
