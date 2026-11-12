import { t } from "../../../shared/i18n.js";
import { Topbar } from "./Navigation.jsx";
import { CategoryCards } from "./CategoryCards.jsx";
import { FileBrowser } from "./listing/FileBrowser.jsx";
import { Icon } from "../../components/Icon.jsx";
import { MyPage } from "../../components/MyPage.jsx";

function TransferTrigger({ transfer, transferPanel, mobile, hasActions }) {
  const activeCount = transfer.tasks.filter((task) =>
    ["queued", "preparing", "running"].includes(task.status),
  ).length;
  return (
    <button
      id="transfers-button"
      class={`icon-button transfer-trigger${hasActions ? "" : " edge-end"}`}
      aria-label={t("library.openTransfers")}
      title={t("library.transfers")}
      aria-expanded={transferPanel.open}
      aria-controls={mobile ? "transfer-dialog" : "transfer-window"}
      aria-haspopup={mobile ? "dialog" : undefined}
      onClick={
        transferPanel.open ? transferPanel.onClose : transferPanel.onOpen
      }
    >
      <Icon name="transfers" />
      {activeCount > 0 && <span class="transfer-badge">{activeCount}</span>}
    </button>
  );
}

export function LibraryMain({
  library,
  basePage,
  collectionPage,
  route,
  myPage,
  mobile,
  albumOpen,
  albumPresent,
  routeError,
  closePreview,
  showSettings,
  topbarActions,
  intakeAction,
  transfer,
  transferPanel,
  favorites,
  listProps,
  visibleRecords,
}) {
  return (
    <main
      class={`main-area${collectionPage ? " collection-page" : ""}${basePage && library.mode === "home" ? " home-page" : ""}${myPage ? " my-main" : ""}`}
    >
      {routeError && (
        <div class="route-error" role="alert">
          <p>{routeError}</p>
          <button class="text-button" onClick={closePreview}>
            {t("library.backToFolder")}
          </button>
        </div>
      )}
      {myPage ? (
        <MyPage
          active={route === "me"}
          onFavorites={() => library.selectMode("favorites")}
          onSettings={showSettings}
        />
      ) : (
        <>
          <Topbar
            library={library}
            hideRefresh={["album", "image"].includes(library.kind)}
            transferAction={
              library.mode === "home" && (
                <TransferTrigger
                  transfer={transfer}
                  transferPanel={transferPanel}
                  mobile={mobile}
                  hasActions={!!topbarActions}
                />
              )
            }
            actions={topbarActions}
            intakeAction={!mobile && intakeAction}
          />
          {library.mode === "home" && (
            <CategoryCards library={library} albumOpen={albumOpen} />
          )}
          {library.demoPreview && (
            <div class="demo-preview-note">
              <span>{t("library.demoPreview")}</span>
              <button class="text-button" onClick={library.endDemo}>
                {t("library.backToSetup")}
              </button>
            </div>
          )}
          {favorites || (
            <FileBrowser
              {...listProps}
              library={library}
              records={visibleRecords}
              listId={albumPresent ? "background-file-list" : "file-list"}
            />
          )}
          {mobile && intakeAction}
        </>
      )}
    </main>
  );
}
