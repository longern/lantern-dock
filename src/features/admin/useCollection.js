import { useEffect, useState } from "preact/hooks";

export function useCollection(
  client,
  kind,
  linkId,
  revision,
  onError,
  { source = "", query = "", enabled = false } = {},
) {
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState({
    status: "loading",
    items: [],
    nextOffset: null,
  });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", items: [], nextOffset: null });
    const request =
      kind === "links"
        ? client.links({ offset, signal: controller.signal })
        : kind === "users"
          ? client.users({ offset, query, enabled, signal: controller.signal })
          : client.inbox({ offset, linkId, source, signal: controller.signal });
    request.then(
      (value) => {
        if (!controller.signal.aborted) setState({ status: "ready", ...value });
      },
      (error) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", items: [], nextOffset: null, error });
        onError(error);
      },
    );
    return () => controller.abort();
  }, [client, kind, linkId, offset, revision, onError, source, query, enabled]);
  return { ...state, offset, setOffset };
}
