import { useLayoutEffect, useRef } from "preact/hooks";

export function Toast({ message }) {
  const element = useRef(null);
  useLayoutEffect(() => {
    const node = element.current;
    // Popovers stay above modal dialogs without making the notification modal.
    node.showPopover?.();
    return () => node.hidePopover?.();
  }, [message]);
  return (
    <div
      ref={element}
      popover="manual"
      class="toast"
      role={message.error ? "alert" : "status"}
    >
      {message.text}
    </div>
  );
}
