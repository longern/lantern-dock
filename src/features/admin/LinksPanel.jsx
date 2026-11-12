import { t } from "../../../shared/i18n.js";
import { Icon } from "../../components/Icon.jsx";
import { useEffect, useState } from "preact/hooks";
import { useCompactLayout } from "../../hooks/useMediaQuery.js";
import { linkState } from "../../lib/admin.js";
import { bytes, date } from "../../lib/format.js";
import { useCollection } from "./useCollection.js";
import { CollectionStatus, Pagination } from "./CollectionFeedback.jsx";

export function LinksPanel({
  client,
  revision,
  refresh,
  onError,
  onCreate,
  onShare,
  onRevoke,
  onInbox,
}) {
  const collection = useCollection(client, "links", "", revision, onError);
  const compact = useCompactLayout();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const reload = () => {
    collection.setOffset(0);
    refresh();
  };
  return (
    <section
      class="admin-panel"
      aria-labelledby="admin-links-heading"
      aria-busy={collection.status === "loading"}
    >
      <div class="admin-panel-heading">
        <div>
          <h2 id="admin-links-heading">{t("admin.links")}</h2>
          <p>{t("admin.linksDescription")}</p>
        </div>
        <div class="admin-panel-actions">
          <button
            class="icon-button"
            disabled={collection.status === "loading"}
            onClick={reload}
            aria-label={t("admin.refreshLinks")}
          >
            <Icon name="refresh" />
          </button>
          <button
            id="admin-create-link"
            class="primary-button"
            onClick={() => onCreate()}
          >
            <Icon name="upload" />
            {t("admin.createInvitation")}
          </button>
        </div>
      </div>
      <CollectionStatus
        collection={collection}
        onRetry={reload}
        emptyTitle={t("admin.noLinks")}
        emptyDescription={t("admin.noLinksDescription")}
      />
      {[true, false].map((active) => {
        const items = collection.items.filter(
          (link) =>
            (!link.revoked && Date.parse(link.expiresAt) > now) === active,
        );
        if (!items.length) return null;
        const label = t(active ? "admin.activeLinks" : "admin.endedLinks");
        return (
          <section class="admin-link-group" key={label} aria-label={label}>
            <h3>{label}</h3>
            <ul class="admin-link-list">
              {items.map((link) => (
                <li class="admin-link-card" key={link.id}>
                  <div class="admin-link-title">
                    <div>
                      <h3>{link.title}</h3>
                      <small>
                        {link.receivedFiles === undefined
                          ? `${link.usedFiles} / ${link.maxFiles} ${t("admin.fileUnit")}`
                          : t("admin.receivedCount", {
                              count: link.receivedFiles,
                            })}
                      </small>
                    </div>
                    <span
                      class="admin-badge"
                      data-status={linkState(link, now)}
                    >
                      {t(`admin.state.${linkState(link, now)}`)}
                    </span>
                  </div>
                  <details
                    class="admin-link-metrics"
                    open={!compact || undefined}
                  >
                    <summary>{t("admin.linkDetails")}</summary>
                    <dl class="admin-link-details">
                      <div>
                        <dt>{t("admin.expires")}</dt>
                        <dd>
                          <time dateTime={link.expiresAt}>
                            {date(link.expiresAt, true)}
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt>{t("admin.fileLimit")}</dt>
                        <dd>{bytes(link.maxFileBytes)}</dd>
                      </div>
                      <div>
                        <dt>{t("admin.collectedBytes")}</dt>
                        <dd>
                          {bytes(link.usedBytes)} / {bytes(link.maxTotalBytes)}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("admin.collectedFiles")}</dt>
                        <dd>
                          {link.usedFiles} / {link.maxFiles}
                        </dd>
                      </div>
                    </dl>
                    <div
                      class="admin-usage"
                      role="img"
                      aria-label={t("admin.usage", {
                        used: bytes(link.usedBytes),
                        total: bytes(link.maxTotalBytes),
                      })}
                    >
                      <span
                        style={{
                          width: `${Math.min(100, (link.usedBytes / link.maxTotalBytes) * 100)}%`,
                        }}
                      />
                    </div>
                  </details>
                  <div class="admin-link-actions">
                    {linkState(link, now) === "active" &&
                      link.shareable === true && (
                        <button
                          id={`admin-share-${link.id}`}
                          class="admin-invitation-share"
                          onClick={() => onShare(link)}
                          aria-label={t("admin.shareNamed", {
                            title: link.title,
                          })}
                        >
                          <Icon name="share" />
                          {t("admin.share")}
                        </button>
                      )}
                    {onInbox && (
                      <button
                        class="secondary-button"
                        onClick={() => onInbox(link)}
                        aria-label={t("admin.viewLinkInbox", {
                          title: link.title,
                        })}
                      >
                        <Icon name="folder" />
                        {t("admin.viewInbox")}
                      </button>
                    )}
                    {active && (
                      <button
                        class="admin-danger text-button"
                        onClick={() => onRevoke(link)}
                        aria-label={t("admin.revokeNamed", {
                          title: link.title,
                        })}
                      >
                        {t("admin.revoke")}
                      </button>
                    )}
                  </div>
                  {linkState(link, now) === "active" &&
                    link.shareable !== true && (
                      <p class="admin-invitation-compat">
                        {t(
                          link.shareable === false
                            ? "admin.invitationLegacyHint"
                            : "admin.invitationUpgradeHint",
                        )}
                      </p>
                    )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <Pagination collection={collection} />
      <p class="admin-footnote">
        <Icon name="lock" />
        <span>
          {t("admin.quotaNote")} {t("admin.invitationManageHint")}
        </span>
      </p>
    </section>
  );
}
