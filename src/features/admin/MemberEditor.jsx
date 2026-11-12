import { t } from "../../../shared/i18n.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { MemberAvatar } from "./MemberAvatar.jsx";

export function MemberEditor({ client, sub, onError, onSaved }) {
  const [member, setMember] = useState(null);
  const [permission, setPermission] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    client.users({ sub, signal: controller.signal }).then(
      ({ items }) => {
        if (controller.signal.aborted) return;
        if (!items[0]) {
          setError(t("admin.userMissing"));
          return;
        }
        setMember(items[0]);
        setPermission(items[0].permission);
      },
      (error) => {
        if (controller.signal.aborted) return;
        setError(error.message);
        onError(error);
      },
    );
    return () => {
      controller.abort();
      pending.current?.abort();
    };
  }, [client, sub, onError]);
  const save = async (event) => {
    event.preventDefault();
    if (!member || pending.current || member.admin || member.assignedElsewhere)
      return;
    setError("");
    setNotice("");
    const data = new FormData(event.currentTarget);
    const value = {
      enabled: permission.enabled,
      maxFiles: Number(data.get("maxFiles")),
      maxFileBytes: Math.round(Number(data.get("maxFileMiB")) * 1048576),
    };
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      await client.saveUser(sub, value, controller.signal);
      if (!controller.signal.aborted) {
        setPermission(value);
        onSaved();
        setNotice(t("admin.permissionsSaved"));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error.message);
        onError(error);
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const locked = member?.admin || member?.assignedElsewhere;
  return (
    <section
      class="admin-panel admin-permission-pane"
      aria-labelledby="admin-permission-title"
      aria-busy={!member && !error}
    >
      <div class="admin-panel-heading">
        <div>
          <h2 id="admin-permission-title">{t("admin.uploadPermission")}</h2>
        </div>
      </div>
      {!member && !error && <p role="status">{t("admin.loading")}</p>}
      {member && (
        <form onSubmit={save}>
          <div class="admin-member-profile">
            <MemberAvatar member={member} />
            <strong>{member.name || member.sub}</strong>
          </div>
          {locked ? (
            <p class="admin-member-locked">
              {t(
                member.admin
                  ? "admin.adminPermissionFixed"
                  : "admin.assignedElsewhere",
              )}
            </p>
          ) : (
            <>
              <fieldset class="admin-permission-fields" disabled={busy}>
                <label class="admin-permission-row">
                  <span>
                    <strong>{t("admin.allowDirect")}</strong>
                    <small>{t("admin.allowDirectHint")}</small>
                  </span>
                  <input
                    class="admin-switch"
                    type="checkbox"
                    role="switch"
                    checked={permission.enabled}
                    onChange={(event) =>
                      setPermission({
                        ...permission,
                        enabled: event.currentTarget.checked,
                      })
                    }
                  />
                </label>
                <div class="admin-permission-row">
                  <strong>{t("admin.destinationInbox")}</strong>
                  <span>{t("admin.personalInbox")}</span>
                </div>
                <label class="admin-permission-row">
                  <strong>{t("admin.dailyFileLimit")}</strong>
                  <span>
                    <input
                      type="number"
                      name="maxFiles"
                      required
                      min="1"
                      max="10000"
                      step="1"
                      defaultValue={permission.maxFiles}
                    />{" "}
                    {t("admin.fileUnit")}
                  </span>
                </label>
                <label class="admin-permission-row">
                  <strong>{t("admin.fileLimit")}</strong>
                  <span>
                    <input
                      type="number"
                      name="maxFileMiB"
                      required
                      min="0.01"
                      max="1024"
                      step="any"
                      defaultValue={permission.maxFileBytes / 1048576}
                    />{" "}
                    MiB
                  </span>
                </label>
              </fieldset>
              <p class="admin-form-hint admin-quota-reset">
                {t("admin.dailyQuotaHint")}
              </p>
              <div class="admin-save-permission">
                {notice && <p role="status">{notice}</p>}
                <button class="primary-button" type="submit" disabled={busy}>
                  {t(busy ? "admin.savingPermission" : "admin.savePermission")}
                </button>
              </div>
            </>
          )}
        </form>
      )}
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
