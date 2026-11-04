import { Icon } from "./Icon.jsx";
import { useMediaQuery } from "../hooks/useMediaQuery.js";

const modes = [
  ["all", "folder", "文件"],
  ["recent", "clock", "最近访问"],
  ["favorites", "star", "收藏"],
];
const kinds = [
  ["image", "图片"],
  ["text", "文档"],
  ["video", "视频"],
  ["audio", "音乐"],
];

export function Sidebar({ library, records, open, onClose, onSettings }) {
  const mobile = useMediaQuery("(max-width: 700px)");
  const select = (mode, kind) => {
    library.selectMode(mode, kind);
    onClose();
  };
  return (
    <>
      <aside
        id="sidebar"
        class={`sidebar${open ? " open" : ""}`}
        aria-label="主导航"
        inert={mobile && !open}
      >
        <a
          href="#"
          class="brand"
          onClick={(event) => {
            event.preventDefault();
            library.navigate(library.connection?.client.root || "/");
            onClose();
          }}
        >
          <span class="brand-symbol">
            <Icon name="portal" />
          </span>
          <span>LanternDock</span>
        </a>
        <nav class="main-nav" aria-label="资源导航">
          {modes.map(([mode, icon, label]) => (
            <button
              key={mode}
              class={`nav-item${library.mode === mode && !library.kind ? " active" : ""}`}
              aria-current={
                library.mode === mode && !library.kind ? "page" : undefined
              }
              onClick={() => select(mode)}
            >
              <Icon name={icon} />
              {label}
              {mode !== "recent" && (
                <span class="nav-count">
                  {mode === "all"
                    ? library.entries.length
                    : records.favorites.length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div class="nav-label">类型 · 当前目录</div>
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
          <span class="mini-chip">
            {library.backend?.transport === "demo"
              ? "演示"
              : library.backend?.transport === "webtransport"
                ? "WebTransport"
                : library.backend
                  ? "HTTP / HTTPS"
                  : "未连接"}
          </span>
          <button
            class="icon-button"
            aria-label="连接设置"
            onClick={onSettings}
          >
            <Icon name="settings" />
          </button>
        </div>
      </aside>
      <div class="sidebar-scrim" hidden={!open} onClick={onClose} />
    </>
  );
}

export function Topbar({ library, onMenu, onSettings }) {
  const root = library.connection?.client.root || "/";
  const crumbs = [
    {
      label:
        library.mode === "recent"
          ? "最近访问"
          : library.mode === "favorites"
            ? "收藏"
            : "文件",
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
  return (
    <header class="topbar">
      <button
        class="icon-button mobile-menu"
        aria-label="打开导航"
        onClick={onMenu}
      >
        <Icon name="menu" />
      </button>
      <a
        href="#"
        class="mobile-brand"
        onClick={(event) => {
          event.preventDefault();
          library.navigate(root);
        }}
      >
        LanternDock
      </a>
      <nav class="breadcrumbs" aria-label="文件路径">
        {crumbs.map((crumb, index) => (
          <span class="breadcrumb" key={`${index}:${crumb.path}`}>
            {index > 0 && <Icon name="chevron-right" />}
            <button
              aria-current={
                index === crumbs.length - 1 ? "location" : undefined
              }
              onClick={() => library.navigate(crumb.path)}
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>
      <div class="topbar-right">
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
        </label>
        <button
          id="refresh-button"
          class="icon-button"
          aria-label="刷新目录"
          onClick={library.refresh}
        >
          <Icon name="refresh" />
        </button>
        <button
          class="icon-button"
          aria-label="登录与连接设置"
          onClick={onSettings}
        >
          <Icon name="shield" />
        </button>
      </div>
    </header>
  );
}

export function MobileTabs({ library, onCloseMenu }) {
  return (
    <nav class="mobile-tabs" aria-label="移动端资源导航">
      {modes.map(([mode, icon, label]) => (
        <button
          key={mode}
          class={library.mode === mode && !library.kind ? "active" : ""}
          aria-current={
            library.mode === mode && !library.kind ? "page" : undefined
          }
          onClick={() => {
            library.selectMode(mode);
            onCloseMenu();
          }}
        >
          <Icon name={icon} />
          {mode === "recent" ? "最近" : label}
        </button>
      ))}
    </nav>
  );
}
