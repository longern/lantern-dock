import { useEffect, useRef, useState } from "preact/hooks";

let observer;
const targets = new WeakMap();
function observe(node, ready) {
  if (!globalThis.IntersectionObserver) {
    ready(true);
    return () => {};
  }
  observer ||= new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        targets.get(entry.target)?.(entry.isIntersecting);
    },
    { rootMargin: "160px" },
  );
  targets.set(node, ready);
  observer.observe(node);
  return () => {
    targets.delete(node);
    observer.unobserve(node);
  };
}
export function Thumbnail({ item, client, side }) {
  const element = useRef(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState(null);
  useEffect(() => observe(element.current, setVisible), []);
  useEffect(() => {
    if (!visible || !client?.images) {
      setSource(null);
      return;
    }
    const controller = new AbortController();
    let url;
    const display = (image) => {
      if (!image || controller.signal.aborted) return;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(image.blob);
      setSource(url);
    };
    setSource(null);
    display(client.images.peek(item, side));
    client.images.image(item, side, controller.signal).then(display, () => {
      if (!controller.signal.aborted) {
        if (url) URL.revokeObjectURL(url);
        url = null;
        setSource(null);
      }
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [
    visible,
    item.path,
    item.etag,
    item.modified,
    item.size,
    client,
    side,
    client?.images?.revision,
  ]);
  return (
    <span ref={element} class="thumbnail-slot" aria-hidden="true">
      {source && (
        <img
          src={source}
          alt=""
          decoding="async"
          onError={() => setSource(null)}
        />
      )}
    </span>
  );
}
