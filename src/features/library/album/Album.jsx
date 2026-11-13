import { t } from "../../../../shared/i18n.js";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { Icon } from "../../../components/Icon.jsx";
import { Thumbnail } from "../listing/Thumbnail.jsx";
import { AlbumThumbnailImage } from "./album-thumbnail-transition.jsx";
import { AlbumIndicator } from "./AlbumIndicator.jsx";
import { artwork } from "../../../lib/demo.js";
import { groupMediaByDate } from "../../../lib/album.js";
import { useLiveMedia } from "../../../hooks/useLiveMedia.js";
import { albumLiveItems } from "../../../lib/live.js";

export function Album({
  view = "date",
  entries,
  loading,
  demo,
  client,
  selected,
  onPreview,
  selection,
  onItemsChange,
  pagination,
}) {
  const live = useLiveMedia(client, entries);
  const media = useMemo(() => albumLiveItems(entries, live), [entries, live]);
  const elements = useRef(new Map());
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    let timer;
    const refreshDate = () => {
      const now = new Date();
      setToday(now);
      clearTimeout(timer);
      const midnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
      );
      timer = setTimeout(refreshDate, midnight.getTime() - now.getTime() + 100);
    };
    refreshDate();
    document.addEventListener("visibilitychange", refreshDate);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshDate);
    };
  }, []);
  const groups = useMemo(() => groupMediaByDate(media, today), [media, today]);
  const orderedItems = useMemo(
    () => groups.flatMap((group) => group.items),
    [groups],
  );
  useLayoutEffect(
    () => onItemsChange(orderedItems),
    [orderedItems, onItemsChange],
  );
  if (loading && !entries.length)
    return (
      <div class="file-grid album-layout">
        {Array.from({ length: 12 }, (_, index) => (
          <div class="skeleton" key={index} />
        ))}
      </div>
    );
  const renderItems = (items) => (
    <div class="file-grid album-layout">
      {items.map((item) => (
        <article
          class={`file-item album-item${selection.isSelected(item) ? " selected" : ""}`}
          key={item.path}
          data-selected={selection.isSelected(item) ? "true" : undefined}
        >
          <button
            class="file-open album-preview"
            ref={(node) =>
              node
                ? elements.current.set(item.path, node)
                : elements.current.delete(item.path)
            }
            data-path={item.path}
            aria-label={t(
              item.kind === "video"
                ? "library.previewVideoNamed"
                : "library.previewNamed",
              { name: item.name },
            )}
            aria-description={item.live ? t("library.livePhoto") : undefined}
            aria-pressed={
              selection.isSelected(item) || selected?.path === item.path
            }
            {...selection.props(item, () =>
              onPreview(item, {
                ...pagination,
                items: orderedItems,
                findTile: (path) => elements.current.get(path),
              }),
            )}
          >
            {demo && item.kind === "image" ? (
              <AlbumThumbnailImage
                src={`data:image/svg+xml,${encodeURIComponent(artwork(item.name))}`}
                alt=""
                decoding="async"
              />
            ) : (
              <Thumbnail
                item={item}
                client={client}
                side={384}
                Image={AlbumThumbnailImage}
                fallback={<Icon name={item.kind} />}
              />
            )}
            {item.kind === "video" && <AlbumIndicator kind="video" />}
            {item.live && <AlbumIndicator kind="live" />}
          </button>
          {selection.touch && (
            <span
              class={`selection-mark${selection.isSelected(item) ? " checked" : ""}`}
              aria-hidden="true"
            >
              {selection.isSelected(item) && <Icon name="check" />}
            </span>
          )}
        </article>
      ))}
    </div>
  );
  if (view === "continuous") return renderItems(orderedItems);
  return groups.map((group) => (
    <section
      class="album-group"
      key={group.key}
      aria-labelledby={`album-date-${group.key}`}
    >
      <h2 class="album-date" id={`album-date-${group.key}`}>
        {group.key === "unknown" ? (
          group.label
        ) : (
          <time dateTime={group.key}>{group.label}</time>
        )}
      </h2>
      {renderItems(group.items)}
    </section>
  ));
}
