import { backendPaths } from "./backend-paths.js";

export const backendDefaults = Object.freeze({
  name: "My files",
  transport: "http",
  rootPath: backendPaths.files,
  auth: "none",
  certificateMode: "pinned",
});

export function defaultBackendRoot(transport, endpoint) {
  return transport === "http" && endpoint.pathname !== "/"
    ? endpoint.pathname
    : backendDefaults.rootPath;
}

export function backendAddress(env) {
  const webdav = env.WEBDAV_URL?.trim(),
    webtransport = env.WEBTRANSPORT_URL?.trim();
  if (webdav)
    return {
      transport: "http",
      endpoint: webdav,
      conflict: !!webtransport,
    };
  if (webtransport)
    return { transport: "webtransport", endpoint: webtransport };
  return {
    transport: env.BACKEND_TRANSPORT || backendDefaults.transport,
    endpoint: env.BACKEND_ENDPOINT?.trim() || "",
  };
}
