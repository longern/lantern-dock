import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function clientFor(language) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: [${JSON.stringify(language)}] } });
    globalThis.location = { protocol: 'https:', origin: 'https://site.example' };
    const { locale, t } = await import('./shared/i18n.js');
    const { groupMediaByDate } = await import('./src/lib/album.js');
    const { bytes, date } = await import('./src/lib/format.js');
    const { categoryLabel } = await import('./src/lib/categories.js');
    const { normalizePath, checkResponse } = await import('./src/lib/dav.js');
    const { setupVariables } = await import('./src/lib/setup.js');
    const { mp4ParseError } = await import('./src/lib/video-mp4.js');
    const { unsupportedVideo } = await import('./src/lib/video.js');
    const { DirectTransport } = await import('./src/lib/transport.js');
    const { UploadClient } = await import('./src/lib/uploads.js');
    const { identitySession } = await import('./src/lib/identity.js');
    const photo = (name, modified) => ({ name, path: '/' + name, modified, kind: 'image' });
    const groups = groupMediaByDate([
      photo('past', '2025-12-31'), photo('today', '2026-01-01'),
      photo('future', '2027-01-01'), photo('unknown', ''),
    ], new Date(2026, 0, 1, 12));
    const dayGroups = groupMediaByDate([
      photo('older', '2026-11-03'), photo('yesterday', '2026-11-06'), photo('today', '2026-11-07'),
    ], new Date(2026, 10, 7, 12));
    const errors = [];
    for (const action of [() => normalizePath('/../private'), () => checkResponse(new Response(null, { status: 401 }))]) {
      try { action(); } catch (error) { errors.push({ code: error.code, message: error.message }); }
    }
    const defaultForm = { name: t('core.defaultLibraryName'), transport: 'http', endpoint: 'https://files.example', rootPath: '', auth: 'none' };
    const generated = setupVariables(defaultForm);
    const reset = setupVariables(defaultForm, ['BACKEND_NAME']);
    const emptyGenerated = setupVariables({ ...defaultForm, name: '   ' });
    const emptyReset = setupVariables({ ...defaultForm, name: '' }, ['BACKEND_NAME']);
    const custom = setupVariables({ ...defaultForm, name: 'Personal library' });
    const explicitDefault = setupVariables({ ...defaultForm, nameConfigured: true });
    const explicitDefaultReset = setupVariables({ ...defaultForm, nameConfigured: true }, ['BACKEND_NAME']);
    const explicitOther = setupVariables({ ...defaultForm, name: 'Personal library', nameConfigured: true });
    const clearedName = setupVariables({ ...defaultForm, name: '', nameConfigured: false }, ['BACKEND_NAME']);
    const staleFlag = setupVariables({ ...defaultForm, name: '   ', nameConfigured: true }, ['BACKEND_NAME']);
    const privateText = 'https://private.example/movie?token=secret /private/home.mp4 personal note';
    const diagnostic = mp4ParseError('BoxParser', "Box of type 'moov' at position 123 has an invalid size " + privateText, 12);
    const sanitized = mp4ParseError(privateText, "Invalid box type: 'secr' " + privateText);
    const headers = [];
    globalThis.fetch = async (_url, options) => {
      headers.push(new Headers(options.headers).get('Accept-Language'));
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    };
    await new DirectTransport({ transport: 'http', endpoint: 'https://files.example' }).request('/dav/');
    await identitySession();
    let bridgeHeaders = '';
    const bridge = new DirectTransport({ transport: 'webtransport' });
    bridge.connect = async () => ({ createBidirectionalStream: async () => ({
      readable: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\n\\r\\n'));
        controller.close();
      } }),
      writable: new WritableStream({ write(chunk) { bridgeHeaders += new TextDecoder().decode(chunk); } }),
    }) });
    await bridge.request('/dav/');
    let xhrLanguage;
    globalThis.XMLHttpRequest = class {
      open() {}
      upload = {};
      setRequestHeader(name, value) { if (name === 'Accept-Language') xhrLanguage = value; }
      send() { this.status = 200; this.responseText = '{}'; this.onload(); }
    };
    await new UploadClient({ transport: 'http', endpoint: 'https://files.example' }, 'test').sendHTTP('/api/inbox/example', new Blob(['x']));
    const sampleDate = '2026-11-07T08:09:00Z';
    console.log(JSON.stringify({
      locale, labels: groups.map(group => group.label), dayLabels: dayGroups.map(group => group.label),
      category: categoryLabel('album'), size: bytes(1536), date: date(sampleDate, true),
      expectedDate: new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(sampleDate)),
      errors, generated, reset, emptyGenerated, emptyReset, custom,
      defaultName: defaultForm.name, explicitDefault, explicitDefaultReset, explicitOther, clearedName, staleFlag, unsupportedVideo, headers, xhrLanguage, bridgeHeaders,
      diagnostic: { code: diagnostic.code, message: diagnostic.message, detail: diagnostic.diagnostic },
      sanitized: { message: sanitized.message, detail: sanitized.diagnostic },
    }));
  `,
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    ),
  );
}

for (const [language, locale] of [
  ["en-US", "en"],
  ["zh-Hant-TW", "zh-CN"],
]) {
  test(`browser helpers follow ${language} without changing protocol data`, () => {
    const client = clientFor(language);
    assert.equal(client.locale, locale);
    assert.deepEqual(client.generated, {
      WEBDAV_URL: "https://files.example/dav/",
    });
    assert.equal(client.custom.BACKEND_NAME, "Personal library");
    assert.equal(client.reset.BACKEND_NAME, "");
    assert.deepEqual(client.emptyGenerated, client.generated);
    assert.deepEqual(client.emptyReset, client.reset);
    assert.equal(client.explicitDefault.BACKEND_NAME, client.defaultName);
    assert.deepEqual(client.explicitDefaultReset, client.explicitDefault);
    assert.deepEqual(client.explicitOther, client.custom);
    assert.deepEqual(client.clearedName, client.reset);
    assert.deepEqual(client.staleFlag, client.reset);
    assert.deepEqual(
      client.errors.map((error) => error.code),
      ["PATH_DENIED", "BACKEND_LOGIN_REQUIRED"],
    );
    assert.equal(client.size, "1.5 KB");
    assert.equal(client.date, client.expectedDate);
    assert.deepEqual(client.headers, [locale, locale]);
    assert.equal(client.xhrLanguage, locale);
    assert.ok(client.bridgeHeaders.includes(`accept-language: ${locale}\r\n`));
    assert.equal(client.diagnostic.code, "MP4_PARSE_ERROR");
    assert.deepEqual(client.diagnostic.detail, {
      parser: "BoxParser",
      box: "moov",
      offset: 123,
    });
    assert.match(client.diagnostic.message, /BoxParser.*moov.*123/);
    assert.deepEqual(client.sanitized.detail, { parser: "MP4Box" });
    assert.doesNotMatch(
      JSON.stringify([client.diagnostic, client.sanitized]),
      /private\.example|token=secret|\/private\/|personal note|secr/,
    );
    if (locale === "en") {
      assert.deepEqual(client.labels, [
        "January 1, 2027",
        "Today",
        "December 31, 2025",
        "Unknown date",
      ]);
      assert.deepEqual(client.dayLabels, ["Today", "Yesterday", "November 3"]);
      assert.equal(client.category, "Albums");
      assert.doesNotMatch(
        JSON.stringify([client.errors, client.unsupportedVideo]),
        /\p{Script=Han}/u,
      );
      assert.match(client.errors[1].message, /sign-in/);
    } else {
      assert.deepEqual(client.labels, [
        "2027年1月1日",
        "今天",
        "2025年12月31日",
        "日期未知",
      ]);
      assert.deepEqual(client.dayLabels, ["今天", "昨天", "11月3日"]);
      assert.equal(client.category, "相册");
      assert.match(client.errors[1].message, /登录/);
    }
  });
}
