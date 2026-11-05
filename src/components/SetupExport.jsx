import { useRef, useState } from "preact/hooks";
import { setupSnippet } from "../lib/setup.js";
import { CertificateWebhook } from "./CertificateWebhook.jsx";

export function SetupExport({ wizard, setup, notify }) {
  const { target, vars, exportSecretKey: key, form } = wizard;
  const [revealed, setRevealed] = useState(false);
  const code = useRef(null);
  const snippet = vars ? setupSnippet(vars, "local", key) : "";
  const wrangler = vars ? setupSnippet(vars, "wrangler") : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      notify("已复制配置。");
    } catch {
      setRevealed(true);
      requestAnimationFrame(() => {
        code.current?.focus();
        code.current?.select();
      });
      notify("请复制已选中的配置文本。");
    }
  };
  const download = (content, name) => {
    const url = URL.createObjectURL(
      new Blob([content], { type: "application/octet-stream" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <>
      <div class="setup-targets" role="group" aria-label="部署环境">
        <button
          aria-pressed={target === "local"}
          class={target === "local" ? "active" : ""}
          onClick={() => wizard.selectTarget("local")}
        >
          本地开发
        </button>
        <button
          aria-pressed={target === "worker"}
          class={target === "worker" ? "active" : ""}
          onClick={() => wizard.selectTarget("worker")}
        >
          Cloudflare Workers
        </button>
      </div>
      {wizard.isLocal && target === "worker" && (
        <div class="setup-deployment-address">
          <label class="form-label" for="deployment-origin">
            LanternDock 部署地址
          </label>
          <input
            id="deployment-origin"
            type="url"
            value={wizard.origin}
            onInput={(event) => wizard.setOrigin(event.currentTarget.value)}
            placeholder="https://lantern-dock.example.workers.dev"
            spellCheck={false}
          />
          {wizard.origin && !wizard.deploymentUrl && (
            <p class="field-note">请填写不含路径或参数的 HTTPS 站点地址。</p>
          )}
        </div>
      )}
      <section class="setup-export" aria-label="站点配置">
        <h3>LanternDock 配置</h3>
        <p class="setup-instructions">
          {target === "local" ? (
            <>
              合入项目的 <code>.env</code>，然后重启开发服务。
            </>
          ) : (
            <>
              粘贴到控制台「变量和密钥」，将 <code>SECRET_KEY</code> 手动勾选为{" "}
              <strong>Secret</strong>，再部署。
            </>
          )}
        </p>
        <div class="setup-code-heading">
          <span>.env</span>
          <div>
            {key && (
              <button
                class="text-button"
                onClick={() => setRevealed((value) => !value)}
              >
                {revealed ? "隐藏密钥" : "显示密钥"}
              </button>
            )}
            <button
              class="text-button"
              onClick={() => download(snippet, "lantern-dock.env")}
            >
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
          spellCheck={false}
          value={
            key && !revealed ? snippet.replace(key, "•".repeat(32)) : snippet
          }
          rows={Math.min(8, Math.max(3, snippet.trim().split("\n").length))}
        />
        <p class="field-note">
          {key
            ? "已生成随机密钥；复制和下载包含完整值，请保存配置。"
            : "保留站点现有的 SECRET_KEY，导出内容不会替换它。"}
        </p>
      </section>
      {form.transport === "webtransport" &&
        form.certificateMode === "pinned" && (
          <CertificateWebhook
            secretKey={key}
            notify={notify}
            address={wizard.origin}
            onAddressChange={wizard.setOrigin}
            showAddress={!(wizard.isLocal && target === "worker")}
          />
        )}
      <details class="setup-advanced setup-other">
        <summary>其他部署方式</summary>
        <p class="field-note">
          Wrangler 的 vars 只包含普通变量，密钥仍需设置为 Worker Secret。
        </p>
        <textarea
          class="setup-code"
          aria-label="Wrangler 配置"
          readOnly
          value={wrangler}
          rows="5"
          spellCheck={false}
        />
        <button
          class="text-button"
          onClick={() => download(wrangler, "lantern-dock.vars.json")}
        >
          下载 Wrangler JSON
        </button>
        {!key && setup.hasSecretKey && (
          <button class="text-button" onClick={wizard.newDeployment}>
            为新部署生成密钥
          </button>
        )}
      </details>
      <details class="setup-checklist">
        <summary>连接要求与排查</summary>
        <ul>
          {form.transport === "http" ? (
            <li>
              WebDAV 支持 PROPFIND、GET 和 HEAD，CORS 允许{" "}
              <code>{location.origin}</code>。
            </li>
          ) : (
            <>
              <li>
                网关允许 <code>{location.origin}</code>，开放 UDP，并允许
                GET、HEAD 和 PROPFIND。
              </li>
              {form.certificateMode === "pinned" && (
                <li>
                  {target === "local" ? (
                    <>
                      本地在 .env 中配置 <code>CERTIFICATES_JSON</code>。
                    </>
                  ) : (
                    <>
                      Worker 的 KV 绑定名设为 <code>KV</code>，bridge 启用{" "}
                      <code>--auto-cert</code> 发布证书。
                    </>
                  )}
                </li>
              )}
            </>
          )}
        </ul>
      </details>
    </>
  );
}
