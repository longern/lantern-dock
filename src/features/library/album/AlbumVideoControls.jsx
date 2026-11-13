import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../../../../shared/i18n.js";
import { Icon } from "../../../components/Icon.jsx";

export const videoRates = [0.5, 0.75, 1, 1.25, 1.5, 2];
const mediaEvents = [
  "durationchange",
  "emptied",
  "ended",
  "error",
  "pause",
  "play",
  "ratechange",
  "seeked",
  "timeupdate",
  "volumechange",
];

export function useAlbumVideo(player) {
  const [state, setState] = useState(null);
  const pendingSeek = useRef(null);
  useLayoutEffect(() => {
    pendingSeek.current = null;
    if (!player) return;
    const sync = (event) => {
      if (
        (event?.type === "seeked" && !player.seeking) ||
        event?.type === "emptied" ||
        event?.type === "error"
      )
        pendingSeek.current = null;
      const duration = Number.isFinite(player.duration) ? player.duration : 0;
      setState({
        player,
        duration,
        time: clampTime(pendingSeek.current ?? player.currentTime, duration),
        playing: !player.paused && !player.ended && !player.error,
        muted: player.muted || player.volume === 0,
        rate: player.playbackRate,
      });
    };
    sync();
    for (const event of mediaEvents) player.addEventListener(event, sync);
    return () => {
      for (const event of mediaEvents) player.removeEventListener(event, sync);
    };
  }, [player]);
  if (!player || state?.player !== player) return null;
  return {
    ...state,
    currentTime: () => pendingSeek.current ?? player.currentTime,
    seek(target) {
      if (target === player.currentTime && !player.seeking) return;
      player.currentTime = target;
      // Keep the requested position visible while the player buffers a seek.
      pendingSeek.current = target;
      setState((previous) => ({ ...previous, time: target }));
    },
  };
}

const clampTime = (time, duration) => Math.max(0, Math.min(duration, time));

function timestamp(seconds) {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = String(whole % 60).padStart(2, "0");
  if (minutes < 60) return `${minutes}:${rest}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${rest}`;
}

export function AlbumVideoControls({ video }) {
  const { player, duration, time, playing, muted, currentTime, seek } = video;
  const togglePlayback = () => {
    if (playing) player.pause();
    else void player.play().catch(() => {});
  };
  const toggleMute = () => {
    if (muted && player.volume === 0) player.volume = 1;
    player.muted = !muted;
  };
  return (
    <div
      class="album-video-controls"
      role="group"
      aria-label={t("library.videoControls")}
    >
      <button
        type="button"
        class="icon-button"
        aria-label={t(playing ? "library.pauseVideo" : "library.playVideo")}
        onClick={togglePlayback}
      >
        <Icon name={playing ? "pause" : "play"} />
      </button>
      <VideoTimeline
        time={time}
        duration={duration}
        currentTime={currentTime}
        seek={seek}
      />
      <button
        type="button"
        class="icon-button"
        aria-label={t(muted ? "library.unmuteVideo" : "library.muteVideo")}
        onClick={toggleMute}
      >
        <Icon name={muted ? "volume-x" : "volume"} />
      </button>
    </div>
  );
}

function VideoTimeline({ time, duration, currentTime, seek }) {
  const gesture = useRef(null);
  const track = useRef(null);
  const [preview, setPreview] = useState(null);
  const start = (event) => {
    if (!duration || !event.isPrimary || event.button !== 0 || gesture.current)
      return;
    const { left, width } = track.current.getBoundingClientRect();
    if (!width) return;
    gesture.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: clampTime(currentTime(), duration),
      left,
      width,
      mode: "tap",
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPreview(gesture.current.time);
  };
  const target = (event, press) => {
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (press.mode === "tap" && Math.max(Math.abs(dx), Math.abs(dy)) >= 5)
      press.mode = Math.abs(dx) >= Math.abs(dy) ? "drag" : "cancel";
    if (press.mode === "drag")
      return clampTime(press.time + (dx / press.width) * duration, duration);
    if (press.mode === "tap")
      return clampTime(
        ((event.clientX - press.left) / press.width) * duration,
        duration,
      );
    return null;
  };
  const move = (event) => {
    const press = gesture.current;
    if (press?.id !== event.pointerId) return;
    const next = target(event, press);
    if (press.mode === "drag") setPreview(next);
  };
  const finish = (event, commit) => {
    const press = gesture.current;
    if (press?.id !== event.pointerId) return;
    gesture.current = null;
    setPreview(null);
    if (!commit) return;
    const next = target(event, press);
    if (next !== null) seek(next);
  };
  const keyboard = (event) => {
    const offsets = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 };
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? duration
          : currentTime() + offsets[event.key];
    if (!duration || !Number.isFinite(next)) return;
    event.preventDefault();
    event.stopPropagation();
    seek(clampTime(next, duration));
  };
  const shown = preview ?? time;
  const progress = duration ? (shown / duration) * 100 : 0;
  return (
    <div
      class="album-video-timeline"
      role="slider"
      tabIndex={duration ? 0 : -1}
      aria-disabled={duration ? undefined : true}
      aria-label={t("library.videoProgress")}
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={shown}
      aria-valuetext={t("library.videoProgressTime", {
        time: timestamp(shown),
        duration: timestamp(duration),
      })}
      data-scrubbing={preview === null ? undefined : ""}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onLostPointerCapture={(event) => finish(event, false)}
      onKeyDown={keyboard}
    >
      <span
        ref={track}
        class="album-video-track"
        style={{ "--progress": `${progress}%` }}
      >
        {preview !== null && (
          <span class="album-video-target" aria-hidden="true">
            {timestamp(shown)}
          </span>
        )}
      </span>
    </div>
  );
}
