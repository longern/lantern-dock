import { useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { Dialog } from "./Dialog.jsx";
import { useMediaQuery } from "../hooks/useMediaQuery.js";

export function ConnectionDialog({
  backend,
  credentials,
  onConnect,
  onForget,
  onClose,
  onExited,
  open,
  feedback,
}) {
  const mobile = useMediaQuery("(max-width: 700px)");
  const [form, setForm] = useState({
    ...credentials,
    mode:
      credentials.mode === "none" ? backend?.auth || "none" : credentials.mode,
  });
  const field = (name, value) =>
    setForm((current) => ({ ...current, [name]: value }));
  const input = (name, label, type = "password", autocomplete = "off") => (
    <>
      <label class="form-label" for={name}>
        {label}
      </label>
      <input
        id={name}
        type={type}
        autoComplete={autocomplete}
        value={form[name] || ""}
        onInput={(event) => field(name, event.currentTarget.value)}
      />
    </>
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      onExited={onExited}
      fallbackFocus={mobile
        ? '.topbar button[aria-label="打开导航"]'
        : '#sidebar button[aria-label="连接设置"]'}
      class="settings-dialog"
      aria-labelledby="settings-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onConnect({
            ...form,
            bearer: form.bearer?.trim(),
            gatewayToken: form.gatewayToken?.trim(),
          });
        }}
      >
        <div class="dialog-heading">
          <h2 id="settings-title">连接设置</h2>
          <button
            type="button"
            class="icon-button"
            aria-label="关闭设置"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </div>
        <div class="endpoint-box">
          <span class="mini-chip">
            {backend?.transport === "demo"
              ? "演示空间"
              : backend?.transport === "webtransport"
                ? "WebTransport"
                : "HTTP / HTTPS"}
          </span>
          <strong>{backend?.endpoint || "演示文件空间"}</strong>
          <span>{backend && `根目录 ${backend.rootPath}`}</span>
        </div>
        <label class="form-label" for="auth-mode">
          访问方式
        </label>
        <select
          id="auth-mode"
          value={form.mode}
          onChange={(event) => field("mode", event.currentTarget.value)}
        >
          <option value="none">无需认证</option>
          <option value="basic">用户名与密码（Basic）</option>
          <option value="bearer">访问令牌（Bearer）</option>
        </select>
        {form.mode === "basic" && (
          <>
            {input("username", "用户名", "text", "username")}
            {input("password", "密码", "password", "current-password")}
          </>
        )}
        {form.mode === "bearer" && input("bearer", "访问令牌")}
        {backend?.gatewayAuth && input("gatewayToken", "网关令牌")}
        <p class="field-note">凭据仅用于当前页面，刷新后清除。</p>
        <details class="connection-help">
          <summary>连接帮助</summary>
          <p class="field-note">
            {backend?.transport === "webtransport"
              ? "请确认 UDP 隧道可用、网关允许当前站点来源，且证书已更新。"
              : backend?.transport === "demo"
                ? "连接真实文件服务后，即可浏览和下载你的文件。"
                : "WebDAV 服务需允许当前站点的 CORS 请求，以及 PROPFIND、Depth 和 Authorization。"}
          </p>
        </details>
        <div class="dialog-actions">
          <button
            type="button"
            class="text-button"
            onClick={() => {
              setForm({ mode: "none" });
              onForget();
            }}
          >
            清除登录信息
          </button>
          <button type="submit" class="primary-button">
            <Icon name="plug" />
            连接
          </button>
        </div>
      </form>
      {feedback}
    </Dialog>
  );
}
