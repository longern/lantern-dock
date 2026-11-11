import { t } from "../../shared/i18n.js";
import { PageDialog } from "./PageDialog.jsx";
import { Icon } from "./Icon.jsx";

export function Favorites({
  mobile,
  open,
  onClose,
  onExited,
  actions,
  children,
}) {
  if (mobile)
    return (
      <PageDialog
        id="favorites-dialog"
        className="favorites-dialog"
        headerClassName="favorites-heading"
        titleId="favorites-title"
        title={t("library.myFavorites")}
        backId="favorites-back"
        backLabel={t("library.backToMe")}
        open={open}
        onClose={onClose}
        onExited={onExited}
        returnTarget={(scope) => scope.querySelector("#my-favorites")}
        fallbackFocus=".mobile-tabs [aria-current='page']"
        actions={actions}
      >
        {children}
      </PageDialog>
    );
  const content = (
    <>
      <header class="favorites-heading">
        <button
          id="favorites-back"
          class="icon-button"
          onClick={onClose}
          aria-label={t("library.backToFiles")}
        >
          <Icon name="chevron-left" />
        </button>
        <h1 id="favorites-title">{t("library.myFavorites")}</h1>
        {actions && <div class="header-actions">{actions}</div>}
      </header>
      {children}
    </>
  );
  return (
    <section class="favorites-page" aria-labelledby="favorites-title">
      {content}
    </section>
  );
}
