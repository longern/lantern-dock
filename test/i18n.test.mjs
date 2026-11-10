import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import {
  createTranslator,
  detectLanguage,
  detectBrowserLanguage,
  detectRequestLanguage,
  resources,
} from "../shared/i18n.js";

test("browser language follows supported preference order and falls back to English", () => {
  for (const language of ["zh", "zh-CN", "zh-TW", "zh-Hant-HK", "ZH_cn"])
    assert.equal(detectLanguage([language]), "zh-CN");
  for (const language of ["en", "en-US", "EN_gb"])
    assert.equal(detectLanguage([language]), "en");
  assert.equal(
    detectBrowserLanguage({
      languages: ["fr-FR", "zh-TW", "en"],
      language: "en",
    }),
    "zh-CN",
  );
  assert.equal(
    detectBrowserLanguage({ languages: ["en-GB", "zh-CN"], language: "zh-CN" }),
    "en",
  );
  assert.equal(
    detectBrowserLanguage({ languages: [], language: "zh-CN" }),
    "zh-CN",
  );
  for (const languages of [[], ["fr-FR"], ["zh<script>"], [null, false]])
    assert.equal(detectLanguage(languages), "en");
  assert.equal(detectBrowserLanguage({}), "en");
});

test("request negotiation respects quality, stable priority, exclusions and malformed inputs", () => {
  assert.equal(detectRequestLanguage("en;q=0.2, zh-TW;q=0.9"), "zh-CN");
  assert.equal(detectRequestLanguage("fr-FR, zh-CN;q=0.8, en;q=0.7"), "zh-CN");
  assert.equal(detectRequestLanguage("en;q=0.8, zh;q=0.8"), "en");
  assert.equal(detectRequestLanguage("zh;q=0, en;q=0.5"), "en");
  assert.equal(detectRequestLanguage("zh;q=NaN, en"), "en");
  assert.equal(detectRequestLanguage("zh;q=2, en"), "en");
  assert.equal(detectRequestLanguage("zh;q=0.1234, en"), "en");
  assert.equal(detectRequestLanguage("zh;q=0.9;q=1, en;q=0.1"), "en");
  assert.equal(detectRequestLanguage("zh;q, en;q=0.1"), "en");
  assert.equal(detectRequestLanguage("zh;q=1=0, en;q=0.1"), "en");
  assert.equal(detectRequestLanguage("zh ; Q = 0.9, en;q=0.5"), "zh-CN");
  assert.equal(detectRequestLanguage(undefined), "en");
  assert.equal(detectRequestLanguage("fr, de, *"), "en");
});

test("independent translators interpolate literal values and use English plurals", async () => {
  const en = createTranslator("en-US"),
    zh = createTranslator("zh-TW");
  assert.equal(en.locale, "en");
  assert.equal(zh.locale, "zh-CN");
  assert.equal(createTranslator("fr")("app.title"), en("app.title"));
  const name = '<img src=x onerror="alert(1)"> {{count}} $&';
  assert.equal(en("demo.markdown", { name }).split("\n")[0], `# ${name}`);
  assert.equal(zh("demo.markdown", { name }).split("\n")[0], `# ${name}`);
  assert.match(en("library.favoritesAddedCount", { count: 1 }), /1 item\b/);
  assert.match(en("library.favoritesAddedCount", { count: 2 }), /2 items\b/);
  const values = await Promise.all(
    [en, zh, en, zh].map(async (translate, index) => {
      await new Promise((resolve) => setTimeout(resolve, 4 - index));
      return translate("app.title");
    }),
  );
  assert.deepEqual(values, [
    en("app.title"),
    zh("app.title"),
    en("app.title"),
    zh("app.title"),
  ]);
});

test("translation catalogs have matching keys, placeholders and nonempty text", () => {
  const parameters = (value) =>
    [...value.matchAll(/{{\s*([^}]+?)\s*}}/g)].map((match) => match[1]).sort();
  assert.deepEqual(
    Object.keys(resources.en).sort(),
    Object.keys(resources["zh-CN"]).sort(),
  );
  for (const [namespace, english] of Object.entries(resources.en)) {
    const chinese = resources["zh-CN"][namespace];
    assert.deepEqual(
      Object.keys(english).sort(),
      Object.keys(chinese).sort(),
      namespace,
    );
    for (const [key, value] of Object.entries(english)) {
      assert.equal(typeof value, "string", `${namespace}.${key}`);
      assert.ok(value.trim(), `${namespace}.${key}`);
      assert.equal(typeof chinese[key], "string", `${namespace}.${key}`);
      assert.ok(chinese[key].trim(), `${namespace}.${key}`);
      assert.deepEqual(
        parameters(value),
        parameters(chinese[key]),
        `${namespace}.${key}`,
      );
    }
  }
});

test("application source keeps Chinese copy in translation catalogs", async () => {
  const inspect = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await inspect(path);
      else if (/\.(?:jsx?|html)$/.test(entry.name)) {
        const source = await readFile(path, "utf8");
        assert.doesNotMatch(source, /\p{Script=Han}/u, path);
        for (const match of source.matchAll(
          /["'](app|library|account|admin|core|server|demo)\.([A-Za-z0-9_.]+)["']/g,
        )) {
          if (match[2].endsWith(".")) continue;
          const namespace = resources.en[match[1]];
          assert.ok(
            Object.hasOwn(namespace, match[2]) ||
              Object.hasOwn(namespace, match[2] + "_other"),
            `${path}: ${match[1]}.${match[2]}`,
          );
        }
        for (const match of source.matchAll(/coreError\(\s*["']([A-Z_]+)["']/g))
          assert.ok(
            Object.hasOwn(resources.en.core, "error." + match[1]),
            `${path}: ${match[1]}`,
          );
      }
    }
  };
  for (const directory of ["src", "shared", "worker"]) await inspect(directory);
  assert.doesNotMatch(await readFile("index.html", "utf8"), /\p{Script=Han}/u);
});
