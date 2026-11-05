import { useLayoutEffect, useRef } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { useSetupWizard } from "../hooks/useSetupWizard.js";
import { SetupConnection } from "./SetupConnection.jsx";
import { SetupExport } from "./SetupExport.jsx";
import { SetupCertificates } from "./SetupCertificates.jsx";

const reasons = {
  "missing-backend": "填写文件服务地址，即可生成部署配置。",
  "invalid-configuration": "请检查并完善后端连接信息。",
  "conflicting-backends": "检测到两种连接地址，请选择保留其中一种。",
};

export function SetupWizard({ setup, checking, onRetry, onDemo, notify }) {
  const wizard = useSetupWizard(setup, notify);
  const { stage } = wizard;
  const connection = stage === "connection";
  const certificates = stage === "certificates";
  const heading = useRef(null);
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [stage]);
  const steps = ["连接后端", certificates ? "连接证书" : "保存并部署"];
  const description = connection
    ? reasons[setup.reason] || reasons["missing-backend"]
    : certificates
      ? "站点配置已保存，等待网关发布证书。"
      : "保存配置并应用到运行环境，然后重新检测。";
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
          <span class="setup-eyebrow">设置 LanternDock</span>
          <h1 id="setup-title">连接你的文件空间</h1>
          <p>{description}</p>
        </div>
        <ol class="setup-steps" aria-label="配置步骤">
          {steps.map((label, index) => (
            <li
              key={label}
              class={
                connection
                  ? index === 0
                    ? "current"
                    : ""
                  : index === 0
                    ? "complete"
                    : "current"
              }
              aria-current={
                (connection ? index === 0 : index === 1) ? "step" : undefined
              }
            >
              <span>{index + 1}</span>
              <span>{label}</span>
            </li>
          ))}
        </ol>
        <h2 ref={heading} tabIndex="-1">
          {connection
            ? "连接后端"
            : certificates
              ? "配置网关证书"
              : "保存并部署"}
        </h2>
        {connection ? (
          <SetupConnection wizard={wizard} />
        ) : (
          <>
            {certificates ? (
              <SetupCertificates
                wizard={wizard}
                notify={notify}
                hasKV={setup.hasKV}
              />
            ) : (
              <SetupExport wizard={wizard} setup={setup} notify={notify} />
            )}
            {setup.checked && !checking && (
              <p class="setup-hint" role="status">
                {setup.reason === "missing-certificates"
                  ? "尚未检测到有效网关证书，请确认网关已发布。"
                  : "尚未检测到有效后端配置，请应用配置并重启或重新部署。"}
              </p>
            )}
            <div class="setup-actions">
              <button class="secondary-button" onClick={wizard.edit}>
                {certificates ? "修改连接" : "上一步"}
              </button>
              {!certificates && wizard.externalDeployment ? (
                wizard.deploymentUrl ? (
                  <a
                    class="primary-button"
                    href={wizard.deploymentUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开已部署站点
                    <Icon name="arrow-up-right" />
                  </a>
                ) : (
                  <button class="primary-button" disabled>
                    打开已部署站点
                  </button>
                )
              ) : (
                <button
                  class="primary-button"
                  disabled={checking}
                  onClick={onRetry}
                >
                  <Icon name="refresh" />
                  {checking ? "正在检测…" : "重新检测"}
                </button>
              )}
            </div>
          </>
        )}
      </section>
      <footer class="setup-footer">
        <a
          href="https://github.com/longern/lantern-dock/blob/main/docs/configuration.md"
          target="_blank"
          rel="noreferrer"
        >
          配置文档
        </a>
        <button class="text-button" onClick={onDemo}>
          先体验演示
        </button>
      </footer>
    </main>
  );
}
