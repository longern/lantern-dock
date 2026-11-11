import { Dialog } from "./Dialog.jsx";
import { Icon } from "./Icon.jsx";
import { dialogHeadingFocus } from "../lib/overlay-focus.js";

// Full-screen mobile subpages share one native-modal lifecycle and app bar.
// The owner supplies navigation and actions; the shell owns only presentation.
export function PageDialog({
  id,
  title,
  titleId = `${id}-title`,
  backId,
  backLabel,
  open,
  animateEntry = true,
  onClose,
  onExited,
  fallbackFocus,
  returnTarget,
  actions,
  children,
  className = "",
  headerClassName = "",
}) {
  return (
    <Dialog
      id={id}
      class={`page-dialog ${className}`}
      open={open}
      animateEntry={animateEntry}
      onClose={onClose}
      onExited={onExited}
      fallbackFocus={fallbackFocus}
      returnTarget={returnTarget}
      aria-labelledby={titleId}
    >
      <header
        class={`page-dialog-header ${headerClassName}`}
        {...dialogHeadingFocus}
      >
        <button
          id={backId}
          class="icon-button edge-start"
          onClick={onClose}
          aria-label={backLabel}
        >
          <Icon name="chevron-left" />
        </button>
        <h1 id={titleId}>{title}</h1>
        {actions && <div class="header-actions">{actions}</div>}
      </header>
      {children}
    </Dialog>
  );
}
