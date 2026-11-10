import { normalizePath, withinRoot, parseDAV, checkResponse } from "./dav.js";
import { limitedBytes } from "./content.js";
import { coreError } from "./errors.js";

export const searchNamespace = "urn:lantern-dock:search";
const capabilities = new WeakMap();
const escapeXML = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );

export async function discoverSearch(client, signal) {
  if (!client?.transport) return { supported: false, extended: false };
  if (capabilities.has(client)) return capabilities.get(client);
  const response = await client.transport.request(client.root, {
    method: "OPTIONS",
    signal,
  });
  signal?.throwIfAborted();
  await response.body?.cancel();
  if (![401, 407].includes(response.status) && !response.ok) {
    if ([403, 404, 405, 501].includes(response.status)) {
      const value = { supported: false, extended: false };
      capabilities.set(client, value);
      return value;
    }
  }
  checkResponse(response);
  const value = {
    supported: /<DAV:basicsearch>/i.test(response.headers.get("DASL") || ""),
    extended: (response.headers.get("DAV") || "").includes(
      `<${searchNamespace}>`,
    ),
  };
  capabilities.set(client, value);
  return value;
}

export function albumSearchBody(
  path,
  { cursor = "", refresh = false, extended = false } = {},
) {
  path = normalizePath(path).replace(/\/?$/, "/");
  return `<?xml version="1.0" encoding="utf-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:l="${searchNamespace}"><d:basicsearch>
<d:select><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/><d:getetag/></d:prop></d:select>
<d:from><d:scope><d:href>${escapeXML(path)}</d:href><d:depth>infinity</d:depth></d:scope></d:from>
<d:where><d:and><d:not><d:is-collection/></d:not><d:or><d:like><d:prop><d:getcontenttype/></d:prop><d:literal>image/%</d:literal></d:like><d:like><d:prop><d:getcontenttype/></d:prop><d:literal>video/%</d:literal></d:like></d:or></d:and></d:where>
<d:orderby><d:order><d:prop><d:getlastmodified/></d:prop><d:descending/></d:order><d:order><d:prop><d:displayname/></d:prop><d:ascending/></d:order></d:orderby>
<d:limit><d:nresults>128</d:nresults></d:limit>
${extended && cursor ? `<l:cursor>${escapeXML(cursor)}</l:cursor>` : ""}${extended && refresh ? "<l:refresh/>" : ""}
</d:basicsearch></d:searchrequest>`;
}

const children = (node, namespace, name) =>
  Array.from(node.children).filter(
    (n) => n.namespaceURI === namespace && n.localName === name,
  );
export function parseSearchPage(xml, path, root, extended) {
  // parseDAV applies the same XML and path confinement checks as ordinary
  // listings; recursive results are enabled only for this dedicated query.
  const entries = parseDAV(xml, path, root, { recursive: true }).filter(
    (item) => ["image", "video"].includes(item.kind),
  );
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const node = doc.documentElement;
  const partial = children(node, "DAV:", "response").some((response) =>
    children(response, "DAV:", "status").some((status) =>
      /^HTTP\/\d\.\d 507\b/.test(status.textContent.trim()),
    ),
  );
  let cursor = "",
    indexState = null,
    revision = "";
  if (extended) {
    const cursors = children(node, searchNamespace, "next-cursor");
    if (cursors.length > 1) throw coreError("SEARCH_INVALID");
    cursor = cursors[0]?.textContent.trim() || "";
    if (cursor.length > 8192 || /[\x00-\x20\x7f]/.test(cursor))
      throw coreError("SEARCH_INVALID");
    const states = children(node, searchNamespace, "index-state");
    if (states.length > 1) throw coreError("SEARCH_INVALID");
    if (states.length) {
      const statuses = children(states[0], searchNamespace, "status");
      const revisions = children(states[0], searchNamespace, "revision");
      indexState = statuses[0]?.textContent.trim();
      revision = revisions[0]?.textContent.trim() || "";
      if (
        statuses.length !== 1 ||
        revisions.length !== 1 ||
        !["scanning", "ready", "error"].includes(indexState) ||
        !/^[a-zA-Z0-9._~-]{1,256}$/.test(revision)
      )
        throw coreError("SEARCH_INVALID");
    }
    if (cursor && !revision) throw coreError("SEARCH_INVALID");
  }
  return { entries, cursor, indexState, revision, partial };
}

export async function searchAlbum(client, path, options = {}, signal) {
  path = normalizePath(path).replace(/\/?$/, "/");
  if (!withinRoot(path, client.root)) throw coreError("OUTSIDE_ROOT");
  const service = await discoverSearch(client, signal);
  signal?.throwIfAborted();
  if (!service.supported) {
    const entries =
      (!options.refresh && client.cached?.(path)) ||
      (await client.list(path, signal, { force: options.refresh }));
    return {
      entries,
      cursor: "",
      indexState: null,
      revision: "",
      partial: false,
      supported: false,
    };
  }
  const response = await client.transport.request(path, {
    method: "SEARCH",
    signal,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      Accept: "application/xml",
    },
    body: albumSearchBody(path, { ...options, extended: service.extended }),
  });
  if ([405, 501].includes(response.status)) {
    await response.body?.cancel();
    capabilities.set(client, { supported: false, extended: false });
    return searchAlbum(client, path, options, signal);
  }
  if (response.status === 409 && service.extended) {
    await response.body?.cancel();
    throw coreError("SEARCH_CURSOR_EXPIRED");
  }
  checkResponse(response);
  const xml = new TextDecoder().decode(
    await limitedBytes(response, 8 * 1024 * 1024, signal),
  );
  return {
    ...parseSearchPage(xml, path, client.root, service.extended),
    supported: true,
  };
}
