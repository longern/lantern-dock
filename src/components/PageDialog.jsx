import { Dialog } from "./Dialog.jsx";
import { Icon } from "./Icon.jsx";
import { PageHeader } from "./PageHeader.jsx";
import { dialogHeadingFocus } from "../lib/overlay-focus.js";

export function PageDialogHeader({
  title,
  titleId,
  backId,
  backLabel,
  onClose,
  actions,
  divider,
  className = "",
}) {
  return (
    <PageHeader
      className={`page-dialog-header ${className}`}
      title={title}
      titleId={titleId}
      divider={divider}
      back={
        <button
          id={backId}
          type="button"
          class="icon-button edge-start"
          onClick={onClose}
          aria-label={backLabel}
        >
          <Icon name="chevron-left" />
        </button>
      }
      actions={actions}
      {...dialogHeadingFocus}
    />
  );
}

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
  divider,
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
      <PageDialogHeader
        className={headerClassName}
        title={title}
        titleId={titleId}
        divider={divider}
        backId={backId}
        backLabel={backLabel}
        onClose={onClose}
        actions={actions}
      />
      {children}
    </Dialog>
  );
}
