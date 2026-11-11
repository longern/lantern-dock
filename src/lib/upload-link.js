import { uploadHref } from "../../shared/routes.js";

export function clipboardUploadHref(text, origin) {
  const candidates =
    text.match(/https?:\/\/[^\s<>"'`\u3000-\u303f\uff00-\uff65]+/gu) || [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.replace(/[),.;!?\]}]+$/, ""));
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.pathname !== "/upload"
      )
        continue;
      const token = new URLSearchParams(url.hash.slice(1)).get("token");
      return uploadHref(token);
    } catch {
      // Keep looking when a copied message contains other or malformed links.
    }
  }
  return null;
}
