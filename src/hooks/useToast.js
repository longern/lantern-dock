import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export function useToast() {
  const [message, setMessage] = useState(null);
  const timer = useRef(null);
  const toast = useCallback((text, error = false) => {
    setMessage({ text, error });
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => {
        setMessage((current) => current && { ...current, leaving: true });
        // Keep the node in the popover layer until the fade-out has finished.
        timer.current = setTimeout(() => setMessage(null), 200);
      },
      error ? 6500 : 4500,
    );
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const clearToast = useCallback(() => {
    clearTimeout(timer.current);
    setMessage(null);
  }, []);
  return { message, toast, clearToast };
}
