import { t } from "../../shared/i18n.js";
import { Icon } from "./Icon.jsx";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { Dialog } from "./Dialog.jsx";
import { useEffect } from "preact/hooks";

const modes = [
  ["home", "home", "library.home"],
  ["all", "folder", "library.files"],
  ["favorites", "star", "library.favorites"],
];
const kinds = [
  ["image", "library.images"],
  ["text", "library.documents"],
  ["video", "library.videos"],
  ["book", "library.books"],
  ["audio", "library.music"],
];

export function Sidebar({ library, records, open, onClose, onSettings }) {
  const mobile = useMediaQuery("(max-width: 700px)");
  useEffect(() => {
    if (!mobile && open) onClose();
  }, [mobile, open]);
  const select = (mode, kind) => {
    library.selectMode(mode, kind);
    onClose();
  };
  const content = (
    <>
      <div class="sidebar-heading">
        <a
          href="#"
          class="brand"
          onClick={(event) => {
            event.preventDefault();
            library.selectMode("home");
            onClose();
          }}
        >
          <span class="brand-symbol">
            <Icon name="portal" />
          </span>
          <span>LanternDock</span>
        </a>
        {mobile && (
          <button class="icon-button" aria-label={t("library.closeNavigation")} onClick={onClose}>
            <Icon name="x" />
          </button>
        )}
      </div>
      <nav class="main-nav" aria-label={t("library.resourceNavigation")}>
        {modes.map(([mode, icon, label]) => (
          <button
            key={mode}
            class={`nav-item${library.mode === mode ? " active" : ""}`}
            aria-current={library.mode === mode ? "page" : undefined}
            onClick={() => select(mode)}
          >
            <Icon name={icon} />
            {t(label)}
            {((mode === "all" && library.entries.length > 0) ||
              (mode === "favorites" && records.favorites.length > 0)) && (
              <span class="nav-count">
                {mode === "all"
                  ? library.entries.length
                  : records.favorites.length}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div class="nav-label" title={t("library.filterCurrentFolder")}>
        {t("library.fileTypes")}
      </div>
      <nav class="type-nav" aria-label={t("library.fileTypes")}>
        {kinds.map(([kind, label]) => (
          <button
            key={kind}
            class={`nav-item${library.kind === kind ? " active" : ""}`}
            aria-current={library.kind === kind ? "page" : undefined}
            onClick={() => select("all", kind)}
          >
            <Icon name={kind} />
            {t(label)}
          </button>
        ))}
      </nav>
      <div class="sidebar-spacer" />
      <div class="sidebar-bottom">
        <a class="icon-button" href="#/account" aria-label={t("library.myAccount")}>
          <Icon name="user" />
        </a>
        <button
          id="connection-settings"
          class="sidebar-settings"
          aria-label={t("library.connectionSettings")}
          onClick={onSettings}
        >
          <Icon name="settings" />
          <span>{t("library.connectionSettings")}</span>
        </button>
      </div>
    </>
  );
  return mobile ? (
    <Dialog
      id="sidebar"
      class="sidebar sidebar-drawer"
      aria-label={t("library.mainNavigation")}
      open={open}
      onClose={onClose}
    >
      {content}
    </Dialog>
  ) : (
    <aside id="sidebar" class="sidebar" aria-label={t("library.mainNavigation")}>
      {content}
    </aside>
  );
}

export function Topbar({ library, menuOpen, onMenu, actions }) {
  const mobile = useMediaQuery("(max-width: 700px)");
  const home = library.mode === "home";
  const root = library.connection?.client.root || "/";
  const crumbs = [
    {
      label: library.mode === "favorites" ? t("library.favorites") : t("library.files"),
      path: root,
    },
  ];
  if (library.mode === "all") {
    crumbs.push({ label: library.backend?.name || t("library.resources"), path: root });
    let path = root;
    for (const part of library.path
      .slice(root.length)
      .split("/")
      .filter(Boolean)) {
      path += part + "/";
      crumbs.push({ label: decodeURIComponent(part), path });
    }
  }
  const breadcrumbs = (
    <nav class="breadcrumbs" aria-label={t("library.filePath")}>
      {crumbs.map((crumb, index) => (
        <span class="breadcrumb" key={`${index}:${crumb.path}`}>
          {index > 0 && <Icon name="chevron-right" />}
          <button
            aria-current={index === crumbs.length - 1 ? "location" : undefined}
            onClick={() => library.navigate(crumb.path)}
          >
            {crumb.label}
          </button>
        </span>
      ))}
    </nav>
  );
  const search = (
    <label class="search-box">
      <Icon name="search" />
      <input
        id="search"
        type="search"
        value={library.query}
        onInput={(event) => library.setQuery(event.currentTarget.value)}
        placeholder={t("library.searchFiles")}
        aria-label={t("library.searchFiles")}
      />
      {library.query && (
        <button
          type="button"
          class="search-clear icon-button"
          aria-label={t("library.clearSearch")}
          onClick={() => {
            library.setQuery("");
            document.getElementById("search")?.focus();
          }}
        >
          <Icon name="x" />
        </button>
      )}
    </label>
  );
  return (
    <div class="browser-header">
      <header class={`topbar${actions ? " has-actions" : ""}`}>
        <button
          id="navigation-toggle"
          class="icon-button mobile-menu"
          aria-label={t("library.openNavigation")}
          aria-expanded={menuOpen}
          aria-controls="sidebar"
          aria-haspopup="dialog"
          onClick={onMenu}
        >
          <Icon name="menu" />
        </button>
        <a
          href="#"
          class="mobile-brand"
          onClick={(event) => {
            event.preventDefault();
            library.selectMode("home");
          }}
        >
          LanternDock
        </a>
        {!mobile && !home && breadcrumbs}
        <div class="topbar-right">
          {!mobile && home && search}
          <button
            id="refresh-button"
            class="icon-button"
            aria-label={t("library.refreshDirectory")}
            title={t("library.refresh")}
            aria-busy={library.loading}
            disabled={library.loading}
            onClick={library.refresh}
          >
            <Icon name="refresh" />
          </button>
          {actions && <div class="header-actions">{actions}</div>}
        </div>
      </header>
      {mobile && (
        <div class="mobile-file-tools">
          {!home && breadcrumbs}
          {home && search}
        </div>
      )}
    </div>
  );
}

export function MobileTabs({ library, onCloseMenu }) {
  const mobileModes = [modes[0], modes[1], ["me", "user", "library.me"]];
  const active = library.mode === "favorites" ? "me" : library.mode;
  return (
    <nav class="mobile-tabs" aria-label={t("library.mobileResourceNavigation")}>
      {mobileModes.map(([mode, icon, label]) => (
        <button
          key={mode}
          class={active === mode ? "active" : ""}
          aria-current={active === mode ? "page" : undefined}
          onClick={() => {
            library.selectMode(mode);
            onCloseMenu();
          }}
        >
          <Icon name={icon} />
          {t(label)}
        </button>
      ))}
    </nav>
  );
}
