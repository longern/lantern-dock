import { t } from "../../shared/i18n.js";
import { identitySession, accountConnection, beginLogin, endLogin } from "./identity.js";

const identityState = (status = "loading", user = null, error = null) => ({ status, user, error });
const nasState = (status = "idle", account = null, error = null) => ({ status, account, error });

function sessionError(error, online) {
  if (error?.kind) return error;
  const value = error instanceof Error ? error : new Error(String(error));
  value.kind = error?.code === "LOGIN_REQUIRED" ? "session-expired"
    : !online ? "offline"
    : error?.status === 401 || error?.status === 403 ? "unauthorized"
      : error?.code === "NAS_NOT_CONFIGURED" ? "unconfigured"
        : error?.code === "IDENTITY_MISMATCH" ? "identity-mismatch"
          : "unavailable";
  return value;
}

// A page-scoped store, not a persisted credential cache. Worker identity and NAS
// authorization have independent states; neither gates the public library.
export function createSessionStore({
  readIdentity = identitySession,
  readNAS = accountConnection,
  startLogin = beginLogin,
  finishLogout = endLogin,
  isOnline = () => globalThis.navigator?.onLine !== false,
  now = Date.now,
  maxAge = 60_000,
  timeout = 15_000,
  onSessionChange = () => {},
} = {}) {
  let state = { identity: identityState(), nas: nasState() };
  let identityRequest, nasRequest, logoutRequest;
  let identityVersion = 0, nasVersion = 0;
  let identityUntil = -Infinity, nasAt = -Infinity;
  let disposed = false;
  const listeners = new Set();
  const publish = (next) => {
    if (disposed) return;
    state = { ...state, ...next };
    listeners.forEach((listener) => listener(state));
  };
  const cancelNAS = () => {
    nasVersion++;
    nasRequest?.controller.abort();
    nasRequest = null;
    nasAt = -Infinity;
  };
  const cancelIdentity = () => {
    identityVersion++;
    identityRequest?.controller.abort();
    identityRequest = null;
    identityUntil = -Infinity;
    cancelNAS();
  };
  // Bound requests even when a test transport or a broken backend ignores abort.
  const read = async (operation, controller) => {
    let timer, abort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        new Promise((_, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) abort();
          timer = setTimeout(() => {
            const error = new Error(t("account.sessionUnavailable"));
            error.kind = isOnline() ? "unavailable" : "offline";
            controller.abort(error);
          }, timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
    }
  };
  const refreshIdentity = () => {
    if (disposed) return Promise.resolve(state.identity);
    if (logoutRequest) return logoutRequest.then(() => state.identity, () => state.identity);
    if (identityRequest) return identityRequest.promise;
    cancelNAS();
    identityUntil = -Infinity;
    publish({ identity: identityState(), nas: nasState() });
    const version = ++identityVersion;
    const controller = new AbortController();
    const pending = { controller };
    identityRequest = pending;
    pending.promise = (async () => {
      try {
        if (!isOnline()) throw new Error(t("account.sessionOffline"));
        const value = await read(readIdentity, controller);
        if (disposed || version !== identityVersion) return state.identity;
        if (value?.authenticated === true && typeof value.user?.sub === "string" &&
            value.user.sub && typeof value.user.issuer === "string" && value.user.issuer) {
          const expires = value.expiresAt == null ? Infinity : Date.parse(value.expiresAt);
          if ((!Number.isFinite(expires) && expires !== Infinity) || expires <= now()) {
            throw new Error(t("account.sessionUnavailable"));
          }
          identityUntil = Math.min(now() + maxAge, expires);
          publish({ identity: identityState("authenticated", value.user) });
        } else if (value?.authenticated === false) {
          identityUntil = now() + maxAge;
          publish({ identity: identityState("signed-out") });
        } else {
          throw new Error(t("account.sessionUnavailable"));
        }
      } catch (error) {
        if (!disposed && version === identityVersion) {
          publish({ identity: identityState("error", null, sessionError(error, isOnline())) });
        }
      } finally {
        if (identityRequest === pending) identityRequest = null;
      }
      return state.identity;
    })();
    return pending.promise;
  };
  const ensureIdentity = () => identityRequest?.promise ||
    (now() < identityUntil ? Promise.resolve(state.identity) : refreshIdentity());

  const refreshNAS = () => {
    if (disposed || logoutRequest) return Promise.resolve(state.nas);
    if (nasRequest) return nasRequest.promise;
    // Starting an identity refresh may invalidate NAS requests. Finish that
    // first, then let concurrent callers join the single NAS request below.
    if (state.identity.status === "loading" || now() >= identityUntil) {
      return ensureIdentity().then(() => state.identity.status === "authenticated" ? refreshNAS() : state.nas);
    }
    if (state.identity.status !== "authenticated") return Promise.resolve(state.nas);
    const version = ++nasVersion;
    const user = state.identity.user;
    const controller = new AbortController();
    const pending = { controller };
    nasRequest = pending;
    publish({ nas: nasState("loading") });
    pending.promise = (async () => {
      try {
        if (!isOnline()) throw new Error(t("account.nasOffline"));
        const account = await read(async (signal) => {
          const info = await readNAS(signal);
          // The account check only needs metadata, never a long-lived transport
          // or a cached grant. Close even a late response after invalidation.
          info?.transport?.close();
          const { transport: _transport, ...metadata } = info || {};
          return metadata;
        }, controller);
        if (disposed || version !== nasVersion) return state.nas;
        if (account.user?.sub !== user.sub || account.user?.issuer !== user.issuer) {
          const error = new Error(t("account.identityMismatch"));
          error.code = "IDENTITY_MISMATCH";
          throw error;
        }
        publish({ nas: nasState("ready", account) });
        nasAt = now();
      } catch (error) {
        if (!disposed && version === nasVersion) {
          publish({ nas: nasState("error", null, sessionError(error, isOnline())) });
        }
      } finally {
        if (nasRequest === pending) nasRequest = null;
      }
      return state.nas;
    })();
    return pending.promise;
  };
  const ensureNAS = () => nasRequest?.promise ||
    (now() < identityUntil && now() - nasAt < maxAge ? Promise.resolve(state.nas) : refreshNAS());
  const invalidate = () => {
    cancelIdentity();
    publish({ identity: identityState(), nas: nasState() });
  };
  const login = async (signal) => {
    // Keep guest state stable while the cancelable sign-in dialog is open.
    await startLogin(signal);
    invalidate();
    onSessionChange();
  };
  const logout = () => {
    if (logoutRequest) return logoutRequest;
    cancelIdentity();
    publish({ nas: nasState() });
    logoutRequest = Promise.resolve().then(finishLogout).then(() => {
      cancelIdentity();
      publish({ identity: identityState("signed-out"), nas: nasState() });
      identityUntil = now() + maxAge;
      onSessionChange();
    }, (error) => {
      // A failed logout is not evidence that the HttpOnly session disappeared.
      throw error;
    }).finally(() => { logoutRequest = null; });
    return logoutRequest;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    ensureIdentity, ensureNAS, refreshIdentity, refreshNAS, invalidate, login, logout,
    dispose() { cancelIdentity(); disposed = true; listeners.clear(); },
  };
}
