export const backendDefaults = Object.freeze({
  name: "我的文件",
  transport: "http",
  rootPath: "/",
  auth: "none",
  gatewayAuth: true,
  certificateMode: "pinned",
});

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
