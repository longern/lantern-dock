import { useEffect, useState } from "preact/hooks";
import { fetchLiveMedia } from "../lib/live.js";

const empty = new Map();
export function useLiveMedia(client, entries) {
  const [state, setState] = useState(null);
  const revision = client?.images?.revision;
  useEffect(() => {
    const controller = new AbortController();
    const signal = client?.images?.lifetime
      ? AbortSignal.any([controller.signal, client.images.lifetime.signal])
      : controller.signal;
    fetchLiveMedia(client, entries, signal).then(
      (value) => {
        if (!signal.aborted) setState({ client, entries, revision, value });
      },
      () => {},
    );
    return () => controller.abort();
  }, [client, entries, revision]);
  return state &&
    state.client === client &&
    state.entries === entries &&
    state.revision === revision
    ? state.value
    : empty;
}
