import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";

export function ConnectionDialog({
  backend,
  credentials,
  onConnect,
  onForget,
  onClose,
  feedback,
}) {
  const dialog = useRef(null);
  const [form, setForm] = useState({
    ...credentials,
    mode:
      credentials.mode === "none" ? backend?.auth || "none" : credentials.mode,
  });
  const field = (name, value) =>
    setForm((current) => ({ ...current, [name]: value }));
  useEffect(() => {
    const node = dialog.current;
    node.showModal();
    return () => node.close();
  }, []);
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
    <dialog
      ref={dialog}
      class="settings-dialog"
      aria-labelledby="settings-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
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
        <p class="dialog-intro">登录信息仅保存在当前页面。</p>
        <div class="endpoint-box">
          <span class="mini-chip">
            {backend?.transport === "demo"
              ? "演示空间"
              : backend?.transport === "webtransport"
                ? "WebTransport"
                : "HTTP / HTTPS"}
          </span>
          <strong>
            {backend?.endpoint || "请在 Worker 环境变量中配置 BACKEND_ENDPOINT"}
          </strong>
          <span>{backend && `根目录 ${backend.rootPath}`}</span>
        </div>
        <label class="form-label" for="auth-mode">
          后端认证
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
        {form.mode === "bearer" && input("bearer", "后端访问令牌")}
        {backend?.gatewayAuth && input("gatewayToken", "Bridge 网关令牌")}
        <p class="field-note">
          {backend?.transport === "webtransport"
            ? "证书哈希由 Worker 提供，文件通过 WebTransport 直连网关。"
            : backend?.transport === "demo"
              ? "当前为演示模式。部署时请配置后端地址和 WebDAV 根路径。"
              : "HTTP 后端需允许此网页的 CORS 请求，包括 PROPFIND、Depth 和 Authorization。"}
        </p>
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
    </dialog>
  );
}
