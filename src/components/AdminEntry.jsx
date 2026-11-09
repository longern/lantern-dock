import { useEffect } from "preact/hooks";
import { t } from "../../shared/i18n.js";
import { useSession } from "../hooks/useSession.jsx";
import { adminAccess } from "../lib/admin.js";
import { Icon } from "./Icon.jsx";

export function AdminEntry({ className = "my-list-button", id = "my-admin" }) {
  const { identity, nas, ensureNAS } = useSession();
  useEffect(() => {
    if (identity.status === "authenticated") void ensureNAS();
  }, [identity.status, ensureNAS]);
  const access = adminAccess(identity, nas);
  // A verified administrator can open the upgrade guidance on an older NAS.
  // Management operations still require explicit capabilities in AdminPage.
  if (access !== "ready" && access !== "unsupported") return null;
  return (
    <a id={id} class={className} href="/admin/links">
      <span class="my-list-icon"><Icon name="shield" /></span>
      <span>{t("admin.title")}</span><Icon name="chevron-right" />
    </a>
  );
}
