import { Dialog } from "./Dialog.jsx";
import { Icon } from "./Icon.jsx";

// Full-screen mobile subpages share one native-modal lifecycle and app bar.
// The owner supplies navigation and actions; the shell owns only presentation.
export function PageDialog({
  id, title, titleId = `${id}-title`, backId, backLabel,
  open, onClose, onExited, fallbackFocus, actions, children,
  className = "", headerClassName = "",
}) {
  return (
    <Dialog id={id} class={`page-dialog ${className}`} open={open}
      onClose={onClose} onExited={onExited} fallbackFocus={fallbackFocus}
      aria-labelledby={titleId}>
      <header class={`page-dialog-header ${headerClassName}`}>
        <button id={backId} class="icon-button edge-start" onClick={onClose}
          aria-label={backLabel}>
          <Icon name="chevron-left" />
        </button>
        <h1 id={titleId}>{title}</h1>
        {actions && <div class="header-actions">{actions}</div>}
      </header>
      {children}
    </Dialog>
  );
}
