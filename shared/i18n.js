import { createInstance } from "i18next";
import enApp from "../locales/en/app.js";
import zhApp from "../locales/zh-CN/app.js";
import enLibrary from "../locales/en/library.js";
import zhLibrary from "../locales/zh-CN/library.js";
import enAccount from "../locales/en/account.js";
import zhAccount from "../locales/zh-CN/account.js";
import enCore from "../locales/en/core.js";
import zhCore from "../locales/zh-CN/core.js";
import enServer from "../locales/en/server.js";
import zhServer from "../locales/zh-CN/server.js";
import enDemo from "../locales/en/demo.js";
import zhDemo from "../locales/zh-CN/demo.js";

export const DEFAULT_LANGUAGE = "en";
export const SUPPORTED_LANGUAGES = Object.freeze(["en", "zh-CN"]);
export const resources = {
  en: { app: enApp, library: enLibrary, account: enAccount, core: enCore, server: enServer, demo: enDemo },
  "zh-CN": { app: zhApp, library: zhLibrary, account: zhAccount, core: zhCore, server: zhServer, demo: zhDemo },
};

export function detectLanguage(languages = []) {
  for (const value of Array.isArray(languages) ? languages : [languages]) {
    if (typeof value !== "string") continue;
    const language = value.trim().replaceAll("_", "-").toLowerCase();
    if (/^zh(?:-[a-z0-9]{1,8})*$/.test(language)) return "zh-CN";
    if (/^en(?:-[a-z0-9]{1,8})*$/.test(language)) return "en";
  }
  return DEFAULT_LANGUAGE;
}

export function detectBrowserLanguage(browser = globalThis.navigator) {
  return detectLanguage(browser?.languages?.length ? browser.languages : [browser?.language]);
}

export function detectRequestLanguage(header) {
  const candidates = String(header || "").slice(0, 4096).split(",").map((entry, index) => {
    const [language, ...parameters] = entry.trim().split(";");
    const qualities = parameters.filter((parameter) => /^\s*q(?:\s*=|\s*$)/i.test(parameter));
    const raw = qualities[0]?.slice(qualities[0].indexOf("=") + 1).trim();
    const weight = !qualities.length ? 1 : qualities.length === 1 && /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw || "") ? Number(raw) : 0;
    return { language, weight, index };
  }).filter(({ weight }) => weight > 0).sort((a, b) => b.weight - a.weight || a.index - b.index);
  return detectLanguage(candidates.map(({ language }) => language));
}

const translators = new Map();
export function createTranslator(language = DEFAULT_LANGUAGE) {
  const selected = detectLanguage(language);
  if (translators.has(selected)) return translators.get(selected);
  const instance = createInstance();
  instance.init({
    resources,
    lng: selected,
    supportedLngs: SUPPORTED_LANGUAGES,
    fallbackLng: DEFAULT_LANGUAGE,
    load: "currentOnly",
    ns: Object.keys(resources.en),
    defaultNS: "app",
    keySeparator: false,
    initAsync: false,
    showSupportNotice: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  const translate = (key, options) => {
    const separator = key.indexOf(".");
    const qualified = separator < 0 ? key : `${key.slice(0, separator)}:${key.slice(separator + 1)}`;
    return instance.t(qualified, options);
  };
  Object.defineProperty(translate, "locale", { value: selected, enumerable: true });
  translators.set(selected, translate);
  return translate;
}

// Browser language is fixed for this page load. Server code uses its own explicit
// request translator and never changes this singleton across concurrent requests.
export const locale = detectBrowserLanguage();
export const t = createTranslator(locale);
