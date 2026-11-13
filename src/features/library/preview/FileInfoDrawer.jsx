import { t } from "../../../../shared/i18n.js";
import { Dialog } from "../../../components/Dialog.jsx";
import { Icon } from "../../../components/Icon.jsx";
import { PageHeader } from "../../../components/PageHeader.jsx";
import { SheetHandle } from "../../../components/SheetHandle.jsx";
import { dialogHeadingFocus } from "../../../lib/overlay-focus.js";

export function FileInfoDrawer({ id, onClose, children, ...props }) {
  return (
    <Dialog
      {...props}
      id={id}
      class="settings-dialog file-info-drawer"
      onClose={onClose}
      aria-labelledby={`${id}-title`}
      returnTarget={(scope) => scope.querySelector(`[aria-controls="${id}"]`)}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <SheetHandle onDismiss={onClose} />
      <PageHeader
        className="file-info-header"
        title={t("library.mediaDetails")}
        titleId={`${id}-title`}
        titleTag="h2"
        actions={
          <button
            type="button"
            class="icon-button edge-end"
            aria-label={t("library.closeDetails")}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        }
        {...dialogHeadingFocus}
      />
      <div class="file-info-body">{children}</div>
    </Dialog>
  );
}
