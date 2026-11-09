import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { t } from "../../shared/i18n.js";
import { useSession } from "../hooks/useSession.jsx";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { useDownload } from "../hooks/useDownload.js";
import { useTransferPanel } from "../hooks/useTransferPanel.js";
import { AdminClient, adminAccess, createLinkInput, linkState, localDateTime } from "../lib/admin.js";
import { bytes, date } from "../lib/format.js";
import { Dialog } from "./Dialog.jsx";
import { TransferCenter } from "./TransferCenter.jsx";
import { Icon } from "./Icon.jsx";
import { useRouter } from "../hooks/useRouter.jsx";
import { accountHref } from "../../shared/routes.js";

const ignore = () => {};

export function AdminPage() {
  const { identity, nas, ensureNAS, refreshIdentity, refreshNAS } = useSession();
  const mobile = useMediaQuery("(max-width: 700px)");
  useEffect(() => {
    if (identity.status === "authenticated") void ensureNAS();
  }, [identity.status, ensureNAS]);
  const access = adminAccess(identity, nas);
  return (
    <main class="admin-page">
      <header class="admin-header">
        <a class="admin-back" href={mobile ? "/me" : "/"}>
          <Icon name="chevron-left" /><span>{t(mobile ? "library.backToMe" : "account.backToPublicFiles")}</span>
        </a>
        <a class="admin-account-link" href={accountHref(location.pathname + location.search)}><Icon name="user" /><span>{t("account.myAccount")}</span></a>
      </header>
      <div class="admin-heading">
        <span class="admin-eyebrow"><Icon name="shield" />LanternDock</span>
        <h1>{t("admin.title")}</h1>
        <p>{t("admin.description")}</p>
      </div>
      {access === "ready" ? (
        <AdminWorkspace key={identity.user.issuer + ":" + identity.user.sub} account={nas.account}
          refreshNAS={refreshNAS} refreshIdentity={refreshIdentity} />
      ) : (
        <section class="admin-gate" aria-live="polite" aria-busy={access === "checking"}>
          <span class="admin-gate-icon"><Icon name={access === "nas-error" ? "cloud-off" : "lock"} /></span>
          <h2>{t(`admin.gate.${access}.title`)}</h2>
          <p>{t(`admin.gate.${access}.description`)}</p>
          {access === "signed-out" ? <a class="primary-button" href={accountHref(location.pathname + location.search)}>{t("account.signIn")}</a> :
            access !== "checking" && <button class="secondary-button"
              onClick={() => void (access === "identity-error" ? refreshIdentity() : refreshNAS())}>
              <Icon name="refresh" />{t("account.checkAgain")}
            </button>}
        </section>
      )}
    </main>
  );
}

function useCollection(client, kind, linkId, revision, onError) {
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState({ status: "loading", items: [], nextOffset: null });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", items: [], nextOffset: null });
    const request = kind === "links" ? client.links({ offset, signal: controller.signal }) :
      client.inbox({ offset, linkId, signal: controller.signal });
    request.then((value) => {
      if (!controller.signal.aborted) setState({ status: "ready", ...value });
    }, (error) => {
      if (controller.signal.aborted) return;
      setState({ status: "error", items: [], nextOffset: null, error });
      onError(error);
    });
    return () => controller.abort();
  }, [client, kind, linkId, offset, revision, onError]);
  return { ...state, offset, setOffset };
}

function AdminWorkspace({ account, refreshNAS, refreshIdentity }) {
  const router = useRouter();
  const client = useMemo(() => new AdminClient(account), [account]);
  useEffect(() => () => client.close(), [client]);
  const tab = router.route.tab === "inbox" && account.capabilities.adminInbox ? "inbox" : account.capabilities.adminLinks ? "links" : "inbox";
  const setTab = (next) => router.navigate(`/admin/${next}`);
  useEffect(() => {
    if (location.pathname !== `/admin/${tab}`) router.navigate(`/admin/${tab}`, { replace: true });
  }, [tab]);
  const [filterTitle, setFilterTitle] = useState(null);
  const requestedLink = new URLSearchParams(location.search).get("link");
  const filter = requestedLink && /^[a-zA-Z0-9_-]{1,128}$/.test(requestedLink) ? { id: requestedLink, title: filterTitle?.id === requestedLink ? filterTitle.title : requestedLink } : null;
  const [revision, setRevision] = useState(0);
  const [create, setCreate] = useState(false);
  const [revoke, setRevoke] = useState(null);
  const [notice, setNotice] = useState(null);
  const report = useCallback((text, error = false) => setNotice({ text, error }), []);
  const onError = useCallback((error) => {
    if (error.code === "LOGIN_REQUIRED") void refreshIdentity();
    else if (error.status === 401 || error.status === 403) void refreshNAS();
  }, [refreshNAS, refreshIdentity]);
  const downloadConnection = useMemo(() => ({ client: { get: async (id, signal) => {
    try { return await client.download(id, signal); }
    catch (error) { if (!signal?.aborted) onError(error); throw error; }
  } } }), [client, onError]);
  const transfer = useDownload(downloadConnection, ignore, report);
  const mobile = useMediaQuery("(max-width: 700px)");
  const transferPanel = useTransferPanel(transfer, mobile);
  useEffect(() => {
    const stop = () => { transfer.cancel(); client.close(); setCreate(false); setRevoke(null); };
    const resume = (event) => { if (event.persisted) void refreshNAS(); };
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", resume);
    return () => { window.removeEventListener("pagehide", stop); window.removeEventListener("pageshow", resume); };
  }, [client, refreshNAS]);
  const refresh = () => setRevision((value) => value + 1);
  const showInbox = (link) => {
    setFilterTitle({ id: link.id, title: link.title });
    router.navigate(`/admin/inbox?link=${encodeURIComponent(link.id)}`);
    requestAnimationFrame(() => document.getElementById("admin-inbox-heading")?.focus({ preventScroll: true }));
  };
  return (
    <>
      <nav class="admin-navigation" aria-label={t("admin.sections")}>
        {account.capabilities.adminLinks && <button type="button" aria-current={tab === "links" ? "page" : undefined}
          onClick={() => setTab("links")}><Icon name="upload" />{t("admin.links")}</button>}
        {account.capabilities.adminInbox && <button type="button" aria-current={tab === "inbox" ? "page" : undefined}
          onClick={() => setTab("inbox")}><Icon name="lock" />{t("admin.inbox")}</button>}
      </nav>
      {transfer.tasks.length > 0 && <button id="transfers-button" class="text-button" aria-label={t("library.openTransfers")} aria-expanded={transferPanel.open}
        onClick={transferPanel.open ? transferPanel.onClose : transferPanel.onOpen}><Icon name="transfers" />{t("library.transfers")}</button>}
      {notice && <div class={`admin-notice${notice.error ? " error" : ""}`} role={notice.error ? "alert" : "status"}>
        <span>{notice.text}</span><button class="icon-button" aria-label={t("admin.dismissNotice")} onClick={() => setNotice(null)}><Icon name="x" /></button>
      </div>}
      {tab === "links" ? <LinksPanel client={client} revision={revision} refresh={refresh} onError={onError}
        onCreate={() => setCreate(true)} onRevoke={setRevoke} onInbox={account.capabilities.adminInbox ? showInbox : null} /> :
        <InboxPanel key={filter?.id || "all"} client={client} revision={revision} refresh={refresh} onError={onError}
          filter={filter} onClearFilter={() => router.navigate("/admin/inbox", { replace: true })} onDownload={(item) => transfer.download({ ...item, path: item.id })}
          downloading={!!transfer.progress} />}
      {create && <CreateLinkDialog client={client} onExit={() => setCreate(false)} onCreated={refresh} onError={onError} />}
      {revoke && <RevokeDialog client={client} link={revoke} onExit={() => setRevoke(null)} onError={onError}
        onRevoked={() => { refresh(); report(t("admin.revokedNotice")); }} />}
      <TransferCenter transfer={transfer} mobile={mobile} {...transferPanel} />
    </>
  );
}

function CollectionStatus({ collection, onRetry, emptyTitle, emptyDescription }) {
  if (collection.status === "loading") return <p class="admin-empty" role="status">{t("admin.loading")}</p>;
  if (collection.status === "error") return <div class="admin-empty error" role="alert">
    <p>{collection.error.message || t("admin.requestFailed")}</p>
    <button class="secondary-button" onClick={onRetry}><Icon name="refresh" />{t("library.retry")}</button>
  </div>;
  if (!collection.items.length) return <div class="admin-empty"><h3>{emptyTitle}</h3><p>{emptyDescription}</p></div>;
  return null;
}
function Pagination({ collection }) {
  if (!collection.offset && collection.nextOffset === null) return null;
  return <nav class="admin-pagination" aria-label={t("admin.pagination")}>
    <button class="secondary-button" disabled={collection.status === "loading" || !collection.offset}
      onClick={() => collection.setOffset(Math.max(0, collection.offset - 100))}>
      <Icon name="chevron-left" />{t("admin.previous")}
    </button>
    <span>{t("admin.page", { page: Math.floor(collection.offset / 100) + 1 })}</span>
    <button class="secondary-button" disabled={collection.status !== "ready" || collection.nextOffset === null || collection.nextOffset <= collection.offset}
      onClick={() => collection.setOffset(collection.nextOffset)}>{t("admin.next")}<Icon name="chevron-right" /></button>
  </nav>;
}
function LinksPanel({ client, revision, refresh, onError, onCreate, onRevoke, onInbox }) {
  const collection = useCollection(client, "links", "", revision, onError);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const reload = () => { collection.setOffset(0); refresh(); };
  return <section class="admin-panel" aria-labelledby="admin-links-heading" aria-busy={collection.status === "loading"}>
    <div class="admin-panel-heading">
      <div><h2 id="admin-links-heading">{t("admin.links")}</h2><p>{t("admin.linksDescription")}</p></div>
      <div class="admin-panel-actions">
        <button class="icon-button" disabled={collection.status === "loading"} onClick={reload} aria-label={t("admin.refreshLinks")}><Icon name="refresh" /></button>
        <button id="admin-create-link" class="primary-button" onClick={onCreate}><Icon name="upload" />{t("admin.createLink")}</button>
      </div>
    </div>
    <CollectionStatus collection={collection} onRetry={reload} emptyTitle={t("admin.noLinks")} emptyDescription={t("admin.noLinksDescription")} />
    <ul class="admin-link-list">
      {collection.items.map((link) => <li class="admin-link-card" key={link.id}>
        <div class="admin-link-title"><h3>{link.title}</h3><span class="admin-badge" data-status={linkState(link, now)}>{t(`admin.state.${linkState(link, now)}`)}</span></div>
        <dl class="admin-link-details">
          <div><dt>{t("admin.expires")}</dt><dd><time dateTime={link.expiresAt}>{date(link.expiresAt, true)}</time></dd></div>
          <div><dt>{t("admin.fileLimit")}</dt><dd>{bytes(link.maxFileBytes)}</dd></div>
          <div><dt>{t("admin.collectedBytes")}</dt><dd>{bytes(link.usedBytes)} / {bytes(link.maxTotalBytes)}</dd></div>
          <div><dt>{t("admin.collectedFiles")}</dt><dd>{link.usedFiles} / {link.maxFiles}</dd></div>
        </dl>
        <div class="admin-usage" role="img" aria-label={t("admin.usage", { used: bytes(link.usedBytes), total: bytes(link.maxTotalBytes) })}>
          <span style={{ width: `${Math.min(100, link.usedBytes / link.maxTotalBytes * 100)}%` }} />
        </div>
        <div class="admin-link-actions">
          {onInbox && <button class="secondary-button" onClick={() => onInbox(link)} aria-label={t("admin.viewLinkInbox", { title: link.title })}><Icon name="folder" />{t("admin.viewInbox")}</button>}
          {!link.revoked && <button class="admin-danger text-button" onClick={() => onRevoke(link)} aria-label={t("admin.revokeNamed", { title: link.title })}>{t("admin.revoke")}</button>}
        </div>
      </li>)}
    </ul>
    <Pagination collection={collection} />
    <p class="admin-footnote"><Icon name="lock" /><span>{t("admin.quotaNote")} {t("admin.noTokenRecovery")}</span></p>
  </section>;
}
function InboxPanel({ client, revision, refresh, onError, filter, onClearFilter, onDownload, downloading }) {
  const collection = useCollection(client, "inbox", filter?.id || "", revision, onError);
  const reload = () => { collection.setOffset(0); refresh(); };
  return <section class="admin-panel" aria-labelledby="admin-inbox-heading" aria-busy={collection.status === "loading"}>
    <div class="admin-panel-heading"><div><h2 id="admin-inbox-heading" tabIndex={-1}>{t("admin.inbox")}</h2><p>{t("admin.inboxDescription")}</p></div>
      <button class="icon-button" disabled={collection.status === "loading"} onClick={reload} aria-label={t("admin.refreshInbox")}><Icon name="refresh" /></button>
    </div>
    {filter && <div class="admin-filter"><span>{t("admin.filteredBy", { title: filter.title })}</span>
      <button class="text-button" onClick={onClearFilter}>{t("admin.allFiles")}</button></div>}
    <CollectionStatus collection={collection} onRetry={reload} emptyTitle={t("admin.noFiles")} emptyDescription={t("admin.noFilesDescription")} />
    <ul class="admin-inbox-list">
      {collection.items.map((item) => <li key={item.id} class="admin-inbox-file">
        <span class="admin-file-icon"><Icon name="file" /></span>
        <div class="admin-file-copy"><h3>{item.name}</h3><p class="admin-file-meta"><span>{bytes(item.size)}</span><time dateTime={item.createdAt}>{date(item.createdAt, true)}</time></p><p>{t("admin.fromLink", { title: item.linkTitle })}</p></div>
        <button class="icon-button" disabled={downloading} onClick={() => onDownload(item)} aria-label={t("admin.downloadNamed", { name: item.name })}><Icon name="download" /></button>
      </li>)}
    </ul>
    <Pagination collection={collection} />
  </section>;
}

function CreateLinkDialog({ client, onExit, onCreated, onError }) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState("");
  const request = useRef(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; request.current?.abort(); }, []);
  const close = () => {
    if (request.current) return;
    // Clear the capability URL immediately, including during the exit animation.
    setResult((value) => value && { ...value, url: "" });
    setCopied("");
    setOpen(false);
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!open || request.current || result) return;
    setError("");
    setUncertain(false);
    let input;
    try { input = createLinkInput(Object.fromEntries(new FormData(event.currentTarget))); }
    catch (err) { setError(err.message); return; }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const value = await client.create(input, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setResult(value);
      onCreated();
      requestAnimationFrame(() => document.getElementById("admin-copy-link")?.focus());
    } catch (err) {
      if (!alive.current || controller.signal.aborted) return;
      setError(err.message || t("admin.requestFailed"));
      // Never retry a potentially committed POST automatically.
      if (!err.status || err.status >= 500) { setUncertain(true); onCreated(); }
      onError(err);
    } finally {
      if (request.current === controller) request.current = null;
      if (alive.current) setBusy(false);
    }
  };
  const copy = async () => {
    if (!result?.url || !open) return;
    try {
      await navigator.clipboard.writeText(result.url);
      if (alive.current) setCopied(t("admin.linkCopied"));
    } catch {
      if (alive.current) setCopied(t("admin.copyFailed"));
    }
  };
  return <Dialog class="settings-dialog admin-dialog" id="admin-create-dialog" open={open} onClose={close}
    onExited={onExit} fallbackFocus="#admin-create-link" aria-labelledby="admin-create-title">
    <div class="dialog-heading"><h2 id="admin-create-title">{t(result ? "admin.linkCreated" : "admin.createLink")}</h2>
      <button class="icon-button" disabled={busy} aria-label={t("admin.close")} onClick={close}><Icon name="x" /></button></div>
    {result ? <div class="admin-created">
      <p class="admin-once-warning"><Icon name="lock" /><span>{t("admin.oneTimeWarning")}</span></p>
      <label class="form-label" for="admin-created-url">{t("admin.shareableLink")}</label>
      <textarea id="admin-created-url" readOnly rows={3} value={result.url} autoComplete="off" spellcheck={false} onFocus={(event) => event.currentTarget.select()} />
      <p>{t("admin.linkPrivacy")}</p>
      <div class="dialog-actions"><button id="admin-copy-link" class="primary-button" onClick={copy}><Icon name="copy" />{t("admin.copyLink")}</button>
        <button class="secondary-button" onClick={close}>{t("admin.savedLink")}</button></div>
      {copied && <p class="account-feedback" role="status">{copied}</p>}
    </div> : <form onSubmit={submit}>
      <p class="dialog-intro">{t("admin.createDescription")}</p>
      <fieldset disabled={busy} class="admin-form-fields">
        <label class="form-label" for="admin-link-title">{t("admin.linkTitle")}</label>
        <input id="admin-link-title" name="title" required maxLength={200} autoComplete="off" placeholder={t("admin.titlePlaceholder")} />
        <label class="form-label" for="admin-link-expiry">{t("admin.expiryLocal")}</label>
        <input id="admin-link-expiry" type="datetime-local" name="expiresAt" required min={localDateTime()}
          defaultValue={localDateTime(new Date(Date.now() + 7 * 86400000))} />
        <div class="admin-form-grid">
          <div><label class="form-label" for="admin-link-file-limit">{t("admin.fileLimitMiB")}</label><input id="admin-link-file-limit" type="number" name="maxFileMiB" min="0.01" step="0.01" required defaultValue="100" /></div>
          <div><label class="form-label" for="admin-link-total-limit">{t("admin.totalLimitMiB")}</label><input id="admin-link-total-limit" type="number" name="maxTotalMiB" min="0.01" step="0.01" required defaultValue="1024" /></div>
        </div>
        <label class="form-label" for="admin-link-file-count">{t("admin.maxFiles")}</label><input id="admin-link-file-count" type="number" name="maxFiles" min="1" max={Number.MAX_SAFE_INTEGER} step="1" required defaultValue="100" />
        <p class="admin-form-hint">{t("admin.quotaNote")}</p>
      </fieldset>
      {error && <p class="admin-form-error" role="alert">{error}</p>}
      {uncertain && <p class="admin-form-error" role="alert">{t("admin.createUncertain")}</p>}
      {busy && <p role="status" class="admin-form-hint">{t("admin.creating")}</p>}
      <div class="dialog-actions"><button class="primary-button" type="submit" disabled={busy || uncertain}>{t(busy ? "admin.creating" : "admin.createLink")}</button><button class="secondary-button" type="button" disabled={busy} onClick={close}>{t("admin.cancel")}</button></div>
    </form>}
  </Dialog>;
}
function RevokeDialog({ client, link, onExit, onRevoked, onError }) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; request.current?.abort(); }, []);
  const close = () => { if (!request.current) setOpen(false); };
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
  return <Dialog class="settings-dialog admin-dialog" id="admin-revoke-dialog" open={open} onClose={close}
    onExited={onExit} fallbackFocus="#admin-create-link" aria-labelledby="admin-revoke-title" aria-describedby="admin-revoke-description">
    <div class="dialog-heading"><h2 id="admin-revoke-title">{t("admin.revokeTitle")}</h2><button class="icon-button" disabled={busy} onClick={close} aria-label={t("admin.close")}><Icon name="x" /></button></div>
    <p class="admin-revoke-name">{link.title}</p>
    <p class="dialog-intro" id="admin-revoke-description">{t("admin.revokeDescription")}</p>
    {error && <p class="admin-form-error" role="alert">{error}</p>}
    {busy && <p role="status" class="admin-form-hint">{t("admin.revoking")}</p>}
    <div class="dialog-actions"><button class="secondary-button" disabled={busy} onClick={close}>{t("admin.cancel")}</button><button class="primary-button admin-revoke-submit" disabled={busy} onClick={revoke}>{t(busy ? "admin.revoking" : "admin.confirmRevoke")}</button></div>
  </Dialog>;
}
