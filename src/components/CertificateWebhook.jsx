import { useEffect, useRef, useState } from "preact/hooks";
import {
  certificateWebhookUrl,
  webhookOrigin,
} from "../../shared/site-secret.js";

export function CertificateWebhook({
  secretKey,
  notify,
  address,
  onAddressChange,
  showAddress = true,
}) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [revealed, setRevealed] = useState(false);
  const output = useRef(null);
  const key = secretKey;
  let origin = "";
  try {
    origin = webhookOrigin(address);
  } catch {}

  useEffect(() => {
    let active = true;
    setError("");
    setResult(null);
    if (origin && key) {
      certificateWebhookUrl(key, origin)
        .then((url) => {
          if (active) setResult({ key, origin, url });
        })
        .catch(() => {
          if (active)
            setError(
              "无法在此浏览器生成 URL，请使用 HTTPS 页面或在本地运行 npm run webhook。",
            );
        });
    }
    return () => {
      active = false;
    };
  }, [key, origin]);
  // Never copy a result derived from a previous key or deployment address.
  const url =
    result?.key === key && result?.origin === origin ? result.url : "";
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      notify("已复制证书更新 Webhook URL。");
    } catch {
      setRevealed(true);
      requestAnimationFrame(() => {
        output.current?.focus();
        output.current?.select();
      });
      notify("请复制已选中的 Webhook URL。");
    }
  };
  const download = () => {
    if (!url) return;
    const objectUrl = URL.createObjectURL(
      new Blob([`CERT_WEBHOOK_URL=${JSON.stringify(url)}\n`], {
        type: "application/octet-stream",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "bridge.env";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };
  if (!key)
    return (
      <section class="setup-webhook" aria-label="证书更新 Webhook">
        <p>
          将首次生成密钥时一并保存的 Webhook URL 填入 bridge 的{" "}
          <code>CERT_WEBHOOK_URL</code>。
        </p>
        <details class="setup-webhook-existing">
          <summary>使用已有密钥重新计算 URL</summary>
          <p>
            在本地项目的 <code>.env</code> 中保留已部署的同一个{" "}
            <code>SECRET_KEY</code>，运行以下命令：
          </p>
          <code>
            npm run webhook --{" "}
            {location.protocol === "https:"
              ? location.origin
              : "https://lantern-dock.example.workers.dev"}
          </code>
        </details>
      </section>
    );
  return (
    <section class="setup-webhook" aria-label="证书更新 Webhook">
      <h3>Bridge 配置</h3>
      <p>
        将 URL 填入网关的 <code>CERT_WEBHOOK_URL</code>，启用{" "}
        <code>--auto-cert</code>。
      </p>
      {showAddress && (
        <>
          <label class="form-label" for="webhook-origin">
            LanternDock 部署地址
          </label>
          <input
            id="webhook-origin"
            type="url"
            placeholder="https://lantern-dock.example.workers.dev"
            value={address}
            onInput={(event) => onAddressChange(event.currentTarget.value)}
            aria-describedby="webhook-origin-help"
            autoComplete="off"
            spellCheck={false}
          />
          <p id="webhook-origin-help">
            {address && !origin
              ? "请填写 HTTPS 站点地址，不包含路径、参数或账号。"
              : "填写 LanternDock 站点地址。"}
          </p>
        </>
      )}
      <label class="form-label" for="certificate-webhook-url">
        证书更新 Webhook URL
      </label>
      <input
        ref={output}
        id="certificate-webhook-url"
        type={revealed ? "text" : "password"}
        value={url}
        readOnly
        placeholder="填写站点地址后自动生成"
        autoComplete="off"
        spellCheck={false}
      />
      <div class="setup-webhook-actions">
        <button
          class="text-button"
          disabled={!url}
          onClick={() => setRevealed((value) => !value)}
        >
          {revealed ? "隐藏 Webhook URL" : "显示 Webhook URL"}
        </button>
        <button class="secondary-button" disabled={!url} onClick={copy}>
          复制 Webhook URL
        </button>
        <button class="text-button" disabled={!url} onClick={download}>
          下载 bridge.env
        </button>
      </div>
      <p class="field-note">
        与站点配置配套，请一并保存。Worker 需绑定 <code>PINS</code> KV。
      </p>
      {error && <p role="status">{error}</p>}
    </section>
  );
}
