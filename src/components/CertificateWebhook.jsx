import { useEffect, useRef, useState } from "preact/hooks";
import {
  certificateWebhookUrl,
  validateSecretKey,
  webhookOrigin,
} from "../../shared/site-secret.js";

export function CertificateWebhook({ secretKey, notify }) {
  const [address, setAddress] = useState(
    location.protocol === "https:" ? location.origin : "",
  );
  const [existingKey, setExistingKey] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [revealed, setRevealed] = useState(false);
  const output = useRef(null);
  const key = secretKey || existingKey;
  let origin = "",
    validKey = false;
  try {
    origin = webhookOrigin(address);
  } catch {}
  try {
    validateSecretKey(key);
    validKey = true;
  } catch {}

  useEffect(() => {
    let active = true;
    setError("");
    setResult(null);
    if (origin && validKey) {
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
  }, [key, origin, validKey]);
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
  return (
    <section class="setup-secret setup-webhook" aria-label="证书更新 Webhook">
      <div class="setup-secret-heading">
        <h3>证书更新 Webhook</h3>
        <span>Bridge</span>
      </div>
      <p>
        将生成的 URL 填入 bridge 的 <code>CERT_WEBHOOK_URL</code>。Worker 需绑定{" "}
        <code>PINS</code> KV，并将同一个 <code>SECRET_KEY</code> 部署为
        Secret；bridge 使用 <code>--auto-cert</code> 发布证书。
      </p>
      <label class="form-label" for="webhook-origin">
        LanternDock 部署地址
      </label>
      <input
        id="webhook-origin"
        type="url"
        placeholder="https://lantern-dock.example.workers.dev"
        value={address}
        onInput={(event) => setAddress(event.currentTarget.value)}
        aria-describedby="webhook-origin-help"
        autoComplete="off"
        spellCheck={false}
      />
      <p id="webhook-origin-help">
        {address && !origin
          ? "请填写 HTTPS 站点地址，不包含路径、参数或账号。"
          : "填写运行 LanternDock 的 Worker 地址，网关地址无需填在这里。"}
      </p>
      {!secretKey && (
        <>
          <label class="form-label" for="webhook-existing-key">
            已部署的 SECRET_KEY
          </label>
          <input
            id="webhook-existing-key"
            type="password"
            value={existingKey}
            onInput={(event) => setExistingKey(event.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="webhook-key-help"
          />
          <p id="webhook-key-help">
            {existingKey && !validKey
              ? "SECRET_KEY 至少需要 32 个字符，且不能包含首尾空格或换行。"
              : "粘贴已有密钥，在当前浏览器中计算 URL。此输入不会上传或保存，也不会替换站点密钥。"}
          </p>
        </>
      )}
      {secretKey && (
        <p>
          已使用本次向导生成的密钥自动派生 URL；请部署上方配置中的同一个密钥。
        </p>
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
        placeholder="填写部署地址和密钥后自动生成"
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
      </div>
      {error && <p role="status">{error}</p>}
    </section>
  );
}
