import { t } from "../../shared/i18n.js";
import { Dialog } from "./Dialog.jsx";
import { Icon } from "./Icon.jsx";

export function Favorites({ mobile, open, onClose, onExited, actions, children }) {
  const content = <>
    <header class="favorites-heading">
      <button id="favorites-back" class={`icon-button${mobile ? " edge-start" : ""}`} onClick={onClose}
        aria-label={t(mobile ? "library.backToMe" : "library.backToFiles")}>
        <Icon name="chevron-left" />
      </button>
      <h1 id="favorites-title">{t("library.myFavorites")}</h1>
      {actions && <div class="header-actions">{actions}</div>}
    </header>
    {children}
  </>;
  return mobile ? (
    <Dialog id="favorites-dialog" class="favorites-dialog" open={open}
      onClose={onClose} onExited={onExited} fallbackFocus="#my-favorites"
      aria-labelledby="favorites-title">
      {content}
    </Dialog>
  ) : (
    <section class="favorites-page" aria-labelledby="favorites-title">{content}</section>
  );
}
