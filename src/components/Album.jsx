import { t } from "../../shared/i18n.js";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { Thumbnail } from "./Thumbnail.jsx";
import { artwork } from "../lib/demo.js";
import { groupMediaByDate } from "../lib/album.js";

export function Album({ entries, loading, demo, client, selected, onPreview }) {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    let timer;
    const refreshDate = () => {
      const now = new Date();
      setToday(now);
      clearTimeout(timer);
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(refreshDate, midnight.getTime() - now.getTime() + 100);
    };
    refreshDate();
    document.addEventListener("visibilitychange", refreshDate);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshDate);
    };
  }, []);
  const groups = useMemo(() => groupMediaByDate(entries, today), [entries, today]);
  if (loading && !entries.length)
    return (
      <div class="file-grid album-layout">
        {Array.from({ length: 12 }, (_, index) => <div class="skeleton" key={index} />)}
      </div>
    );
  return groups.map((group) => (
    <section class="album-group" key={group.key} aria-labelledby={`album-date-${group.key}`}>
      <h2 class="album-date" id={`album-date-${group.key}`}>
        {group.key === "unknown" ? group.label : <time dateTime={group.key}>{group.label}</time>}
      </h2>
      <div class="file-grid album-layout">
        {group.items.map((item) => (
          <article class="file-card album-item" key={item.path}>
            <button
              class="file-open album-preview"
              data-path={item.path}
              aria-label={t(item.kind === "video" ? "library.previewVideoNamed" : "library.previewNamed", { name: item.name })}
              aria-pressed={selected?.path === item.path}
              onClick={() => onPreview(item)}
            >
              {demo && item.kind === "image" ? (
                <img
                  src={`data:image/svg+xml,${encodeURIComponent(artwork(item.name))}`}
                  alt=""
                  decoding="async"
                />
              ) : (
                <Thumbnail item={item} client={client} side={384} fallback={<Icon name={item.kind} />} />
              )}
              {item.kind === "video" && (
                <span class="album-video-indicator" aria-hidden="true"><Icon name="play" /></span>
              )}
            </button>
          </article>
        ))}
      </div>
    </section>
  ));
}
