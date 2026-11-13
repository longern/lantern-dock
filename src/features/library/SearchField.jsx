import { t } from "../../../shared/i18n.js";
import { Icon } from "../../components/Icon.jsx";

export function SearchField({ input, value, onChange, onFocus, ...props }) {
  const label = t("library.searchFiles");
  return (
    <div class="search-box">
      <Icon name="search" />
      <input
        {...props}
        ref={input}
        type="search"
        value={value}
        onFocus={onFocus}
        onInput={(event) => onChange(event.currentTarget.value)}
        placeholder={label}
        aria-label={label}
      />
      {value && (
        <button
          type="button"
          class="search-clear icon-button"
          aria-label={t("library.clearSearch")}
          onClick={() => {
            onChange("");
            input.current?.focus({ preventScroll: true });
          }}
        >
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}
