import { useRef } from "preact/hooks";

export function SheetHandle({ onDismiss, className = "" }) {
  const pointer = useRef(null);
  const reset = (event) => {
    if (pointer.current?.id !== event.pointerId) return;
    event.currentTarget.closest("dialog").style.removeProperty("--sheet-drag");
    pointer.current = null;
  };
  return (
    <div
      class={`sheet-handle ${className}`}
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
