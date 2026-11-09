import { createContext } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { createSessionStore } from "../lib/session-store.js";

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const channel = useRef(null);
  const [store] = useState(() => createSessionStore({
    onSessionChange: () => channel.current?.postMessage("changed"),
  }));
  useEffect(() => {
    // Keep the provider above all routes. Account requests never delay children.
    void store.ensureIdentity();
    const changed = () => { store.invalidate(); void store.refreshIdentity(); };
    const returned = (event) => {
      if (event.persisted) changed();
      else void store.ensureIdentity();
    };
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("lantern-dock:session");
      channel.current.onmessage = (event) => { if (event.data === "changed") changed(); };
    }
    const leaving = () => store.invalidate();
    const offline = () => { store.invalidate(); void store.refreshIdentity(); };
    window.addEventListener("lantern-dock:session-changed", changed);
    window.addEventListener("online", changed);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", returned);
    window.addEventListener("pageshow", returned);
    window.addEventListener("pagehide", leaving);
    return () => {
      window.removeEventListener("lantern-dock:session-changed", changed);
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", returned);
      window.removeEventListener("pageshow", returned);
      window.removeEventListener("pagehide", leaving);
      channel.current?.close();
      channel.current = null;
      store.dispose();
    };
  }, [store]);
  return <SessionContext.Provider value={store}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const store = useContext(SessionContext);
  if (!store) throw new Error("useSession requires SessionProvider");
  const [state, setState] = useState(store.getSnapshot);
  useEffect(() => {
    const unsubscribe = store.subscribe(setState);
    setState(store.getSnapshot());
    return unsubscribe;
  }, [store]);
  return { ...state, ...store };
}
