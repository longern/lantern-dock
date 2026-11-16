import { t } from "../../shared/i18n.js";

export const isMissingFileStatus = (status) => status === 404 || status === 410;

// Stable codes keep error handling independent of the active display language.
export function coreError(code, options) {
  const error = new Error(t(`core.error.${code}`, options));
  error.code = code;
  return error;
}
