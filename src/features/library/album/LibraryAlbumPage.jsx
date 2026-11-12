import { useLayoutEffect, useRef } from "preact/hooks";
import { t } from "../../../../shared/i18n.js";
import { AlbumOptionsMenu } from "./AlbumOptionsMenu.jsx";
import { FileBrowser } from "../listing/FileBrowser.jsx";
import { PageDialog } from "../../../components/PageDialog.jsx";

export function LibraryAlbumPage({
  library,
  source,
  open,
  animateEntry,
  onClose,
  onExited,
  headerActions,
  listProps,
  records,
  feedback,
}) {
  const current = {
    ...library,
    ...source.album,
    error: source.album.error || (!source.connection ? source.error : null),
    mode: "all",
    kind: "album",
    query: "",
  };
  const openLibrary = useRef(null);
  useLayoutEffect(() => {
    if (open) openLibrary.current = current;
  }, [open, current]);
  // The route stops the album query before the mobile page finishes sliding out.
  const listing = open ? current : (openLibrary.current ?? current);

  return (
    <PageDialog
      id="album-page-dialog"
      className="album-page-dialog"
      title={t("core.category.album")}
      backId="album-back"
      backLabel={t("library.backToHome")}
      open={open}
      animateEntry={animateEntry}
      onClose={onClose}
      onExited={onExited}
      fallbackFocus=".category-album"
      actions={headerActions(
        "file-list",
        <AlbumOptionsMenu library={listing} />,
      )}
    >
      <FileBrowser
        {...listProps}
        library={listing}
        records={records}
        pageDialog
      />
      {feedback}
    </PageDialog>
  );
}
