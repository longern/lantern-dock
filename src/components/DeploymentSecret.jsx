export function DeploymentSecret({
  secretKey,
  hasSecretKey,
  revealed,
  onReveal,
  onGenerate,
  target,
}) {
  return (
    <section class="setup-secret" aria-label="站点密钥">
      <div class="setup-secret-heading">
        <h3>
          站点密钥 <code>SECRET_KEY</code>
        </h3>
        <span>Secret</span>
      </div>
      {secretKey ? (
        <>
          <p>
            已在当前浏览器为这次部署生成随机密钥。.env
            的复制和下载包含完整密钥；页面默认隐藏其内容。
          </p>
          {target !== "wrangler" && (
            <button class="text-button" onClick={onReveal}>
              {revealed ? "隐藏密钥" : "显示密钥"}
            </button>
          )}
          {target === "wrangler" && (
            <p>
              Wrangler JSON 只包含普通变量。请切换到 Cloudflare Workers 导出完整
              .env，并将 SECRET_KEY 设置为 Worker Secret。
            </p>
          )}
        </>
      ) : (
        <>
          <p>
            {hasSecretKey
              ? "站点已配置密钥，请保留现有值。向导不会读取或替换它。"
              : "站点尚未设置密钥，可以在此生成部署密钥。"}
          </p>
          <button class="secondary-button" onClick={onGenerate}>
            {hasSecretKey ? "为新部署生成密钥" : "生成部署密钥"}
          </button>
        </>
      )}
    </section>
  );
}
