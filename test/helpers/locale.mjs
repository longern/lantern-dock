// Keep historical Chinese regression fixtures explicit instead of depending on
// the test runner's host language. Dedicated i18n tests cover English and fallback.
Object.defineProperty(globalThis, "navigator", {
  value: { language: "zh-CN", languages: ["zh-CN"] },
  configurable: true,
});
