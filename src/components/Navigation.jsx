import { Icon } from "./Icon.jsx";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { Dialog } from "./Dialog.jsx";
import { useEffect } from "preact/hooks";

const modes = [
  ["home", "home", "首页"],
  ["all", "folder", "文件"],
  ["favorites", "star", "收藏"],
];
const kinds = [
  ["image", "图片"],
  ["text", "文档"],
  ["video", "视频"],
  ["book", "图书"],
  ["audio", "音乐"],
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
          <button class="icon-button" aria-label="关闭导航" onClick={onClose}>
            <Icon name="x" />
          </button>
        )}
      </div>
      <nav class="main-nav" aria-label="资源导航">
        {modes.map(([mode, icon, label]) => (
          <button
            key={mode}
            class={`nav-item${library.mode === mode ? " active" : ""}`}
            aria-current={library.mode === mode ? "page" : undefined}
            onClick={() => select(mode)}
          >
            <Icon name={icon} />
            {label}
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
      <div class="nav-label" title="筛选当前文件夹">
        文件类型
      </div>
      <nav class="type-nav" aria-label="文件类型">
        {kinds.map(([kind, label]) => (
          <button
            key={kind}
            class={`nav-item${library.kind === kind ? " active" : ""}`}
            aria-current={library.kind === kind ? "page" : undefined}
            onClick={() => select("all", kind)}
          >
            <Icon name={kind} />
            {label}
          </button>
        ))}
      </nav>
      <div class="sidebar-spacer" />
      <div class="sidebar-bottom">
        <a class="icon-button" href="#/account" aria-label="我的账户">
          <Icon name="user" />
        </a>
        <button
          class="sidebar-settings"
          aria-label="连接设置"
          onClick={onSettings}
        >
          <Icon name="settings" />
          <span>连接设置</span>
        </button>
      </div>
    </>
  );
  return mobile ? (
    <Dialog
      id="sidebar"
      class="sidebar sidebar-drawer"
      aria-label="主导航"
      open={open}
      onClose={onClose}
    >
      {content}
    </Dialog>
  ) : (
    <aside id="sidebar" class="sidebar" aria-label="主导航">
      {content}
    </aside>
  );
}

export function Topbar({ library, menuOpen, onMenu, onSettings }) {
  const mobile = useMediaQuery("(max-width: 700px)");
  const home = library.mode === "home";
  const root = library.connection?.client.root || "/";
  const crumbs = [
    {
      label: library.mode === "favorites" ? "收藏" : "文件",
      path: root,
    },
  ];
  if (library.mode === "all") {
    crumbs.push({ label: library.backend?.name || "资源", path: root });
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
    <nav class="breadcrumbs" aria-label="文件路径">
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
        placeholder="搜索文件"
        aria-label="搜索文件"
      />
      {library.query && (
        <button
          type="button"
          class="search-clear icon-button"
          aria-label="清除搜索"
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
      <header class="topbar">
        <button
          class="icon-button mobile-menu"
          aria-label="打开导航"
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
          {!mobile && search}
          <button
            id="refresh-button"
            class="icon-button"
            aria-label="刷新目录"
            title="刷新"
            aria-busy={library.loading}
            disabled={library.loading}
            onClick={library.refresh}
          >
            <Icon name="refresh" />
          </button>
          <button
            class="icon-button"
            aria-label="连接设置"
            title="连接设置"
            onClick={onSettings}
          >
            <Icon name="settings" />
          </button>
          <a
            class="account-entry icon-button"
            href="#/account"
            aria-label="我的账户"
            title="我的账户"
          >
            <Icon name="user" />
          </a>
        </div>
      </header>
      {mobile && (
        <div class="mobile-file-tools">
          {!home && breadcrumbs}
          {search}
        </div>
      )}
    </div>
  );
}

export function MobileTabs({ library, onCloseMenu }) {
  return (
    <nav class="mobile-tabs" aria-label="移动端资源导航">
      {modes.map(([mode, icon, label]) => (
        <button
          key={mode}
          class={library.mode === mode ? "active" : ""}
          aria-current={library.mode === mode ? "page" : undefined}
          onClick={() => {
            library.selectMode(mode);
            onCloseMenu();
          }}
        >
          <Icon name={icon} />
          {label}
        </button>
      ))}
    </nav>
  );
}
