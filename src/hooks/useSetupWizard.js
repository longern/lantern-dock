import { useLayoutEffect, useState } from "preact/hooks";
import { backendDefaults } from "../../shared/backend-defaults.js";
import { generateSecretKey, webhookOrigin } from "../../shared/site-secret.js";
import { setupVariables } from "../lib/setup.js";

const initialForm = (setup) => ({
  ...backendDefaults,
  endpoint: "",
  rootPath: "",
  ...setup.backend,
});
const initialStage = (setup) =>
  setup.reason === "missing-certificates"
    ? setup.hasSecretKey
      ? "certificates"
      : "export"
    : "connection";

export function useSetupWizard(setup, notify) {
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(
    location.hostname,
  );
  const [stage, setStage] = useState(() => initialStage(setup));
  const [form, setForm] = useState(() => initialForm(setup));
  const [target, setTarget] = useState(isLocal ? "local" : "worker");
  const [vars, setVars] = useState(null);
  const [secretKey, setSecretKey] = useState("");
  const [ownsCurrentKey, setOwnsCurrentKey] = useState(false);
  const [origin, setOrigin] = useState(
    location.protocol === "https:" ? location.origin : "",
  );
  const exportSecretKey =
    isLocal && target === "local" && !ownsCurrentKey ? "" : secretKey;
  let deploymentUrl = "";
  try {
    deploymentUrl = webhookOrigin(origin);
  } catch {}

  useLayoutEffect(() => {
    if (setup.hasSecretKey) {
      setSecretKey("");
      setOwnsCurrentKey(false);
    }
    if (setup.reason !== "missing-certificates") return;
    const configured = initialForm(setup);
    try {
      const settings = setupVariables(configured, setup.resetVariables);
      if (!setup.hasSecretKey && !secretKey) {
        setSecretKey(generateSecretKey());
        setOwnsCurrentKey(!isLocal || target === "local");
      }
      setForm(configured);
      setVars(settings);
      setStage(initialStage(setup));
    } catch (error) {
      setStage("connection");
      notify(error.message, true);
    }
  }, [setup]);

  const update = (field, value) =>
    setForm((current) => ({ ...current, [field]: value }));
  const chooseTransport = (transport) => {
    if (transport !== form.transport)
      setForm((current) => ({
        ...current,
        transport,
        endpoint: "",
        rootPath: "",
      }));
  };
  const generate = () => {
    try {
      const settings = setupVariables(form, setup.resetVariables);
      if (
        !secretKey &&
        (!setup.hasSecretKey || (isLocal && target === "worker"))
      ) {
        setSecretKey(generateSecretKey());
        setOwnsCurrentKey(
          !setup.hasSecretKey && (!isLocal || target === "local"),
        );
      }
      setVars(settings);
      setStage("export");
    } catch (error) {
      notify(error.message, true);
    }
  };
  const selectTarget = (next) => {
    try {
      if (isLocal && next === "worker" && !secretKey)
        setSecretKey(generateSecretKey());
      setTarget(next);
    } catch {
      notify("无法生成部署密钥，请使用支持 Web Crypto 的浏览器。", true);
    }
  };
  const newDeployment = () => {
    try {
      setSecretKey(generateSecretKey());
      setOwnsCurrentKey(false);
      if (isLocal) setTarget("worker");
    } catch {
      notify("无法生成部署密钥，请使用支持 Web Crypto 的浏览器。", true);
    }
  };
  return {
    stage,
    form,
    vars,
    target,
    exportSecretKey,
    origin,
    setOrigin,
    deploymentUrl,
    externalDeployment:
      isLocal && target === "worker" && deploymentUrl !== location.origin,
    isLocal,
    update,
    chooseTransport,
    generate,
    selectTarget,
    newDeployment,
    edit: () => setStage("connection"),
  };
}
