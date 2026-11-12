import { Icon } from "./Icon.jsx";
import { siteTitle } from "../lib/site-title.js";

export function Brand({
  as: Element = "div",
  className = "",
  icon = true,
  ...props
}) {
  return (
    <Element {...props} class={`site-brand ${className}`}>
      {icon && (
        <span class="brand-symbol">
          <Icon name="portal" />
        </span>
      )}
      <span class="brand-name">{siteTitle}</span>
    </Element>
  );
}
