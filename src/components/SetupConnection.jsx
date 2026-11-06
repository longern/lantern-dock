import { Icon } from "./Icon.jsx";

export function SetupConnection({ wizard }) {
  const { form, update, chooseTransport } = wizard;
  const webtransport = form.transport === "webtransport";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        wizard.generate();
      }}
    >
      <div class="setup-choices" role="group" aria-label="连接方式">
        <button
          type="button"
          class={`setup-choice${!webtransport ? " selected" : ""}`}
          aria-pressed={!webtransport}
          onClick={() => chooseTransport("http")}
        >
          <Icon name="folder" />
          <strong>HTTPS / WebDAV</strong>
          <span>直接连接文件服务</span>
        </button>
        <button
          type="button"
          class={`setup-choice${webtransport ? " selected" : ""}`}
          aria-pressed={webtransport}
          onClick={() => chooseTransport("webtransport")}
        >
          <Icon name="plug" />
          <strong>WebTransport</strong>
          <span>通过 bridge 网关连接</span>
        </button>
      </div>
      <label class="form-label" for="setup-endpoint">
        {webtransport ? "WebTransport 网关地址" : "WebDAV 服务地址"}
      </label>
      <input
        id="setup-endpoint"
        type="url"
        required
        value={form.endpoint}
        autoComplete="url"
        placeholder={
          webtransport
            ? "https://bridge.example.com:4433/webtransport"
            : "https://files.example.com/dav/public/"
        }
        onInput={(event) => update("endpoint", event.currentTarget.value)}
        aria-describedby="setup-endpoint-help"
      />
      <p id="setup-endpoint-help" class="field-note">
        {webtransport
          ? "填写以 /webtransport 结尾的完整网关地址。"
          : "填写服务地址，默认使用 /dav/；完整 WebDAV 地址会自动识别根目录。"}
      </p>
      <details class="setup-advanced">
        <summary>高级设置</summary>
        <label class="form-label" for="setup-name">
          资源名称
        </label>
        <input
          id="setup-name"
          value={form.name}
          maxLength="100"
          onInput={(event) => update("name", event.currentTarget.value)}
        />
        <div class="setup-fields">
          <div>
            <label class="form-label" for="setup-root">
              WebDAV 根目录
            </label>
            <input
              id="setup-root"
              value={form.rootPath}
              placeholder={
                webtransport ? "/dav/（默认）" : "自动识别，默认 /dav/"
              }
              onInput={(event) => update("rootPath", event.currentTarget.value)}
            />
          </div>
          <div>
            <label class="form-label" for="setup-auth">
              后端认证
            </label>
            <select
              id="setup-auth"
              value={form.auth}
              onChange={(event) => update("auth", event.currentTarget.value)}
            >
              <option value="none">无需认证</option>
              <option value="basic">用户名与密码（Basic）</option>
              <option value="bearer">访问令牌（Bearer）</option>
            </select>
          </div>
        </div>
        {webtransport && (
          <>
            <label class="form-label" for="setup-certificate">
              网关证书
            </label>
            <select
              id="setup-certificate"
              value={form.certificateMode}
              onChange={(event) =>
                update("certificateMode", event.currentTarget.value)
              }
            >
              <option value="pinned">短期证书 + 自动更新</option>
              <option value="webpki">公开受信任的 HTTPS 证书</option>
            </select>
            <label class="setup-checkbox">
              <input
                type="checkbox"
                checked={form.gatewayAuth}
                onChange={(event) =>
                  update("gatewayAuth", event.currentTarget.checked)
                }
              />
              网关要求访问令牌
            </label>
          </>
        )}
        <p class="field-note">账号和访问令牌在连接时填写。</p>
      </details>
      <div class="setup-actions setup-actions-end">
        <button type="submit" class="primary-button">
          生成配置
          <Icon name="chevron-right" />
        </button>
      </div>
    </form>
  );
}
