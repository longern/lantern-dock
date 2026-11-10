import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { t } from "../../shared/i18n.js";
import { useSession } from "../hooks/useSession.jsx";
import {
  AdminClient,
  adminAccess,
  personalUploadClient,
} from "../lib/admin.js";
import { CreateLinkDialog } from "./CreateLinkDialog.jsx";
import { Dialog } from "./Dialog.jsx";
import { Icon } from "./Icon.jsx";
import { Menu } from "./Menu.jsx";
import { UploadPanel } from "./UploadPage.jsx";

function SheetHandle({ onDismiss }) {
  const pointer = useRef(null);
  const reset = (event) => {
    if (pointer.current?.id !== event.pointerId) return;
    event.currentTarget.closest("dialog").style.removeProperty("--sheet-drag");
    pointer.current = null;
  };
  return (
    <div
      class="intake-sheet-handle"
      aria-hidden="true"
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        pointer.current = { id: event.pointerId, start: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (pointer.current?.id !== event.pointerId) return;
        const offset = Math.max(0, event.clientY - pointer.current.start);
        event.currentTarget
          .closest("dialog")
          .style.setProperty("--sheet-drag", offset + "px");
      }}
      onPointerUp={(event) => {
        if (pointer.current?.id !== event.pointerId) return;
        const dismiss = event.clientY - pointer.current.start > 64;
        if (dismiss) {
          pointer.current = null;
          onDismiss();
        } else reset(event);
      }}
      onPointerCancel={reset}
      onLostPointerCapture={reset}
    >
      <span />
    </div>
  );
}

function PersonalUploadDialog({ createClient, files, direct, onExit }) {
  const [open, setOpen] = useState(true);
  const [working, setWorking] = useState(false);
  const close = () => {
    if (!working) setOpen(false);
  };
  return (
    <Dialog
      class="settings-dialog admin-dialog"
      open={open}
      onClose={close}
      onExited={onExit}
      fallbackFocus="#file-intake-trigger"
      aria-labelledby="personal-upload-title"
    >
      <div class="dialog-heading">
        <h2 id="personal-upload-title">{t("admin.uploadFiles")}</h2>
        <button
          class="icon-button"
          aria-label={t("admin.close")}
          disabled={working}
          onClick={close}
        >
          <Icon name="x" />
        </button>
      </div>
      <UploadPanel
        personalClient={createClient}
        initialFiles={files}
        direct={direct}
        onWorking={setWorking}
      />
      <div class="dialog-actions">
        {working || direct ? null : (
          <a class="secondary-button" href="/admin/inbox">
            {t("admin.viewInbox")}
          </a>
        )}
        <button class="primary-button" disabled={working} onClick={close}>
          {t("admin.done")}
        </button>
      </div>
    </Dialog>
  );
}

function UploadPermissionIndicator({ checking }) {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (!checking) {
      setDelayed(false);
      return;
    }
    const timer = setTimeout(() => setDelayed(true), 200);
    return () => clearTimeout(timer);
  }, [checking]);
  return (
    <>
      <span class="intake-check-status" role={checking ? "status" : undefined}>
        {checking && t("admin.checkingUploadPermission")}
      </span>
      <span
        class="intake-spinner"
        data-visible={checking && delayed ? "" : undefined}
        aria-hidden="true"
      />
    </>
  );
}

export function FileIntakeActions({ client, mobile, suspended }) {
  const { identity, nas, ensureNAS, refreshIdentity, refreshNAS } =
    useSession();
  const [mode, setMode] = useState(null);
  const [intakeClient, setIntakeClient] = useState(null);
  const afterEntry = useRef(null);
  const picker = useRef(null);
  const files = useRef(null);
  const access = adminAccess(identity, nas);
  const allowed = access === "ready";
  const direct =
    identity.status === "authenticated" &&
    nas.status === "ready" &&
    nas.account?.capabilities?.directUploads === true &&
    !allowed;
  const account = allowed || direct ? nas.account : null;
  const invite = allowed && account?.capabilities.adminLinks === true;
  const upload =
    direct || (allowed && account?.capabilities.personalUploads === true);
  useEffect(() => {
    let active = true;
    void client.supportsIntake().then((supported) => {
      if (active) setIntakeClient(supported ? client : null);
    });
    return () => {
      active = false;
    };
  }, [client]);
  useEffect(() => {
    if (identity.status === "authenticated") void ensureNAS();
  }, [identity.status, ensureNAS]);
  useEffect(() => {
    if ((mode === "upload" && !upload) || (mode === "invite" && !invite)) {
      files.current = null;
      setMode(null);
    }
  }, [mode, upload, invite]);
  useEffect(() => {
    const clear = () => setMode(null);
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);
  const inviteClient = useMemo(
    () => (mode === "invite" && invite ? new AdminClient(account) : null),
    [account, invite, mode],
  );
  useEffect(() => () => inviteClient?.close(), [inviteClient]);
  const createUploadClient = useCallback(
    () => personalUploadClient(account, direct),
    [account, direct],
  );
  const close = () => {
    files.current = null;
    setMode(null);
  };
  const closeEntry = (next = null) => {
    afterEntry.current = next;
    setMode("entry-closing");
  };
  const canAct = upload || invite;
  if (!canAct && intakeClient !== client) return null;
  const entryOpen = mode === "entry";
  const entryPresent = entryOpen || mode === "entry-closing";
  const filePicker = upload && (
    <input
      ref={picker}
      type="file"
      multiple
      hidden
      onChange={(event) => {
        const input = event.currentTarget;
        const selected = Array.from(input.files);
        input.value = "";
        if (!selected.length) return;
        files.current = selected;
        if (entryOpen) closeEntry("upload");
        else setMode("upload");
      }}
    />
  );
  const select = (action) => {
    if (action === "upload") picker.current?.click();
    else if (entryOpen) closeEntry(action);
    else setMode(action);
  };
  const choices = [
    ...(upload
      ? [{ key: "upload", label: t("admin.uploadFiles"), icon: "upload" }]
      : []),
    ...(invite
      ? [{ key: "invite", label: t("admin.inviteUpload"), icon: "qr-code" }]
      : []),
  ];
  const label = t("admin.newAction");
  const entryLabel = canAct ? label : t("admin.uploadFiles");
  const guideTitle = t("admin.uploadAccessTitle");
  const checking = access === "checking";
  const verificationFailed =
    !checking && identity.status !== "signed-out" && nas.status !== "ready";
  return (
    <>
      {!entryPresent && filePicker}
      {!suspended &&
        (mobile ? (
          <button
            id="file-intake-trigger"
            class="intake-fab"
            type="button"
            aria-label={entryLabel}
            aria-haspopup="dialog"
            aria-expanded={!!mode}
            onClick={() => setMode("entry")}
          >
            <Icon name="plus" />
          </button>
        ) : choices.length > 1 ? (
          <Menu
            triggerId="file-intake-trigger"
            triggerIcon="plus"
            showLabel
            label={label}
            actions={choices.map((action) => ({
              ...action,
              onSelect: () => select(action.key),
            }))}
          />
        ) : (
          <button
            id="file-intake-trigger"
            class="primary-button"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={canAct ? undefined : entryPresent}
            onClick={() => (canAct ? select(choices[0].key) : setMode("entry"))}
          >
            <Icon name={choices[0]?.icon || "upload"} />
            {choices[0]?.label || entryLabel}
          </button>
        ))}
      {entryPresent && (
        <Dialog
          class={mobile ? "settings-dialog intake-sheet" : "settings-dialog"}
          open={entryOpen}
          onClose={() => closeEntry()}
          onExited={() => setMode(afterEntry.current)}
          fallbackFocus="#file-intake-trigger"
          aria-labelledby={checking ? undefined : "intake-entry-title"}
          aria-label={checking ? t("admin.uploadFiles") : undefined}
        >
          {mobile && <SheetHandle onDismiss={() => closeEntry()} />}
          {filePicker}
          <div class="dialog-heading intake-entry-heading">
            {!checking && (
              <h2 id="intake-entry-title">{canAct ? label : guideTitle}</h2>
            )}
            <button
              class="icon-button"
              aria-label={t("admin.close")}
              onClick={() => closeEntry()}
            >
              <Icon name="x" />
            </button>
          </div>
          <div
            class="intake-entry-body"
            data-checking={checking ? "" : undefined}
          >
            <UploadPermissionIndicator checking={checking} />
            {!checking &&
              (canAct ? (
                <ul class="intake-actions">
                  {choices.map(({ key, label, icon }) => (
                    <li key={key}>
                      <button
                        type="button"
                        disabled={!entryOpen}
                        onClick={() => select(key)}
                      >
                        <Icon name={icon} />
                        <span>{label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div class="intake-guide">
                  <p role="status">
                    {t(
                      verificationFailed
                        ? "account.verificationUnavailable"
                        : identity.status === "signed-out"
                          ? "admin.uploadInvitationRequired"
                          : "admin.uploadPermissionRequired",
                    )}
                  </p>
                  <p>
                    {t(
                      identity.status === "authenticated" && !verificationFailed
                        ? "admin.uploadMemberHelp"
                        : "admin.uploadGuestHelp",
                    )}
                  </p>
                  {verificationFailed && (
                    <button
                      type="button"
                      class="secondary-button"
                      onClick={() =>
                        identity.status === "authenticated"
                          ? void refreshNAS()
                          : void refreshIdentity()
                      }
                    >
                      {t("account.checkAgain")}
                    </button>
                  )}
                </div>
              ))}
          </div>
        </Dialog>
      )}
      {inviteClient && (
        <CreateLinkDialog
          client={inviteClient}
          quick
          onExit={close}
          onError={(error) => {
            if (error.code === "LOGIN_REQUIRED") void refreshIdentity();
            else if (error.status === 401 || error.status === 403)
              void refreshNAS();
          }}
        />
      )}
      {mode === "upload" && upload && (
        <PersonalUploadDialog
          createClient={createUploadClient}
          files={files.current}
          direct={direct}
          onExit={close}
        />
      )}
    </>
  );
}
