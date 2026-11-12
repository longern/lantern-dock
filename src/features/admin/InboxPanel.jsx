import { t, locale } from "../../../shared/i18n.js";
import { Icon } from "../../components/Icon.jsx";
import { useEffect, useRef, useState } from "preact/hooks";
import { bytes, date } from "../../lib/format.js";
import { useCollection } from "./useCollection.js";
import { CollectionStatus, Pagination } from "./CollectionFeedback.jsx";

function InboxThumbnail({ client, item, enabled }) {
  const target = useRef(null);
  const [url, setURL] = useState("");
  useEffect(() => {
    if (!enabled || !/\.(jpe?g|png|webp|gif|heic|heif|tiff?)$/i.test(item.name))
      return;
    const controller = new AbortController();
    let objectURL;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      client
        .thumbnail(item.id, controller.signal)
        .then((blob) => {
          if (controller.signal.aborted) return;
          objectURL = URL.createObjectURL(blob);
          setURL(objectURL);
        })
        .catch(() => {});
    });
    observer.observe(target.current);
    return () => {
      observer.disconnect();
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [client, item.id, item.name, enabled]);
  return (
    <span ref={target} class="admin-file-icon" aria-hidden="true">
      {url ? <img src={url} alt="" /> : <Icon name="file" />}
    </span>
  );
}

function groupInbox(items) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map();
  const format = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  for (const item of items) {
    const day = new Date(item.createdAt);
    const label =
      day.toDateString() === today.toDateString()
        ? t("core.album.today")
        : day.toDateString() === yesterday.toDateString()
          ? t("core.album.yesterday")
          : format.format(day);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }
  return Array.from(groups, ([label, items]) => ({ label, items }));
}
export function InboxPanel({
  client,
  revision,
  refresh,
  onError,
  filter,
  onClearFilter,
  onDownload,
  downloading,
  source,
  canFilter,
  onSource,
}) {
  const collection = useCollection(
    client,
    "inbox",
    filter?.id || "",
    revision,
    onError,
    { source },
  );
  const reload = () => {
    collection.setOffset(0);
    refresh();
  };
  return (
    <section
      class="admin-panel"
      aria-labelledby="admin-inbox-heading"
      aria-busy={collection.status === "loading"}
    >
      <div class="admin-panel-heading">
        <div>
          <h2 id="admin-inbox-heading" tabIndex={-1}>
            {t("admin.inbox")}
          </h2>
          <p>{t("admin.inboxDescription")}</p>
        </div>
        <button
          class="icon-button"
          disabled={collection.status === "loading"}
          onClick={reload}
          aria-label={t("admin.refreshInbox")}
        >
          <Icon name="refresh" />
        </button>
      </div>
      {canFilter && !filter && (
        <div
          class="admin-segmented"
          role="group"
          aria-label={t("admin.inboxFilter")}
        >
          {[
            ["", "admin.all"],
            ["guest", "admin.guestInbox"],
            ["mine", "admin.personalInbox"],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={source === key}
              onClick={() => onSource(key)}
            >
              {t(label)}
            </button>
          ))}
        </div>
      )}
      {filter && (
        <div class="admin-filter">
          <span>{t("admin.filteredBy", { title: filter.title })}</span>
          <button class="text-button" onClick={onClearFilter}>
            {t("admin.allFiles")}
          </button>
        </div>
      )}
      <CollectionStatus
        collection={collection}
        onRetry={reload}
        emptyTitle={t("admin.noFiles")}
        emptyDescription={t("admin.noFilesDescription")}
      />
      {groupInbox(collection.items).map(({ label, items }) => (
        <section key={label} class="admin-inbox-group" aria-label={label}>
          <h3>{label}</h3>
          <ul class="admin-inbox-list">
            {items.map((item) => (
              <li key={item.id} class="admin-inbox-file">
                <InboxThumbnail
                  client={client}
                  item={item}
                  enabled={canFilter}
                />
                <div class="admin-file-copy">
                  <h3>{item.name}</h3>
                  <p class="admin-file-meta">
                    <span>{bytes(item.size)}</span>
                    <time dateTime={item.createdAt}>
                      {date(item.createdAt, true)}
                    </time>
                  </p>
                  <p>
                    {t(
                      item.direct
                        ? "admin.fromMember"
                        : item.personal
                          ? "admin.personalInbox"
                          : "admin.fromLink",
                      {
                        title: item.linkTitle,
                      },
                    )}
                  </p>
                </div>
                <button
                  class="icon-button"
                  disabled={downloading}
                  onClick={() => onDownload(item)}
                  aria-label={t("admin.downloadNamed", { name: item.name })}
                >
                  <Icon name="download" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <Pagination collection={collection} />
    </section>
  );
}
