import { useCallback, useState } from "preact/hooks";

export function useLibrarySelection() {
  const [touchSelections, setTouchSelections] = useState(() => new Set());
  const [desktopSelections, setDesktopSelections] = useState(() => new Map());
  const onDesktopSelection = useCallback((owner, value) => {
    setDesktopSelections((current) => {
      if (!value && !current.has(owner)) return current;
      const next = new Map(current);
      if (value) next.set(owner, value);
      else next.delete(owner);
      return next;
    });
  }, []);
  const onTouchSelection = useCallback((owner, active) => {
    setTouchSelections((current) => {
      if (current.has(owner) === active) return current;
      const next = new Set(current);
      if (active) next.add(owner);
      else next.delete(owner);
      return next;
    });
  }, []);
  return {
    touchSelections,
    desktopSelections,
    onTouchSelection,
    onDesktopSelection,
  };
}
