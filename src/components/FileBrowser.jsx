import { useMemo } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { artwork } from "../lib/demo.js";
import { bytes, date } from "../lib/format.js";
import { Thumbnail } from "./Thumbnail.jsx";
import { fileCategories, matchesCategory } from "../lib/categories.js";

function FileCard({
  item,
  demo,
  client,
  side,
  selected,
  favorite,
  onOpen,
  onFavorite,
}) {
  return (
    <article
      class={`file-card${item.isDirectory ? " folder-card" : ""}${selected ? " selected" : ""}`}
    >
      <button
        class="file-open"
        data-path={item.path}
        aria-label={`${item.isDirectory ? "打开文件夹 " : "预览 "}${item.name}`}
        aria-pressed={item.isDirectory ? undefined : selected}
        onClick={() => onOpen(item)}
      >
        <div class={`file-art ${item.kind}`}>
          {demo && item.kind === "image" ? (
            <img
              src={`data:image/svg+xml,${encodeURIComponent(artwork(item.name))}`}
              alt=""
            />
          ) : (
            <>
              <Icon name={item.kind} />
              {["image", "video"].includes(item.kind) && (
                <Thumbnail item={item} client={client} side={side} />
              )}
              {!item.isDirectory && (
                <span class="extension">
                  {item.name.split(".").pop().slice(0, 6).toUpperCase()}
                </span>
              )}
            </>
          )}
        </div>
        <div class="file-info">
          <div class="file-name" title={item.name}>
            {item.name}
          </div>
          <div class="file-meta">
            <span>{item.isDirectory ? "文件夹" : bytes(item.size)}</span>
            <span class="separator">·</span>
            <span>{date(item.modified)}</span>
          </div>
        </div>
        <span class="row-modified">{date(item.modified, true)}</span>
        <span class="row-size">
          {item.isDirectory ? "—" : bytes(item.size)}
        </span>
      </button>
      <button
        class={`favorite-button${favorite ? " selected" : ""}`}
        aria-label={`${favorite ? "取消收藏 " : "收藏 "}${item.name}`}
        aria-pressed={favorite}
        onClick={() => onFavorite(item)}
      >
        <Icon name="star" />
      </button>
    </article>
  );
}

export function FileBrowser({
  library,
  records,
  selected,
  onPreview,
  onSettings,
}) {
  const entries = useMemo(() => {
    const source =
      library.mode === "favorites"
        ? records.favorites
        : library.mode === "recent"
          ? records.recent
          : library.entries;
    return source
      .filter(
        (item) =>
          matchesCategory(item, library.kind) &&
          item.name
            .toLocaleLowerCase()
            .includes(library.query.toLocaleLowerCase()),
      )
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        if (library.sort === "size") return (b.size || 0) - (a.size || 0);
        if (library.sort === "modified")
          return (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0);
        return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
      });
  }, [
    library.entries,
    records.favorites,
    records.recent,
    library.mode,
    library.kind,
    library.query,
    library.sort,
  ]);
  const busy = library.loading && library.mode === "all";
  const status = library.error
    ? "连接异常"
    : library.loading
      ? "连接中"
      : library.backend?.transport === "demo"
        ? "演示空间"
        : "已连接";
  return (
    <section class="content" aria-label="文件浏览器">
      <div class="file-toolbar">
        <div class="file-stats">
          <strong id="item-count">
            {busy
              ? "加载中…"
              : library.error
                ? "文件"
                : `${entries.length} 个项目`}
          </strong>
          {(library.error ||
            library.loading ||
            library.backend?.transport === "demo") && (
            <span
              class={`status-pill${library.error ? " error" : library.loading ? " loading" : ""}`}
              role="status"
            >
              <i />
              <span>{status}</span>
            </span>
          )}
          {library.kind && (
            <button
              class="filter-chip"
              onClick={() => library.selectMode("all")}
              aria-label="清除类型筛选"
            >
              {fileCategories.find(({ kind }) => kind === library.kind)?.label}
              <Icon name="x" />
            </button>
          )}
        </div>
        <div class="view-tools">
          <button
            class="icon-button mobile-refresh"
            aria-label="刷新目录"
            disabled={library.loading}
            aria-busy={library.loading}
            onClick={library.refresh}
          >
            <Icon name="refresh" />
          </button>
          <select
            aria-label="排序"
            value={library.sort}
            onChange={(event) => library.setSort(event.currentTarget.value)}
          >
            <option value="name">名称</option>
            <option value="modified">修改时间</option>
            <option value="size">大小</option>
          </select>
          <div class="view-switch" role="group" aria-label="显示方式">
            {["list", "grid"].map((view) => (
              <button
                key={view}
                class={library.view === view ? "active" : ""}
                aria-label={view === "list" ? "列表视图" : "网格视图"}
                aria-pressed={library.view === view}
                onClick={() => library.setView(view)}
              >
                <Icon name={view} />
              </button>
            ))}
          </div>
        </div>
      </div>
      {library.error && (
        <div class="empty-state">
          <span class="empty-symbol">
            <Icon name="cloud-off" />
          </span>
          <h2>无法读取文件</h2>
          <p>请重试，或检查连接设置。</p>
          <div class="empty-actions">
            <button
              class="primary-button"
              onClick={library.reconnect}
              disabled={library.loading}
            >
              <Icon name="refresh" />
              重试
            </button>
            <button class="secondary-button" onClick={onSettings}>
              连接设置
            </button>
          </div>
        </div>
      )}
      <div
        class="list-head"
        hidden={
          library.view !== "list" ||
          !!library.error ||
          (!busy && !entries.length)
        }
      >
        <span>文件名</span>
        <span>修改时间</span>
        <span>大小</span>
        <span />
      </div>
      <div
        id="file-list"
        class={`file-grid${library.view === "list" ? " list-layout" : ""}`}
        aria-live="polite"
        aria-busy={busy}
        aria-label="文件列表"
      >
        {busy && !entries.length
          ? Array.from({ length: 8 }, (_, index) => (
              <div class="skeleton" key={index} />
            ))
          : entries.map((item) => (
              <FileCard
                key={item.path}
                item={item}
                client={library.connection?.client}
                side={library.view === "list" ? 128 : 384}
                demo={library.backend?.transport === "demo"}
                selected={selected?.path === item.path}
                favorite={records.isFavorite(item)}
                onFavorite={records.toggleFavorite}
                onOpen={(item) =>
                  item.isDirectory
                    ? library.navigate(item.path)
                    : onPreview(item)
                }
              />
            ))}
      </div>
      {!busy && !entries.length && !library.error && (
        <div class="empty-state">
          <span class="empty-symbol">
            <Icon
              name={
                library.query
                  ? "search"
                  : library.mode === "favorites"
                    ? "star"
                    : library.mode === "recent"
                      ? "clock"
                      : "folder"
              }
            />
          </span>
          <h2>
            {library.query
              ? "没有找到匹配的文件"
              : library.mode === "favorites"
                ? "暂无收藏"
                : library.mode === "recent"
                  ? "暂无访问记录"
                  : "暂无文件"}
          </h2>
          <p>
            {library.query
              ? "试试其他关键词。"
              : library.mode === "favorites"
                ? "点击文件旁的星标，收藏常用文件。"
                : library.mode === "recent"
                  ? "打开过的文件会显示在这里。"
                  : library.kind
                    ? "当前文件夹没有此类文件。"
                    : "此文件夹还没有内容。"}
          </p>
          {library.query && (
            <button
              class="secondary-button"
              onClick={() => library.setQuery("")}
            >
              清除搜索
            </button>
          )}
          {!library.query && library.kind && (
            <button
              class="secondary-button"
              onClick={() => library.selectMode("all")}
            >
              查看全部文件
            </button>
          )}
          {!library.query && library.mode !== "all" && (
            <span class="empty-footnote">记录保存在此浏览器</span>
          )}
        </div>
      )}
    </section>
  );
}
