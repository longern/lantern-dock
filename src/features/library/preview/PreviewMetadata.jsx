import { t } from "../../../../shared/i18n.js";
import { bytes, date } from "../../../lib/format.js";

export function PreviewMetadata({ item, dimensions }) {
  return (
    <dl class="file-details">
      <div>
        <dt>{t("library.type")}</dt>
        <dd>{item.mime || item.name.split(".").pop().toUpperCase()}</dd>
      </div>
      <div>
        <dt>{t("library.size")}</dt>
        <dd>{bytes(item.size)}</dd>
      </div>
      {dimensions && (
        <div>
          <dt>{t("library.dimensions")}</dt>
          <dd>{dimensions}</dd>
        </div>
      )}
      <div>
        <dt>{t("library.modifiedAt")}</dt>
        <dd>{date(item.modified, true)}</dd>
      </div>
    </dl>
  );
}
