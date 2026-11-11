import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { t, locale } from "../../shared/i18n.js";
import { useSession } from "../hooks/useSession.jsx";
import { useCompactLayout } from "../hooks/useMediaQuery.js";
import { useDownload } from "../hooks/useDownload.js";
import { useTransferPanel } from "../hooks/useTransferPanel.js";
import { AdminClient, adminAccess, linkState } from "../lib/admin.js";
import { bytes, date } from "../lib/format.js";
import { Dialog } from "./Dialog.jsx";
import { CreateLinkDialog } from "./CreateLinkDialog.jsx";
import { TransferCenter } from "./TransferCenter.jsx";
import { Icon } from "./Icon.jsx";
import { useRouter } from "../hooks/useRouter.jsx";
import { accountHref } from "../../shared/routes.js";
import { siteTitle } from "../lib/site-title.js";

const ignore = () => {};

export function AdminPage() {
  const { identity, nas, ensureNAS, refreshIdentity, refreshNAS } =
    useSession();
  const mobile = useCompactLayout();
  const { route } = useRouter();
  useEffect(() => {
    if (identity.status === "authenticated") void ensureNAS();
  }, [identity.status, ensureNAS]);
  const access = adminAccess(identity, nas);
  const ready = access === "ready";
  const capabilities = nas.account?.capabilities;
  const detail = ready && capabilities.adminUsers && route.member;
  const backLabel = t(
    detail
      ? "admin.users"
      : mobile
        ? "library.backToMe"
        : "account.backToPublicFiles",
  );
  const heading =
    !mobile || !capabilities?.adminUsers
      ? "admin.title"
      : detail
        ? "admin.uploadPermission"
        : route.tab === "users" && capabilities?.adminUsers
          ? "admin.users"
          : route.tab === "links"
            ? "admin.links"
            : "admin.title";
  return (
    <main
      class={`admin-page${ready ? " admin-ready" : ""}${detail ? " admin-detail" : ""}`}
    >
      <header class="admin-header">
        <a
          class="admin-back"
          aria-label={backLabel}
          href={detail ? "/admin/users" : mobile ? "/me" : "/"}
        >
          <Icon name="chevron-left" />
          <span>{backLabel}</span>
        </a>
        {ready && <h1 class="admin-mobile-title">{t(heading)}</h1>}
        <a
          class="admin-account-link"
          aria-label={t("account.myAccount")}
          href={accountHref(location.pathname + location.search)}
        >
          <Icon name="user" />
          <span>{t("account.myAccount")}</span>
        </a>
      </header>
      {!ready && (
        <div class="admin-heading">
          <span class="admin-eyebrow">
            <Icon name="shield" />
            {siteTitle}
          </span>
          <h1>{t("admin.title")}</h1>
          <p>{t("admin.description")}</p>
        </div>
      )}
      {ready ? (
        <AdminWorkspace
          key={identity.user.issuer + ":" + identity.user.sub}
          account={nas.account}
          refreshNAS={refreshNAS}
          refreshIdentity={refreshIdentity}
        />
      ) : (
        <section
          class="admin-gate"
          aria-live="polite"
          aria-busy={access === "checking"}
        >
          <span class="admin-gate-icon">
            <Icon name={access === "nas-error" ? "cloud-off" : "lock"} />
          </span>
          <h2>{t(`admin.gate.${access}.title`)}</h2>
          <p>{t(`admin.gate.${access}.description`)}</p>
          {access === "signed-out" ? (
            <a
              class="primary-button"
              href={accountHref(location.pathname + location.search)}
            >
              {t("account.signIn")}
            </a>
          ) : (
            access !== "checking" && (
              <button
                class="secondary-button"
                onClick={() =>
                  void (access === "identity-error"
                    ? refreshIdentity()
                    : refreshNAS())
                }
              >
                <Icon name="refresh" />
                {t("account.checkAgain")}
              </button>
            )
          )}
        </section>
      )}
    </main>
  );
}

function useCollection(
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

function AdminWorkspace({ account, refreshNAS, refreshIdentity }) {
  const router = useRouter();
  const client = useMemo(() => new AdminClient(account), [account]);
  useEffect(() => () => client.close(), [client]);
  const caps = account.capabilities;
  const tabs = [
    ...(caps.adminInbox
      ? [{ key: "inbox", icon: "folder", label: "admin.inboxTab" }]
      : []),
    ...(caps.adminLinks
      ? [{ key: "links", icon: "link", label: "admin.inviteTab" }]
      : []),
    ...(caps.adminUsers
      ? [{ key: "users", icon: "users", label: "admin.usersTab" }]
      : []),
  ];
  const requested = router.route.tab;
  const routedPath = router.route.href.split("?")[0];
  const legacyDefault =
    routedPath === "/admin" && !caps.adminUsers && caps.adminLinks;
  const tab = legacyDefault
    ? "links"
    : tabs.some((item) => item.key === requested)
      ? requested
      : tabs[0]?.key;
  const member = tab === "users" ? router.route.member : null;
  const setTab = (next) => router.navigate(`/admin/${next}`);
  useEffect(() => {
    if (
      tab &&
      !member &&
      location.pathname === routedPath &&
      routedPath !== `/admin/${tab}`
    )
      router.navigate(`/admin/${tab}`, { replace: true });
  }, [tab, member, routedPath]);
  const params = new URLSearchParams(router.route.href.split("?")[1]);
  const source = caps.adminUsers ? params.get("source") : "";
  const inboxSource = source === "guest" || source === "mine" ? source : "";
  const [filterTitle, setFilterTitle] = useState(null);
  const requestedLink = params.get("link");
  const filter =
    requestedLink && /^[a-zA-Z0-9_-]{1,128}$/.test(requestedLink)
      ? {
          id: requestedLink,
          title:
            filterTitle?.id === requestedLink
              ? filterTitle.title
              : requestedLink,
        }
      : null;
  const [revision, setRevision] = useState(0);
  const [create, setCreate] = useState(false);
  const [revoke, setRevoke] = useState(null);
  const [notice, setNotice] = useState(null);
  const report = useCallback(
    (text, error = false) => setNotice({ text, error }),
    [],
  );
  const onError = useCallback(
    (error) => {
      if (error.code === "LOGIN_REQUIRED") void refreshIdentity();
      else if (error.status === 401 || error.status === 403) void refreshNAS();
    },
    [refreshNAS, refreshIdentity],
  );
  const downloadConnection = useMemo(
    () => ({
      client: {
        get: async (id, signal) => {
          try {
            return await client.download(id, signal);
          } catch (error) {
            if (!signal?.aborted) onError(error);
            throw error;
          }
        },
      },
    }),
    [client, onError],
  );
  const transfer = useDownload(downloadConnection, ignore, report);
  const mobile = useCompactLayout();
  const transferPanel = useTransferPanel(transfer, mobile);
  useEffect(() => {
    const stop = () => {
      transfer.cancel();
      client.close();
      setCreate(false);
      setRevoke(null);
    };
    const resume = (event) => {
      if (event.persisted) void refreshNAS();
    };
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", resume);
    return () => {
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("pageshow", resume);
    };
  }, [client, refreshNAS]);
  const refresh = () => setRevision((value) => value + 1);
  const showInbox = (link) => {
    setFilterTitle({ id: link.id, title: link.title });
    router.navigate(`/admin/inbox?link=${encodeURIComponent(link.id)}`);
    requestAnimationFrame(() =>
      document
        .getElementById("admin-inbox-heading")
        ?.focus({ preventScroll: true }),
    );
  };
  return (
    <div class="admin-workspace">
      <nav class="admin-navigation" aria-label={t("admin.sections")}>
        <div class="admin-nav-brand">
          <Icon name="portal" /> {siteTitle}
        </div>
        {tabs.map(({ key, icon, label }) => (
          <button
            key={key}
            type="button"
            aria-current={tab === key ? "page" : undefined}
            onClick={() => setTab(key)}
          >
            <Icon name={icon} />
            <span>{t(label)}</span>
          </button>
        ))}
      </nav>
      <div class="admin-main">
        {transfer.tasks.length > 0 && (
          <button
            id="transfers-button"
            class="text-button"
            aria-label={t("library.openTransfers")}
            aria-expanded={transferPanel.open}
            onClick={
              transferPanel.open ? transferPanel.onClose : transferPanel.onOpen
            }
          >
            <Icon name="transfers" />
            {t("library.transfers")}
          </button>
        )}
        {notice && (
          <div
            class={`admin-notice${notice.error ? " error" : ""}`}
            role={notice.error ? "alert" : "status"}
          >
            <span>{notice.text}</span>
            <button
              class="icon-button"
              aria-label={t("admin.dismissNotice")}
              onClick={() => setNotice(null)}
            >
              <Icon name="x" />
            </button>
          </div>
        )}
        {tab === "links" ? (
          <LinksPanel
            client={client}
            revision={revision}
            refresh={refresh}
            onError={onError}
            onCreate={(preset = "advanced") => setCreate(preset)}
            onRevoke={setRevoke}
            onInbox={account.capabilities.adminInbox ? showInbox : null}
          />
        ) : tab === "users" ? (
          <UsersPanel
            client={client}
            member={member}
            onSelect={(sub) => router.navigate(`/admin/users/${sub}`)}
            mobile={mobile}
            onError={onError}
            revision={revision}
            onSaved={refresh}
          />
        ) : (
          <InboxPanel
            key={filter?.id || inboxSource || "all"}
            source={inboxSource}
            canFilter={caps.adminUsers === true}
            onSource={(source) =>
              router.navigate(
                source ? `/admin/inbox?source=${source}` : "/admin/inbox",
              )
            }
            client={client}
            revision={revision}
            refresh={refresh}
            onError={onError}
            filter={filter}
            onClearFilter={() =>
              router.navigate("/admin/inbox", { replace: true })
            }
            onDownload={(item) => transfer.download({ ...item, path: item.id })}
            downloading={!!transfer.progress}
          />
        )}
      </div>
      {create && (
        <CreateLinkDialog
          client={client}
          quick={create !== "advanced"}
          preset={create === "advanced" ? "" : create}
          onExit={() => setCreate(false)}
          onCreated={refresh}
          onError={onError}
        />
      )}
      {revoke && (
        <RevokeDialog
          client={client}
          link={revoke}
          onExit={() => setRevoke(null)}
          onError={onError}
          onRevoked={() => {
            refresh();
            report(t("admin.revokedNotice"));
          }}
        />
      )}
      <TransferCenter transfer={transfer} mobile={mobile} {...transferPanel} />
    </div>
  );
}

function CollectionStatus({
  collection,
  onRetry,
  emptyTitle,
  emptyDescription,
}) {
  if (collection.status === "loading")
    return (
      <p class="admin-empty" role="status">
        {t("admin.loading")}
      </p>
    );
  if (collection.status === "error")
    return (
      <div class="admin-empty error" role="alert">
        <p>{collection.error.message || t("admin.requestFailed")}</p>
        <button class="secondary-button" onClick={onRetry}>
          <Icon name="refresh" />
          {t("library.retry")}
        </button>
      </div>
    );
  if (!collection.items.length)
    return (
      <div class="admin-empty">
        <h3>{emptyTitle}</h3>
        <p>{emptyDescription}</p>
      </div>
    );
  return null;
}
function Pagination({ collection }) {
  if (!collection.offset && collection.nextOffset === null) return null;
  return (
    <nav class="admin-pagination" aria-label={t("admin.pagination")}>
      <button
        class="secondary-button"
        disabled={collection.status === "loading" || !collection.offset}
        onClick={() =>
          collection.setOffset(Math.max(0, collection.offset - 100))
        }
      >
        <Icon name="chevron-left" />
        {t("admin.previous")}
      </button>
      <span>
        {t("admin.page", { page: Math.floor(collection.offset / 100) + 1 })}
      </span>
      <button
        class="secondary-button"
        disabled={
          collection.status !== "ready" ||
          collection.nextOffset === null ||
          collection.nextOffset <= collection.offset
        }
        onClick={() => collection.setOffset(collection.nextOffset)}
      >
        {t("admin.next")}
        <Icon name="chevron-right" />
      </button>
    </nav>
  );
}
function LinksPanel({
  client,
  revision,
  refresh,
  onError,
  onCreate,
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
            {t("admin.createLink")}
          </button>
        </div>
      </div>
      <div class="admin-quick-links">
        {[
          ["scan", "qr-code", "admin.scanDrop", "admin.scanExpiry"],
          ["share", "link", "admin.shareDrop", "admin.shareExpiry"],
        ].map(([key, icon, title, detail]) => (
          <button type="button" key={key} onClick={() => onCreate(key)}>
            <Icon name={icon} />
            <span>
              <strong>{t(title)}</strong>
              <small>{t(detail)}</small>
            </span>
            <Icon name="chevron-right" />
          </button>
        ))}
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
                    {!link.revoked && (
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
          {t("admin.quotaNote")} {t("admin.noTokenRecovery")}
        </span>
      </p>
    </section>
  );
}
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
function InboxPanel({
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

function MemberAvatar({ member }) {
  const initial = Array.from(member.name.trim() || member.sub)[0];
  return (
    <span class="admin-member-avatar" aria-hidden="true">
      {initial.toUpperCase()}
    </span>
  );
}

function UsersPanel({
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

function MemberEditor({ client, sub, onError, onSaved }) {
  const [member, setMember] = useState(null);
  const [permission, setPermission] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    client.users({ sub, signal: controller.signal }).then(
      ({ items }) => {
        if (controller.signal.aborted) return;
        if (!items[0]) {
          setError(t("admin.userMissing"));
          return;
        }
        setMember(items[0]);
        setPermission(items[0].permission);
      },
      (error) => {
        if (controller.signal.aborted) return;
        setError(error.message);
        onError(error);
      },
    );
    return () => {
      controller.abort();
      pending.current?.abort();
    };
  }, [client, sub, onError]);
  const save = async (event) => {
    event.preventDefault();
    if (!member || pending.current || member.admin || member.assignedElsewhere)
      return;
    setError("");
    setNotice("");
    const data = new FormData(event.currentTarget);
    const value = {
      enabled: permission.enabled,
      maxFiles: Number(data.get("maxFiles")),
      maxFileBytes: Math.round(Number(data.get("maxFileMiB")) * 1048576),
    };
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      await client.saveUser(sub, value, controller.signal);
      if (!controller.signal.aborted) {
        setPermission(value);
        onSaved();
        setNotice(t("admin.permissionsSaved"));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error.message);
        onError(error);
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const locked = member?.admin || member?.assignedElsewhere;
  return (
    <section
      class="admin-panel admin-permission-pane"
      aria-labelledby="admin-permission-title"
      aria-busy={!member && !error}
    >
      <div class="admin-panel-heading">
        <div>
          <h2 id="admin-permission-title">{t("admin.uploadPermission")}</h2>
        </div>
      </div>
      {!member && !error && <p role="status">{t("admin.loading")}</p>}
      {member && (
        <form onSubmit={save}>
          <div class="admin-member-profile">
            <MemberAvatar member={member} />
            <strong>{member.name || member.sub}</strong>
          </div>
          {locked ? (
            <p class="admin-member-locked">
              {t(
                member.admin
                  ? "admin.adminPermissionFixed"
                  : "admin.assignedElsewhere",
              )}
            </p>
          ) : (
            <>
              <fieldset class="admin-permission-fields" disabled={busy}>
                <label class="admin-permission-row">
                  <span>
                    <strong>{t("admin.allowDirect")}</strong>
                    <small>{t("admin.allowDirectHint")}</small>
                  </span>
                  <input
                    class="admin-switch"
                    type="checkbox"
                    role="switch"
                    checked={permission.enabled}
                    onChange={(event) =>
                      setPermission({
                        ...permission,
                        enabled: event.currentTarget.checked,
                      })
                    }
                  />
                </label>
                <div class="admin-permission-row">
                  <strong>{t("admin.destinationInbox")}</strong>
                  <span>{t("admin.personalInbox")}</span>
                </div>
                <label class="admin-permission-row">
                  <strong>{t("admin.dailyFileLimit")}</strong>
                  <span>
                    <input
                      type="number"
                      name="maxFiles"
                      required
                      min="1"
                      max="10000"
                      step="1"
                      defaultValue={permission.maxFiles}
                    />{" "}
                    {t("admin.fileUnit")}
                  </span>
                </label>
                <label class="admin-permission-row">
                  <strong>{t("admin.fileLimit")}</strong>
                  <span>
                    <input
                      type="number"
                      name="maxFileMiB"
                      required
                      min="0.01"
                      max="1024"
                      step="any"
                      defaultValue={permission.maxFileBytes / 1048576}
                    />{" "}
                    MiB
                  </span>
                </label>
              </fieldset>
              <p class="admin-form-hint admin-quota-reset">
                {t("admin.dailyQuotaHint")}
              </p>
              <div class="admin-save-permission">
                {notice && <p role="status">{notice}</p>}
                <button class="primary-button" type="submit" disabled={busy}>
                  {t(busy ? "admin.savingPermission" : "admin.savePermission")}
                </button>
              </div>
            </>
          )}
        </form>
      )}
      {error && (
        <p class="admin-form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function RevokeDialog({ client, link, onExit, onRevoked, onError }) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      request.current?.abort();
    },
    [],
  );
  const close = () => {
    if (!request.current) setOpen(false);
  };
  const revoke = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      await client.revoke(link.id, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      onRevoked();
      setOpen(false);
    } catch (err) {
      if (!alive.current || controller.signal.aborted) return;
      setError(err.message || t("admin.requestFailed"));
      onError(err);
    } finally {
      if (request.current === controller) request.current = null;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Dialog
      class="settings-dialog admin-dialog"
      id="admin-revoke-dialog"
      open={open}
      onClose={close}
      onExited={onExit}
      fallbackFocus="#admin-create-link"
      aria-labelledby="admin-revoke-title"
      aria-describedby="admin-revoke-description"
    >
      <div class="dialog-heading">
        <h2 id="admin-revoke-title">{t("admin.revokeTitle")}</h2>
        <button
          class="icon-button"
          disabled={busy}
          onClick={close}
          aria-label={t("admin.close")}
        >
          <Icon name="x" />
        </button>
      </div>
      <p class="admin-revoke-name">{link.title}</p>
      <p class="dialog-intro" id="admin-revoke-description">
        {t("admin.revokeDescription")}
      </p>
      {error && (
        <p class="admin-form-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" class="admin-form-hint">
          {t("admin.revoking")}
        </p>
      )}
      <div class="dialog-actions">
        <button
          autofocus
          class="secondary-button"
          disabled={busy}
          onClick={close}
        >
          {t("admin.cancel")}
        </button>
        <button
          class="primary-button admin-revoke-submit"
          disabled={busy}
          onClick={revoke}
        >
          {t(busy ? "admin.revoking" : "admin.confirmRevoke")}
        </button>
      </div>
    </Dialog>
  );
}
