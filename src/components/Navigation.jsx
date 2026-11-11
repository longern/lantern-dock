import { flushSync } from "preact/compat";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../../shared/i18n.js";
import { Icon } from "./Icon.jsx";
import { Menu } from "./Menu.jsx";
import { useCompactLayout } from "../hooks/useMediaQuery.js";
import { useSession } from "../hooks/useSession.jsx";
import { accountHref } from "../../shared/routes.js";
import { siteTitle } from "../lib/site-title.js";

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

export function Sidebar({ library, onSettings }) {
  const { identity } = useSession();
  const accountName =
    identity.status === "authenticated" ? identity.user.name?.trim() : "";
  const accountLabel = t("library.myAccount");
  const accountTitle =
    accountName ||
    (identity.status === "signed-out" ? t("account.guest") : accountLabel);
  const content = (
    <>
      <div class="sidebar-heading">
        <a
          href="/"
          class="brand"
          onClick={(event) => {
            event.preventDefault();
            library.selectMode("home");
          }}
        >
          <span class="brand-symbol">
            <Icon name="portal" />
          </span>
          <span>{siteTitle}</span>
        </a>
      </div>
      <nav class="main-nav" aria-label={t("library.resourceNavigation")}>
        {modes.map(([mode, icon, label]) => (
          <button
            key={mode}
            class={`nav-item${library.mode === mode ? " active" : ""}`}
            aria-current={library.mode === mode ? "page" : undefined}
            onClick={() => library.selectMode(mode)}
          >
            <Icon name={icon} />
            {t(label)}
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
            onClick={() => library.selectMode("all", kind)}
          >
            <Icon name={kind} />
            {t(label)}
          </button>
        ))}
      </nav>
      <div class="sidebar-spacer" />
      <div class="sidebar-bottom">
        <Menu
          triggerId="account-menu-trigger"
          label={
            accountTitle === accountLabel
              ? accountLabel
              : `${accountLabel} · ${accountTitle}`
          }
          triggerClassName="nav-item sidebar-account-trigger"
          triggerContent={
            <>
              <Icon name="user" />
              <span
                class="sidebar-account-name"
                title={accountName || undefined}
              >
                {accountTitle}
              </span>
              <Icon name="chevron-down" class="sidebar-account-chevron" />
            </>
          }
          header={
            accountName && (
              <div class="sidebar-account-identity">{accountName}</div>
            )
          }
          actions={[
            {
              key: "account",
              icon: "user",
              label: t("library.myAccount"),
              onSelect: () =>
                location.assign(
                  accountHref(location.pathname + location.search),
                ),
            },
            {
              key: "settings",
              icon: "settings",
              label: t("library.connectionSettings"),
              onSelect: onSettings,
            },
          ]}
        />
      </div>
    </>
  );
  return (
    <aside
      id="sidebar"
      class="sidebar"
      aria-label={t("library.mainNavigation")}
    >
      {content}
    </aside>
  );
}

export function Topbar({
  library,
  actions,
  transferAction,
  intakeAction,
  hideRefresh = false,
}) {
  const mobile = useCompactLayout();
  const home = library.mode === "home";
  const mobileFiles = mobile && library.mode === "all";
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchInput = useRef(null);
  const searchToggle = useRef(null);
  const filesSearchVisible = mobileFiles && (searchExpanded || !!library.query);
  const closeSearch = () => {
    flushSync(() => {
      setSearchExpanded(false);
      library.setQuery("");
    });
    searchToggle.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    setSearchExpanded(false);
  }, [mobile, library.mode, library.path, library.kind]);
  const root = library.connection?.client.root || "/";
  const crumbs = [
    {
      label:
        library.mode === "favorites"
          ? t("library.favorites")
          : t("library.files"),
      path: root,
    },
  ];
  if (library.mode === "all") {
    crumbs.push({
      label: library.backend?.name || t("library.resources"),
      path: root,
    });
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
        ref={searchInput}
        id="search"
        type="search"
        value={library.query}
        onFocus={() => {
          if (mobileFiles) setSearchExpanded(true);
        }}
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
            if (mobileFiles) setSearchExpanded(true);
            library.setQuery("");
            searchInput.current?.focus();
          }}
        >
          <Icon name="x" />
        </button>
      )}
    </label>
  );
  return (
    <div
      class="browser-header"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          filesSearchVisible &&
          !event.defaultPrevented
        ) {
          event.preventDefault();
          event.stopPropagation();
          closeSearch();
        }
      }}
    >
      <header
        class={`topbar${actions || transferAction ? " has-actions" : ""}`}
      >
        {mobileFiles ? (
          <span class="mobile-brand">{t("library.files")}</span>
        ) : (
          <a
            href="/"
            class="mobile-brand"
            onClick={(event) => {
              event.preventDefault();
              library.selectMode("home");
            }}
          >
            {siteTitle}
          </a>
        )}
        {!mobile && !home && breadcrumbs}
        <div class="topbar-right">
          {!mobile && home && search}
          {intakeAction}
          {!hideRefresh && (
            <button
              id="refresh-button"
              class={`icon-button${actions || transferAction ? "" : " edge-end"}`}
              aria-label={t("library.refreshDirectory")}
              title={t("library.refresh")}
              aria-busy={library.loading}
              disabled={library.loading}
              onClick={library.refresh}
            >
              <Icon name="refresh" />
            </button>
          )}
          {mobileFiles && (
            <button
              ref={searchToggle}
              type="button"
              class="icon-button mobile-search-toggle"
              aria-label={t(
                filesSearchVisible
                  ? "library.closeSearch"
                  : "library.searchFiles",
              )}
              aria-expanded={filesSearchVisible}
              aria-controls={filesSearchVisible ? "search" : undefined}
              onClick={() => {
                if (filesSearchVisible) {
                  closeSearch();
                  return;
                }
                // Mount and focus in the tap handler so mobile keyboards can open.
                flushSync(() => setSearchExpanded(true));
                searchInput.current?.focus({ preventScroll: true });
              }}
            >
              <Icon name={filesSearchVisible ? "x" : "search"} />
            </button>
          )}
          {transferAction}
          {actions && <div class="header-actions">{actions}</div>}
        </div>
      </header>
      {mobile && (
        <div class={home ? "mobile-home-search" : "mobile-file-tools"}>
          {home || filesSearchVisible ? search : breadcrumbs}
        </div>
      )}
    </div>
  );
}

export function MobileTabs({ library }) {
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
          }}
        >
          <Icon name={icon} />
          {t(label)}
        </button>
      ))}
    </nav>
  );
}
