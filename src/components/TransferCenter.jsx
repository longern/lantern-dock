import { mediaQueries } from "../lib/breakpoints.js";
import { useLayoutEffect, useRef } from "preact/hooks";
import { t } from "../../shared/i18n.js";
import { bytes } from "../lib/format.js";
import { Icon } from "./Icon.jsx";
import { PageDialog } from "./PageDialog.jsx";
import {
  overlayFocusSelector,
  overlayFocusTarget,
  restoreOverlayFocus,
} from "../lib/overlay-focus.js";

const pending = (task) =>
  ["queued", "preparing", "running"].includes(task.status);

function TransferSummary({ progress, onOpen, onCancel }) {
  const element = useRef(null);
  useLayoutEffect(() => {
    const node = element.current;
    node.showPopover();
    return () => node.hidePopover();
  }, []);
  return (
    <div ref={element} popover="manual" class="transfer-summary">
      <button
        class="transfer-summary-open"
        onClick={onOpen}
        aria-label={t("library.openTransfers")}
      >
        <Icon name="download" />
        <span>
          <strong>{progress.name}</strong>
          <span>
            {progress.received > 0 && <>{bytes(progress.received)} · </>}
            {t("library.downloadQueuePosition", progress)}
          </span>
          <progress
            aria-label={t("library.downloadProgress")}
            max={progress.total || 1}
            value={progress.total ? progress.received : undefined}
          />
        </span>
      </button>
      <button
        class="icon-button"
        onClick={onCancel}
        aria-label={t("library.cancelDownload")}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

export function TransferCenter({ transfer, mobile, open, onOpen, onClose }) {
  const element = useRef(null);
  const opener = useRef(null);
  const active = transfer.tasks.filter(pending);
  const finished = transfer.tasks.length - active.length;
  const entries = [
    ...active,
    ...transfer.tasks.filter((task) => !pending(task)).reverse(),
  ];
  useLayoutEffect(() => {
    if (mobile) return;
    const node = element.current;
    if (open) {
      if (!node.matches(":popover-open")) {
        opener.current = document.activeElement;
        node.showPopover();
        // An automatic progress update must not interrupt file browsing.
        if (
          opener.current?.id === "transfers-button" ||
          opener.current?.closest(".transfer-summary")
        )
          node
            .querySelector(overlayFocusSelector)
            ?.focus({ preventScroll: true });
      }
      return;
    }
    if (!node.matches(":popover-open")) return;
    const timer = setTimeout(
      () => {
        const restore = node.contains(document.activeElement);
        node.hidePopover();
        if (restore) restoreOverlayFocus(opener.current, "#transfers-button");
      },
      matchMedia(mediaQueries.reducedMotion).matches ? 0 : 200,
    );
    return () => clearTimeout(timer);
  }, [open, mobile]);
  useLayoutEffect(() => {
    const node = element.current;
    return () => node?.hidePopover();
  }, [mobile]);

  const content = (
    <>
      <div class="transfer-tools">
        <span>
          {active.length
            ? t("library.transfersActive", { count: active.length })
            : t("library.transferSession")}
        </span>
        {active.length > 0 && (
          <button class="text-button" onClick={transfer.cancel}>
            {t("library.cancelDownload")}
          </button>
        )}
        {finished > 0 && (
          <button class="text-button" onClick={transfer.clearFinished}>
            {t("library.clearFinishedTransfers")}
          </button>
        )}
      </div>
      {transfer.tasks.length ? (
        <ul class="transfer-list" aria-label={t("library.transfers")}>
          {entries.map((task) => {
            const current =
              transfer.progress?.id === task.id
                ? { ...task, ...transfer.progress }
                : task;
            const transferring = ["preparing", "running"].includes(task.status);
            return (
              <li key={task.id} class={`transfer-item transfer-${task.status}`}>
                <span class="transfer-file-icon">
                  <Icon
                    name={
                      task.status === "failed"
                        ? "alert"
                        : task.status === "saved" || task.status === "submitted"
                          ? "check"
                          : "download"
                    }
                  />
                </span>
                <div class="transfer-details">
                  <strong title={task.item.name}>{task.item.name}</strong>
                  <p>
                    {t(`library.transferStatus.${task.status}`)}
                    {current.received > 0 && (
                      <>
                        {" "}
                        ·{" "}
                        {current.total
                          ? t("library.downloadTransferred", {
                              received: bytes(current.received),
                              total: bytes(current.total),
                            })
                          : bytes(current.received)}
                      </>
                    )}
                  </p>
                  {transferring && (
                    <progress
                      aria-label={t("library.downloadProgress")}
                      max={current.total || 1}
                      value={current.total ? current.received : undefined}
                    />
                  )}
                  {task.error && <p class="transfer-error">{task.error}</p>}
                </div>
                {["failed", "cancelled"].includes(task.status) && (
                  <button
                    class="icon-button"
                    disabled={active.length > 0}
                    aria-label={t("library.retryTransfer", {
                      name: task.item.name,
                    })}
                    onClick={() => transfer.download(task.item)}
                  >
                    <Icon name="refresh" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div class="transfer-empty">
          <Icon name="download" />
          <p>{t("library.noTransfers")}</p>
        </div>
      )}
    </>
  );
  return (
    <>
      {mobile ? (
        <PageDialog
          id="transfer-dialog"
          className="transfer-dialog"
          title={t("library.transfers")}
          backLabel={t("library.collapseTransfers")}
          open={open}
          onClose={onClose}
          fallbackFocus=".transfer-summary-open, #transfers-button"
        >
          {content}
        </PageDialog>
      ) : (
        <section
          ref={element}
          id="transfer-window"
          popover="manual"
          class="transfer-window"
          data-state={open ? "open" : "closed"}
          role="region"
          aria-label={t("library.transfers")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        >
          <header class="transfer-header" {...overlayFocusTarget}>
            <h2>{t("library.transfers")}</h2>
            <button
              class="icon-button"
              aria-label={t("library.collapseTransfers")}
              onClick={onClose}
            >
              <Icon name="chevron-down" />
            </button>
          </header>
          {content}
        </section>
      )}
      {!open && transfer.progress && (
        <TransferSummary
          progress={transfer.progress}
          onOpen={onOpen}
          onCancel={transfer.cancel}
        />
      )}
    </>
  );
}
