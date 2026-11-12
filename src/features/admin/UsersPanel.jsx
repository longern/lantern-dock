import { t } from "../../../shared/i18n.js";
import { Icon } from "../../components/Icon.jsx";
import { useEffect, useState } from "preact/hooks";
import { useCollection } from "./useCollection.js";
import { CollectionStatus, Pagination } from "./CollectionFeedback.jsx";
import { MemberAvatar } from "./MemberAvatar.jsx";
import { MemberEditor } from "./MemberEditor.jsx";

export function UsersPanel({
  client,
  member,
  onSelect,
  mobile,
  onError,
  revision,
  onSaved,
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [enabled, setEnabled] = useState(false);
  const collection = useCollection(client, "users", "", revision, onError, {
    query,
    enabled,
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      collection.setOffset(0);
      setQuery(search.trim());
    }, 220);
    return () => clearTimeout(timer);
  }, [search]);
  return (
    <section class={`admin-users-split${member ? " has-member" : ""}`}>
      <div class="admin-panel admin-user-list-pane" hidden={!!member && mobile}>
        <div class="admin-panel-heading">
          <div>
            <h2>{t("admin.users")}</h2>
            <p>{t("admin.usersDescription")}</p>
          </div>
        </div>
        <label class="admin-user-search">
          <Icon name="search" />
          <input
            type="search"
            value={search}
            maxLength={80}
            aria-label={t("admin.searchUsers")}
            placeholder={t("admin.searchUsers")}
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
        </label>
        <div
          class="admin-segmented admin-user-filters"
          role="group"
          aria-label={t("admin.usersFilter")}
        >
          {[false, true].map((value) => (
            <button
              key={String(value)}
              type="button"
              aria-pressed={enabled === value}
              onClick={() => {
                collection.setOffset(0);
                setEnabled(value);
              }}
            >
              {t(value ? "admin.canUpload" : "admin.all")}
            </button>
          ))}
        </div>
        <CollectionStatus
          collection={collection}
          onRetry={onSaved}
          emptyTitle={t("admin.noUsers")}
          emptyDescription={t("admin.noUsersDescription")}
        />
        <ul class="admin-user-list">
          {collection.items.map((item) => (
            <li key={item.sub}>
              <button
                type="button"
                aria-current={item.sub === member ? "page" : undefined}
                onClick={() => onSelect(item.sub)}
              >
                <MemberAvatar member={item} />
                <span class="admin-member-label">
                  <strong>{item.name || item.sub}</strong>
                  <small>
                    {t(
                      item.admin
                        ? "admin.memberAdmin"
                        : item.permission.enabled
                          ? "admin.canUpload"
                          : item.assignedElsewhere
                            ? "admin.assignedElsewhere"
                            : "admin.needsInvite",
                    )}
                  </small>
                </span>
                <Icon name="chevron-right" />
              </button>
            </li>
          ))}
        </ul>
        <Pagination collection={collection} />
      </div>
      {member && (
        <MemberEditor
          key={member}
          client={client}
          sub={member}
          onError={onError}
          onSaved={onSaved}
        />
      )}
    </section>
  );
}
