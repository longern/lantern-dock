import { flushSync } from "preact/compat";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../../../shared/i18n.js";
import { Dialog } from "../../components/Dialog.jsx";
import { Icon } from "../../components/Icon.jsx";
import { SearchField } from "./SearchField.jsx";

const dialogId = "home-search-dialog";
const triggerId = "home-search-trigger";

function setFieldPosition(field, phase, rect, slot) {
  field.style.setProperty(`--search-${phase}-x`, `${rect.left - slot.left}px`);
  field.style.setProperty(`--search-${phase}-y`, `${rect.top - slot.top}px`);
  field.style.setProperty(`--search-${phase}-width`, `${rect.width}px`);
  field.style.setProperty(`--search-${phase}-height`, `${rect.height}px`);
}

export function HomeSearch({ initialQuery, renderResults }) {
  const [phase, setPhase] = useState(null);
  const [query, setQuery] = useState("");
  const input = useRef(null);
  const trigger = useRef(null);
  const fieldSlot = useRef(null);
  const open = phase === "open";
  useLayoutEffect(() => {
    if (!open || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const dialog = input.current.closest("dialog");
    // Keep the last search result reachable above the on-screen keyboard.
    const fitViewport = () => {
      dialog.style.setProperty(
        "--search-viewport-height",
        `${viewport.height}px`,
      );
      dialog.style.setProperty(
        "--search-viewport-top",
        `${viewport.offsetTop}px`,
      );
    };
    fitViewport();
    viewport.addEventListener("resize", fitViewport);
    viewport.addEventListener("scroll", fitViewport);
    return () => {
      viewport.removeEventListener("resize", fitViewport);
      viewport.removeEventListener("scroll", fitViewport);
    };
  }, [open]);
  const close = () => {
    if (!open) return;
    const slot = fieldSlot.current;
    const field = slot.firstElementChild;
    const bounds = slot.getBoundingClientRect();
    setFieldPosition(field, "exit-from", field.getBoundingClientRect(), bounds);
    setFieldPosition(
      field,
      "exit-to",
      trigger.current.getBoundingClientRect(),
      bounds,
    );
    input.current?.blur();
    setPhase("closing");
  };

  return (
    <>
      <button
        id={triggerId}
        ref={trigger}
        type="button"
        class="search-box home-search-trigger"
        aria-label={t("library.searchFiles")}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-search-active={phase ? "" : undefined}
        aria-controls={phase ? dialogId : undefined}
        onClick={(event) => {
          const origin = event.currentTarget.getBoundingClientRect();
          // Keep mounting the dialog and focusing its field inside the tap.
          flushSync(() => {
            setQuery(initialQuery);
            setPhase("open");
          });
          const slot = fieldSlot.current;
          setFieldPosition(
            slot.firstElementChild,
            "entry",
            origin,
            slot.getBoundingClientRect(),
          );
          input.current?.focus({ preventScroll: true });
        }}
      >
        <Icon name="search" />
        <span>{initialQuery || t("library.searchFiles")}</span>
      </button>
      {phase && (
        <Dialog
          id={dialogId}
          class="home-search-dialog"
          aria-label={t("library.searchFiles")}
          open={open}
          onClose={close}
          onExited={() => setPhase(null)}
          fallbackFocus={`#${triggerId}`}
          onKeyDown={(event) => {
            if (event.target.closest("dialog") !== event.currentTarget) return;
            if (event.key === "Escape" && !event.defaultPrevented) {
              event.preventDefault();
              close();
            }
          }}
        >
          <form
            class="home-search-header"
            onSubmit={(event) => {
              event.preventDefault();
              input.current?.blur();
            }}
          >
            <button
              type="button"
              class="icon-button edge-start"
              aria-label={t("library.closeSearch")}
              onClick={close}
            >
              <Icon name="chevron-left" />
            </button>
            <div ref={fieldSlot} class="home-search-field">
              <SearchField
                input={input}
                value={query}
                onChange={setQuery}
                autofocus
                autoComplete="off"
                enterKeyHint="search"
              />
            </div>
          </form>
          <div class="home-search-results">
            {query.trim() && renderResults(query.trim(), setQuery)}
          </div>
        </Dialog>
      )}
    </>
  );
}
