import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { t } from "../../../shared/i18n.js";
import { useRouter } from "../../hooks/useRouter.jsx";
import { useCompactLayout } from "../../hooks/useMediaQuery.js";
import { useDownload } from "../../hooks/useDownload.js";
import { useTransferPanel } from "../../hooks/useTransferPanel.js";
import { AdminClient } from "../../lib/admin.js";
import { Brand } from "../../components/Brand.jsx";
import { CreateLinkDialog } from "../uploads/CreateLinkDialog.jsx";
import { TransferCenter } from "../../components/TransferCenter.jsx";
import { Icon } from "../../components/Icon.jsx";
import { LinksPanel } from "./LinksPanel.jsx";
import { InboxPanel } from "./InboxPanel.jsx";
import { UsersPanel } from "./UsersPanel.jsx";
import { RevokeDialog } from "./RevokeDialog.jsx";

const ignore = () => {};

export function AdminWorkspace({ account, refreshNAS, refreshIdentity }) {
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
  const [shareLink, setShareLink] = useState(null);
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
      setShareLink(null);
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
        <Brand className="admin-nav-brand" />
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
            onCreate={() => setCreate(true)}
            onShare={setShareLink}
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
          onExit={() => setCreate(false)}
          onCreated={refresh}
          onError={onError}
        />
      )}
      {shareLink && (
        <CreateLinkDialog
          key={shareLink.id}
          client={client}
          invitation={shareLink}
          onExit={() => setShareLink(null)}
          onCreated={refresh}
          onError={onError}
          fallbackFocus={`#admin-share-${shareLink.id}`}
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
