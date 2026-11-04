import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { setupVariables, setupSnippet } from "../lib/setup.js";

const steps = ["选择连接方式", "填写后端信息", "应用配置"];
const reasons = {
  "missing-backend": "还差一步，就能连接你的文件。",
  "missing-certificates": "网关地址已配置，接下来准备连接证书。",
  "invalid-configuration": "一起检查并完善后端配置。",
};

export function SetupWizard({ setup, checking, onRetry, onDemo, notify }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    name: "我的文件",
    transport: "http",
    endpoint: "",
    rootPath: "/",
    auth: "none",
    gatewayAuth: false,
    certificateMode: "pinned",
    ...setup.backend,
  });
  const [target, setTarget] = useState(
    ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
      ? "local"
      : "worker",
  );
  const [vars, setVars] = useState(null);
  const heading = useRef(null),
    code = useRef(null);
  const update = (field, value) =>
    setForm((current) => ({ ...current, [field]: value }));
  useLayoutEffect(() => {
    if (step > 0) heading.current?.focus();
  }, [step]);
  const snippet = vars ? setupSnippet(vars, target) : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      notify("已复制配置。");
    } catch {
      code.current?.focus();
      code.current?.select();
      notify("请复制已选中的配置文本。");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([snippet], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download =
      target === "local" ? ".dev.vars" : "lantern-dock.vars.json";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <main class="setup-page">
      <header class="setup-brand">
        <span class="brand-symbol">
          <Icon name="portal" />
        </span>
        <span>LanternDock</span>
      </header>
      <section class="setup-card" aria-labelledby="setup-title">
        <div class="setup-intro">
          <span class="setup-eyebrow">欢迎使用 LanternDock</span>
          <h1 id="setup-title">连接你的文件空间</h1>
          <p>{reasons[setup.reason] || reasons["missing-backend"]}</p>
        </div>
        <ol class="setup-steps" aria-label="配置步骤">
          {steps.map((label, index) => (
            <li
              key={label}
              class={
                step === index ? "current" : step > index ? "complete" : ""
              }
              aria-current={step === index ? "step" : undefined}
            >
              <span>{index + 1}</span>
              <span>{label}</span>
            </li>
          ))}
        </ol>
        <h2 ref={heading} tabIndex="-1">
          {steps[step]}
        </h2>
        {step === 0 && (
          <>
            <p class="setup-description">
              选择文件服务的连接方式，已有的 WebDAV 服务可以直接接入。
            </p>
            <div class="setup-choices" role="group" aria-label="连接方式">
              <button
                class={`setup-choice${form.transport === "http" ? " selected" : ""}`}
                aria-pressed={form.transport === "http"}
                onClick={() => update("transport", "http")}
              >
                <Icon name="folder" />
                <strong>HTTPS / WebDAV</strong>
                <span>连接现有的 WebDAV 地址，文件直接从源站获取。</span>
                <small>适合已有 HTTPS 文件服务</small>
              </button>
              <button
                class={`setup-choice${form.transport === "webtransport" ? " selected" : ""}`}
                aria-pressed={form.transport === "webtransport"}
                onClick={() => update("transport", "webtransport")}
              >
                <Icon name="plug" />
                <strong>WebTransport</strong>
                <span>通过 webtransport-bridge 连接你的文件服务。</span>
                <small>需要部署网关并开放 UDP 端口</small>
              </button>
            </div>
            <div class="setup-actions">
              <button class="text-button" onClick={onDemo}>
                先体验演示
              </button>
              <button class="primary-button" onClick={() => setStep(1)}>
                下一步
                <Icon name="chevron-right" />
              </button>
            </div>
          </>
        )}
        {step === 1 && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              try {
                setVars(setupVariables(form));
                setStep(2);
              } catch (error) {
                notify(error.message, true);
              }
            }}
          >
            <label class="form-label" for="setup-name">
              资源名称
            </label>
            <input
              id="setup-name"
              value={form.name}
              maxLength="100"
              onInput={(event) => update("name", event.currentTarget.value)}
              placeholder="我的文件"
            />
            <label class="form-label" for="setup-endpoint">
              {form.transport === "http"
                ? "WebDAV 服务地址"
                : "WebTransport 网关地址"}
            </label>
            <input
              id="setup-endpoint"
              type="url"
              required
              value={form.endpoint}
              autoComplete="url"
              placeholder={
                form.transport === "http"
                  ? "https://files.example.com"
                  : "https://bridge.example.com:4433/webtransport"
              }
              onInput={(event) => update("endpoint", event.currentTarget.value)}
              aria-describedby="setup-endpoint-help"
            />
            <p id="setup-endpoint-help" class="field-note">
              {form.transport === "http"
                ? "只填写域名和端口，挂载路径填写到下方根目录。"
                : "填写完整会话地址，通常以 /webtransport 结尾。"}
            </p>
            <div class="setup-fields">
              <div>
                <label class="form-label" for="setup-root">
                  WebDAV 根目录
                </label>
                <input
                  id="setup-root"
                  value={form.rootPath}
                  placeholder="/dav/public/"
                  onInput={(event) =>
                    update("rootPath", event.currentTarget.value)
                  }
                />
              </div>
              <div>
                <label class="form-label" for="setup-auth">
                  后端认证
                </label>
                <select
                  id="setup-auth"
                  value={form.auth}
                  onChange={(event) =>
                    update("auth", event.currentTarget.value)
                  }
                >
                  <option value="none">无需认证</option>
                  <option value="basic">用户名与密码（Basic）</option>
                  <option value="bearer">访问令牌（Bearer）</option>
                </select>
              </div>
            </div>
            {form.transport === "webtransport" && (
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
                  <option value="pinned">短期证书 + 证书哈希</option>
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
            <p class="field-note">
              账号、密码和令牌在连接时填写，此处只生成公开连接配置。
            </p>
            <div class="setup-actions">
              <button
                type="button"
                class="secondary-button"
                onClick={() => setStep(0)}
              >
                上一步
              </button>
              <button type="submit" class="primary-button">
                生成配置
                <Icon name="chevron-right" />
              </button>
            </div>
          </form>
        )}
        {step === 2 && (
          <>
            <p class="setup-description">
              将配置应用到运行 LanternDock 的环境，然后重新检测连接。
            </p>
            <div class="setup-targets" role="group" aria-label="运行环境">
              <button
                aria-pressed={target === "local"}
                class={target === "local" ? "active" : ""}
                onClick={() => setTarget("local")}
              >
                本地开发
              </button>
              <button
                aria-pressed={target === "worker"}
                class={target === "worker" ? "active" : ""}
                onClick={() => setTarget("worker")}
              >
                Cloudflare Workers
              </button>
            </div>
            <p class="setup-instructions">
              {target === "local" ? (
                <>
                  将下面内容保存到项目根目录的 <code>.dev.vars</code>，然后重启{" "}
                  <code>npm run dev</code>。
                </>
              ) : (
                <>
                  将 <code>vars</code> 合入 <code>wrangler.jsonc</code> 后运行{" "}
                  <code>npm run deploy</code>；也可以在 Cloudflare
                  的变量设置中添加同名变量，再重新部署。
                </>
              )}
            </p>
            <div class="setup-code-heading">
              <span>
                {target === "local" ? ".dev.vars" : "wrangler.jsonc · vars"}
              </span>
              <div>
                <button class="text-button" onClick={download}>
                  下载配置
                </button>
                <button class="text-button" onClick={copy}>
                  复制配置
                </button>
              </div>
            </div>
            <textarea
              ref={code}
              class="setup-code"
              aria-label="生成的配置"
              readOnly
              value={snippet}
              spellCheck={false}
              rows={target === "local" ? 8 : 12}
            />
            <div class="setup-checklist">
              <strong>连接前再确认</strong>
              <ul>
                {vars.BACKEND_TRANSPORT === "http" ? (
                  <>
                    <li>后端已启用 WebDAV，支持 PROPFIND、GET 和 HEAD。</li>
                    <li>
                      后端 CORS 已允许此网页来源：<code>{location.origin}</code>
                      。
                    </li>
                  </>
                ) : (
                  <>
                    <li>
                      网关允许此网页来源：<code>{location.origin}</code>
                      ，并已开放对应 UDP 端口。
                    </li>
                    <li>
                      网关已允许 GET、HEAD 和 PROPFIND，以及配置的根目录。
                    </li>
                    {vars.CERTIFICATE_MODE === "pinned" && (
                      <li>
                        {target === "local" ? (
                          <>
                            在 <code>.dev.vars</code> 中补充{" "}
                            <code>CERTIFICATES_JSON</code>
                            ，填入网关实际发布的证书哈希文档。
                          </>
                        ) : (
                          <>
                            绑定 <code>PINS</code> KV、设置私密证书
                            webhook，并让网关发布有效证书哈希。
                          </>
                        )}
                      </li>
                    )}
                  </>
                )}
              </ul>
              <a
                href="https://github.com/longern/lantern-dock/blob/main/docs/configuration.md"
                target="_blank"
                rel="noreferrer"
              >
                查看完整配置说明
                <Icon name="arrow-up-right" />
              </a>
            </div>
            <p class="field-note">
              此向导不会修改服务器设置。请由站点维护者应用以上配置；浏览器不会保存这些表单内容。
            </p>
            {setup.checked && !checking && (
              <p class="setup-hint" role="status">
                {setup.reason === "missing-certificates"
                  ? "尚未检测到有效网关证书。请完成上面的证书配置后再试。"
                  : "尚未检测到有效后端配置。请确认配置已应用，并重启服务或重新部署后再试。"}
              </p>
            )}
            <div class="setup-actions">
              <button class="secondary-button" onClick={() => setStep(1)}>
                上一步
              </button>
              <button
                class="primary-button"
                disabled={checking}
                onClick={onRetry}
              >
                <Icon name="refresh" />
                {checking ? "正在检测…" : "已完成，重新检测"}
              </button>
            </div>
          </>
        )}
        {step === 0 && setup.reason === "missing-certificates" && (
          <p class="setup-hint">
            已有配置已带入向导。确认连接信息后，我们会显示证书接入步骤。
          </p>
        )}
      </section>
      <footer class="setup-footer">
        <span>文件由你的后端存储和提供。</span>
        {step > 0 && (
          <button class="text-button" onClick={onDemo}>
            先体验演示
          </button>
        )}
      </footer>
    </main>
  );
}
