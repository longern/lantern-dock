import { t } from "../../shared/i18n.js";
import { coreError } from "./errors.js";
import { normalizePath } from "./dav.js";
import {
  backendDefaults as defaults,
  defaultBackendRoot,
} from "../../shared/backend-defaults.js";

export function setupVariables(form, resetVariables = []) {
  const defaultName = t("core.defaultLibraryName");
  const enteredName = (form.name || "").trim();
  const name = enteredName || defaultName;
  if (/[\x00-\x1f]/.test(name)) throw coreError("INVALID_LIBRARY_NAME");
  if (!["http", "webtransport"].includes(form.transport))
    throw coreError("TRANSPORT_REQUIRED");
  let endpoint;
  try {
    endpoint = new URL(form.endpoint.trim());
  } catch {
    throw coreError("BACKEND_URL_REQUIRED");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw coreError("BACKEND_URL_INVALID");
  if (form.transport === "webtransport" && endpoint.protocol !== "https:")
    throw coreError("WEBTRANSPORT_HTTPS_REQUIRED");
  let root;
  try {
    root = normalizePath(
      form.rootPath.trim() || defaultBackendRoot(form.transport, endpoint),
    );
  } catch {
    throw coreError("ROOT_PATH_INVALID");
  }
  if (!root.endsWith("/")) root += "/";
  if (!["none", "basic", "bearer"].includes(form.auth))
    throw coreError("AUTH_METHOD_REQUIRED");
  const vars = {
    [form.transport === "http" ? "WEBDAV_URL" : "WEBTRANSPORT_URL"]:
      form.transport === "http"
        ? endpoint.origin + (root === "/" ? "" : root)
        : endpoint.href,
  };
  // Keep an explicit reset only when an existing variable would override the new defaults.
  const optional = (key, value, fallback) => {
    if (value !== fallback || resetVariables.includes(key)) vars[key] = value;
  };
  const otherAddress =
    form.transport === "http" ? "WEBTRANSPORT_URL" : "WEBDAV_URL";
  if (resetVariables.includes(otherAddress)) vars[otherAddress] = "";
  // Preserve an explicit name even if it matches the translated default.
  // An empty override restores the localized default for every visitor.
  if (enteredName && (form.nameConfigured || name !== defaultName))
    vars.BACKEND_NAME = name;
  else if (resetVariables.includes("BACKEND_NAME")) vars.BACKEND_NAME = "";
  optional("BACKEND_AUTH", form.auth, defaults.auth);
  if (form.transport === "webtransport") {
    optional("BACKEND_ROOT", root, defaults.rootPath);
    optional(
      "GATEWAY_AUTH",
      String(!!form.gatewayAuth),
      String(defaults.gatewayAuth),
    );
  } else if (root === "/") {
    // A bare origin uses /dav/ by default; preserve an explicit third-party root.
    vars.BACKEND_ROOT = "/";
  } else if (resetVariables.includes("BACKEND_ROOT")) vars.BACKEND_ROOT = "";
  if (form.transport === "webtransport") {
    if (!["pinned", "webpki"].includes(form.certificateMode))
      throw coreError("CERTIFICATE_MODE_REQUIRED");
    optional(
      "CERTIFICATE_MODE",
      form.certificateMode,
      defaults.certificateMode,
    );
  }
  return vars;
}

export function setupSnippet(vars, target, secretKey = "") {
  if (target === "wrangler") return JSON.stringify({ vars }, null, 2) + "\n";
  return (
    Object.entries(secretKey ? { ...vars, SECRET_KEY: secretKey } : vars)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n"
  );
}
