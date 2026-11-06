import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import {
  identitySession,
  accountConnection,
  beginLogin,
  endLogin,
} from "../lib/identity.js";

export function AccountPage() {
  const [session, setSession] = useState(null);
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [accountError, setAccountError] = useState("");
  const [copied, setCopied] = useState("");
  const [revision, setRevision] = useState(0);
  const connection = useRef(null);
  useEffect(() => {
    const query = new URLSearchParams(location.hash.split("?")[1] || "");
    if (query.has("error")) {
      setError(query.get("error"));
      history.replaceState(null, "", "/#/account");
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setAccount(null);
    setAccountError("");
    (async () => {
      try {
        const value = await identitySession(controller.signal);
        if (controller.signal.aborted) return;
        setSession(value.authenticated ? value : null);
        if (value.authenticated) {
          try {
            const info = await accountConnection(controller.signal);
            if (controller.signal.aborted) {
              info.transport.close();
              return;
            }
            if (
              info.user.sub !== value.user.sub ||
              info.user.issuer !== value.user.issuer
            ) {
              info.transport.close();
              throw new Error("账户身份不匹配，请退出后重新登录。");
            }
            connection.current = info.transport;
            setAccount(info);
          } catch (err) {
            if (!controller.signal.aborted) setAccountError(err.message);
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    const stop = () => connection.current?.close();
    window.addEventListener("pagehide", stop);
    return () => {
      controller.abort();
      stop();
      connection.current = null;
      window.removeEventListener("pagehide", stop);
    };
  }, [revision]);
  const copy = async (value, label) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(`已复制${label}`);
    } catch {
      setCopied("复制失败，请手动选中内容复制。");
    }
  };
  const login = async () => {
    setBusy(true);
    setError("");
    try {
      await beginLogin();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  const logout = async () => {
    setBusy(true);
    setError("");
    try {
      await endLogin();
      connection.current?.close();
      connection.current = null;
      setSession(null);
      setAccount(null);
      setAccountError("");
      setCopied("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main class="setup-page account-page">
      <a class="setup-brand" href="#/">
        <span class="brand-symbol">
          <Icon name="portal" />
        </span>
        <span>LanternDock</span>
      </a>
      <section class="setup-card" aria-labelledby="account-title">
        <div class="setup-intro">
          <span class="setup-eyebrow">我的账户</span>
          <h1 id="account-title">
            {session ? session.user.name || "已登录" : "登录你的账户"}
          </h1>
          <p>
            {session
              ? "这是你的站点身份，访问权限由 NAS 管理。"
              : "使用站点配置的统一登录服务继续。公开文件和收件链接无需登录。"}
          </p>
        </div>
        {loading && (
          <p class="upload-message" role="status">
            正在检查账户…
          </p>
        )}
        {error && (
          <p class="account-notice error" role="alert">
            {error}
          </p>
        )}
        {session && (
          <>
            <dl class="account-details">
              <div>
                <dt>身份签发方</dt>
                <dd>{session.user.issuer}</dd>
              </div>
              {session.user.email && (
                <div>
                  <dt>邮箱</dt>
                  <dd>{session.user.email}</dd>
                </div>
              )}
              <div>
                <dt>站点身份</dt>
                <dd>
                  {account
                    ? account.user.role === "admin"
                      ? "管理员"
                      : "普通用户"
                    : "正在等待 NAS 验证"}
                </dd>
              </div>
            </dl>
            <label class="form-label" for="account-sub">
              用户标识（sub）
            </label>
            <div class="account-copy">
              <input id="account-sub" readOnly value={session.user.sub} />
              <button
                class="secondary-button"
                onClick={() => copy(session.user.sub, " sub")}
              >
                <Icon name="copy" />
                复制 sub
              </button>
            </div>
            {account && !account.administratorConfigured && (
              <div class="account-notice">
                <h2>尚未配置管理员</h2>
                <p>
                  把下面的值填入 NAS 服务的 <code>ADMIN_SUBJECTS</code>{" "}
                  环境变量，重启 NAS 服务后点击“重新检测”。
                </p>
                <label class="form-label" for="account-admins">
                  ADMIN_SUBJECTS 的值
                </label>
                <textarea
                  id="account-admins"
                  readOnly
                  rows={2}
                  value={JSON.stringify([session.user.sub])}
                />
                <button
                  class="secondary-button"
                  onClick={() =>
                    copy(JSON.stringify([session.user.sub]), "管理员配置")
                  }
                >
                  <Icon name="copy" />
                  复制管理员配置
                </button>
              </div>
            )}
            {account?.user.role === "admin" && (
              <p class="account-notice">
                管理员身份已生效。收件链接目前通过 NAS 本地 CLI 管理。
              </p>
            )}
            {accountError && (
              <p class="account-notice error" role="alert">
                {accountError}
              </p>
            )}
          </>
        )}
        {copied && (
          <p class="account-feedback" role="status">
            {copied}
          </p>
        )}
        <div class="account-actions">
          {!session && !loading && (
            <button class="primary-button" disabled={busy} onClick={login}>
              <Icon name="user" />
              {busy ? "正在前往登录…" : "统一登录"}
            </button>
          )}
          {session && (
            <button class="secondary-button" disabled={busy} onClick={logout}>
              <Icon name="logout" />
              退出登录
            </button>
          )}
          <button
            class="text-button"
            disabled={loading || busy}
            onClick={() => {
              setError("");
              setRevision((value) => value + 1);
            }}
          >
            重新检测
          </button>
          <a class="upload-back" href="#/">
            返回公开文件
          </a>
        </div>
      </section>
    </main>
  );
}
