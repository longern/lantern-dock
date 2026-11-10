// Browser addresses are independent of the NAS's DAV/API namespaces.
const types = new Set(["image", "text", "video", "book", "audio"]);
const base = "https://routes.invalid";
export function resourcePath(value, directory = false) {
  if (typeof value !== "string" || value.startsWith("/") || value.length > 8192)
    throw new Error("Invalid resource path");
  const parts = value.replace(/\/$/, "").split("/");
  if (parts.length === 1 && !parts[0]) return "";
  return (
    parts
      .map((part) => {
        const name = decodeURIComponent(part);
        if (
          !name ||
          name === "." ||
          name === ".." ||
          /[\/\\\x00-\x1f\x7f]/.test(name)
        )
          throw new Error("Invalid resource path");
        return encodeURIComponent(name);
      })
      .join("/") + (directory ? "/" : "")
  );
}
export function filesHref(
  relative = "",
  { directory = false, album = false, type = "", query = "" } = {},
) {
  const params = new URLSearchParams();
  if (album) params.set("view", "album");
  if (types.has(type)) params.set("type", type);
  if (query) params.set("q", query);
  return (
    "/files/" +
    resourcePath(relative, directory) +
    (params.size ? "?" + params : "")
  );
}
export const albumHref = (relative = "") =>
  "/album/" + resourcePath(relative, true);
export function parseRoute(input) {
  try {
    const url = new URL(input, base),
      path = url.pathname;
    const common = {
      href: path + url.search,
      query: url.searchParams.get("q") || "",
      type: types.has(url.searchParams.get("type"))
        ? url.searchParams.get("type")
        : "",
    };
    if (path === "/")
      return { ...common, page: "library", surface: "home", directory: "" };
    if (["/favorites", "/me"].includes(path))
      return {
        ...common,
        page: "library",
        surface: path.slice(1),
        directory: "",
      };
    if (path === "/account") return { ...common, page: "account" };
    const member = /^\/admin\/users\/(ld_[A-Za-z0-9_-]{22})$/.exec(path)?.[1];
    if (
      member ||
      ["/admin", "/admin/links", "/admin/inbox", "/admin/users"].includes(path)
    )
      return {
        ...common,
        page: "admin",
        tab:
          member || path.endsWith("/users")
            ? "users"
            : path.endsWith("/links")
              ? "links"
              : "inbox",
        member,
      };
    if (path === "/upload")
      return {
        ...common,
        page: "upload",
        token: new URLSearchParams(url.hash.slice(1)).get("token") || "",
      };
    if (path.startsWith("/files/") || path.startsWith("/album/")) {
      const album = path.startsWith("/album/"),
        relative = resourcePath(path.slice(7), path.endsWith("/"));
      if (album && relative && !relative.endsWith("/"))
        return { page: "not-found" };
      const file =
        !album && relative && !relative.endsWith("/") ? relative : null;
      return {
        ...common,
        page: "library",
        surface: album ? "album" : "files",
        relative,
        file,
        directory: file
          ? relative.slice(0, relative.lastIndexOf("/") + 1)
          : relative,
        album: album || url.searchParams.get("view") === "album",
      };
    }
  } catch {
    /* Malformed paths render a local not-found page. */
  }
  return { page: "not-found" };
}
export function safeReturnPath(value, fallback = "/account") {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\x00-\x20\x7f#]/.test(value) ||
    value.length > 12000
  )
    return fallback;
  const route = parseRoute(value);
  return ["library", "account", "admin"].includes(route.page)
    ? new URL(value, base).pathname + new URL(value, base).search
    : fallback;
}
export function libraryLocation(route, state = {}) {
  let background = route;
  if (route.file && state.previewFrom) {
    const parsed = parseRoute(safeReturnPath(state.previewFrom, "/"));
    if (parsed.page === "library" && !parsed.file) background = parsed;
  } else if (route.file)
    background = {
      ...route,
      surface: route.album ? "album" : "files",
      relative: route.directory,
      file: null,
    };
  const surface = background.surface;
  let mode =
    surface === "home"
      ? "home"
      : surface === "favorites"
        ? "favorites"
        : surface === "me"
          ? "me"
          : "all";
  let kind = surface === "album" ? "album" : background.type;
  if (surface === "album" && state.surfaceFrom) {
    const parent = parseRoute(state.surfaceFrom);
    if (parent.surface === "home") {
      mode = "home";
      kind = parent.type;
    }
  }
  return {
    surface,
    mode,
    kind,
    query: background.query || "",
    directory: route.file ? route.directory : background.directory || "",
    backgroundHref: background.href,
  };
}
export function uploadHref(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error("Invalid upload token");
  return "/upload#token=" + token;
}
export function accountHref(returnTo = "/") {
  const target = safeReturnPath(returnTo, "/");
  return target === "/"
    ? "/account"
    : "/account?return=" + encodeURIComponent(target);
}
