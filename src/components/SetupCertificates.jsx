import { CertificateWebhook } from "./CertificateWebhook.jsx";

export function SetupCertificates({ wizard, notify }) {
  return (
    <>
      <div class="setup-connection-summary">
        <span>已保存连接地址</span>
        <strong>{wizard.form.endpoint}</strong>
      </div>
      <ol class="setup-certificate-tasks">
        <li>
          Worker 的 KV 绑定名设为 <code>KV</code>。
        </li>
        <li>
          将保存的 <code>bridge.env</code> 合入网关配置，并启用{" "}
          <code>--auto-cert</code>。
        </li>
        <li>网关发布证书后，点击下方重新检测。</li>
      </ol>
      {wizard.isLocal && (
        <p class="field-note">
          本地调试也可在 .env 中填写 <code>CERTIFICATES_JSON</code> 后重启服务。
        </p>
      )}
      <CertificateWebhook
        secretKey=""
        notify={notify}
        address={wizard.origin}
        onAddressChange={wizard.setOrigin}
      />
    </>
  );
}
