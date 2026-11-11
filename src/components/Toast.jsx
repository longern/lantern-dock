import { useLayoutEffect, useRef } from "preact/hooks";

export function Toast({ message, position }) {
  const element = useRef(null);
  useLayoutEffect(() => {
    const node = element.current;
    // Popovers stay above modal dialogs without making the notification modal.
    node.showPopover?.();
    return () => node.hidePopover?.();
  }, []);
  return (
    <div
      ref={element}
      popover="manual"
      class={`toast${position === "center" ? " toast-center" : ""}${message.leaving ? " leaving" : ""}`}
      role={message.error ? "alert" : "status"}
    >
      {message.text}
    </div>
  );
}
