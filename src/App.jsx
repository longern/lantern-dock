import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "preact/hooks";
import { Sidebar, Topbar, MobileTabs } from "./components/Navigation.jsx";
import { FileBrowser } from "./components/FileBrowser.jsx";
import { FilePreview } from "./components/FilePreview.jsx";
import { ConnectionDialog } from "./components/ConnectionDialog.jsx";
import { DownloadPanel } from "./components/DownloadPanel.jsx";
import { Toast } from "./components/Toast.jsx";
import { SetupWizard } from "./components/SetupWizard.jsx";
import { UploadPage } from "./components/UploadPage.jsx";
import { useLibrary } from "./hooks/useLibrary.js";
import { useRecords } from "./hooks/useRecords.js";
import { useDownload } from "./hooks/useDownload.js";

function LibraryApp() {
  const library = useLibrary();
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
  useEffect(() => {
    if (library.error) toast(library.error.message, true);
  }, [library.error, toast]);
  const records = useRecords(library.key, toast);
  const transfer = useDownload(library.connection, records.remember, toast);
  const [selected, setSelected] = useState(null);
  const [settings, setSettings] = useState(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (library.setup) {
      setSettings(false);
      setMenu(false);
      setMessage(null);
    }
  }, [library.setup]);

  useEffect(() => {
    setSelected(null);
  }, [library.connection]);
  const closePreview = () => {
    const path = selected?.path;
    setSelected(null);
    requestAnimationFrame(() =>
      [...document.querySelectorAll(".file-open")]
        .find((node) => node.dataset.path === path)
        ?.focus(),
    );
  };
  useLayoutEffect(() => {
    const keyboard = (event) => {
      if (event.key === "Escape" && !settings) {
        if (menu) setMenu(false);
        else if (selected) {
          event.preventDefault();
          closePreview();
        }
      }
      if (
        event.key === "/" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(
          document.activeElement?.tagName,
        ) &&
        !settings &&
        !selected
      ) {
        event.preventDefault();
        document.getElementById("search")?.focus();
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [selected, settings, menu]);
  useEffect(() => {
    const stop = () => {
      transfer.cancel();
      library.connection?.transport?.close();
    };
    window.addEventListener("pagehide", stop);
    return () => window.removeEventListener("pagehide", stop);
  }, [library.connection]);

  const showSettings = () => {
    setMenu(false);
    setSettings(true);
  };
  const preview = (item) => {
    records.remember(item);
    setSelected(item);
  };
  const connect = (credentials) => {
    setSettings(false);
    setSelected(null);
    setMessage(null);
    transfer.cancel();
    library.setCredentials(credentials);
  };
  const feedback = (
    <>
      <DownloadPanel progress={transfer.progress} onCancel={transfer.cancel} />
      {message && <Toast message={message} />}
    </>
  );
  if (library.setup && !library.demoPreview)
    return (
      <>
        <SetupWizard
          setup={library.setup}
          checking={library.loading}
          onRetry={library.reconnect}
          onDemo={() => {
            setMessage(null);
            library.startDemo();
          }}
          notify={toast}
        />
        {feedback}
      </>
    );
  return (
    <div class={`app-shell${selected ? " preview-open" : ""}`}>
      <Sidebar
        library={library}
        records={records}
        open={menu}
        onClose={() => setMenu(false)}
        onSettings={showSettings}
      />
      <main class="main-area">
        <Topbar
          library={library}
          onMenu={() => setMenu((value) => !value)}
          onSettings={showSettings}
        />
        {library.demoPreview && (
          <div class="demo-preview-note">
            <span>正在体验演示文件</span>
            <button class="text-button" onClick={library.endDemo}>
              返回配置向导
            </button>
          </div>
        )}
        <FileBrowser
          library={library}
          records={records}
          selected={selected}
          onPreview={preview}
          onSettings={showSettings}
        />
      </main>
      <MobileTabs library={library} onCloseMenu={() => setMenu(false)} />
      {selected && library.connection && (
        <FilePreview
          key={selected.path}
          item={selected}
          client={library.connection.client}
          favorite={records.isFavorite(selected)}
          onFavorite={records.toggleFavorite}
          onDownload={transfer.download}
          onError={(text) => toast(text, true)}
          onClose={closePreview}
          feedback={settings ? null : feedback}
        />
      )}
      {settings && (
        <ConnectionDialog
          backend={library.backend}
          credentials={library.credentials}
          onConnect={connect}
          onForget={() => {
            setSelected(null);
            transfer.cancel();
            library.setCredentials({ mode: "none" });
            toast("已清除页面内的登录信息。");
          }}
          onClose={() => setSettings(false)}
          feedback={feedback}
        />
      )}
      {!selected && !settings && feedback}
    </div>
  );
}

const uploadToken = () => location.hash.match(/^#\/upload\/(.*)$/)?.[1] ?? null;

export function App() {
  const [token, setToken] = useState(uploadToken);
  useEffect(() => {
    const changed = () => setToken(uploadToken());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  return token === null ? (
    <LibraryApp />
  ) : (
    <UploadPage key={token} token={token} />
  );
}
