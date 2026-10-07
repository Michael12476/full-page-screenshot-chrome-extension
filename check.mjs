import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const captureSource = readFileSync(new URL("capture.js", import.meta.url), "utf8");
const backgroundSource = readFileSync(new URL("background.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("manifest.json", import.meta.url)));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "downloads"]);
for (const icon of Object.values(manifest.icons)) readFileSync(new URL(icon, import.meta.url));

function pageEnvironment({ width = 160, height = 205, fail = false, scale = 1, grow = false, scrolls = true, quirks = false, footer = false, footerInset = 0, viewportHeight = 80 } = {}) {
  const styles = new Map();
  const footerRect = { left: 0, right: 100, top: 60 - footerInset, bottom: 80 - footerInset, width: 100, height: 20 };
  const fixed = { position: "fixed", style: styleApi("fixed"), getBoundingClientRect: () => footer ? footerRect : { top: 0, bottom: 20, height: 20 } };
  const fixedHeader = { position: "fixed", style: styleApi("header"), getBoundingClientRect: () => ({ top: 0, bottom: 20, height: 20 }) };
  const sticky = { position: "sticky", style: styleApi("sticky") };
  let removed = false;
  let captures = 0;
  let output;
  let pageHeight = height;
  function styleApi(id) {
    return {
      getPropertyValue: key => styles.get(`${id}:${key}`)?.value || "",
      getPropertyPriority: key => styles.get(`${id}:${key}`)?.priority || "",
      setProperty: (key, value, priority) => styles.set(`${id}:${key}`, { value, priority }),
      removeProperty: key => styles.delete(`${id}:${key}`)
    };
  }
  fixed.style.setProperty("visibility", "visible", "important");
  const initialStyles = new Map(styles);
  const environment = {
    innerWidth: 100, innerHeight: viewportHeight, scrollX: 7, scrollY: 13, devicePixelRatio: scale,
    Date, Math, Error, setTimeout: callback => callback(),
    getComputedStyle: element => ({ position: element.position, visibility: "visible" }),
    scrollTo(x, y) {
      if (scrolls) {
        environment.scrollX = Math.min(x, Math.max(0, width - 100));
        environment.scrollY = Math.min(y, Math.max(0, pageHeight - 80));
      }
    },
    fetch: async () => ({ blob: async () => ({}) }),
    createImageBitmap: async () => ({ width: 100 * scale, x: environment.scrollX, y: environment.scrollY,
      footerVisible: footer && fixed.style.getPropertyValue("visibility") !== "hidden", close() {} }),
    chrome: { runtime: { sendMessage: async () => {
      captures++;
      if (footer && captures > 1) assert.equal(fixedHeader.style.getPropertyValue("visibility"), "hidden", "Headers must stay hidden while the footer is captured");
      if (grow) pageHeight++;
      if (fail) return { error: "Tab switched" };
      return { dataUrl: "data:image/png;base64,AA==" };
    } } },
    document: {
      title: "Test page",
      documentElement: {
        scrollWidth: width, get scrollHeight() { return pageHeight; },
        clientWidth: 100, clientHeight: 80, append() {}
      },
      body: { scrollWidth: width, get scrollHeight() { return pageHeight; }, clientWidth: 100, clientHeight: 80 },
      querySelectorAll: () => footer ? [fixedHeader, fixed, sticky] : [fixed, sticky],
      createElement(type) {
        if (type === "style") return { remove() { removed = true; } };
        const canvas = {
          width: 0, height: 0,
          getContext() {
            output = new Uint32Array(canvas.width * canvas.height);
            return { drawImage(bitmap, sx, sy, sw, sh, dx, dy) {
              for (let y = 0; y < Math.ceil(sh); y++) {
                for (let x = 0; x < Math.ceil(sw); x++) {
                  if (dy + y >= canvas.height || dx + x >= canvas.width) continue;
                  const index = (dy + y) * canvas.width + dx + x;
                  const footerPixel = bitmap.footerVisible && sy + y >= Math.round(footerRect.top * scale) && sy + y < Math.round(footerRect.bottom * scale);
                  if (!footerPixel) assert.equal(output[index], 0, "Overlapping final frames must not overwrite earlier tiles");
                  output[index] = footerPixel ? 0xffffffff : (Math.round(bitmap.y * scale) + sy + y) * canvas.width + Math.round(bitmap.x * scale) + sx + x + 1;
                }
              }
            } };
          },
          toDataURL() {
            assert.ok(output.every((pixel, index) => {
              const inFooter = footer && index >= canvas.width * Math.round((height - 20 - footerInset) * scale) &&
                index < canvas.width * Math.round((height - footerInset) * scale) && index % canvas.width < 100 * scale;
              return pixel === (inFooter ? 0xffffffff : index + 1);
            }), "Page pixels must remain intact, with fixed footers appearing only at the bottom");
            return "data:image/png;base64,AA==";
          }
        };
        return canvas;
      }
    }
  };
  environment.document.scrollingElement = quirks ? environment.document.body : environment.document.documentElement;
  if (quirks) environment.document.documentElement.clientHeight = height;
  vm.createContext(environment);
  vm.runInContext(captureSource, environment);
  return { environment, captures: () => captures, restored() {
    assert.equal(removed, true);
    assert.equal(environment.scrollX, Math.min(7, Math.max(0, width - 100)));
    assert.equal(environment.scrollY, Math.min(13, Math.max(0, pageHeight - 80)));
    assert.deepEqual(styles, initialStyles);
  } };
}

for (const options of [{}, { scale: 2 }, { scale: 1.5 }, { scale: 1.25 }, { width: 100, height: 80 }, { quirks: true },
  { footer: true }, { footer: true, height: 161 }, { footer: true, scale: 1.5 }, { footer: true, width: 100, height: 80 },
  { footer: true, footerInset: 8 }, { footer: true, viewportHeight: 96 }]) {
  const page = pageEnvironment(options);
  assert.equal((await page.environment.capturePage("session")).title, "Test page");
  assert.equal(page.captures(), options.height === 80 ? 1 : 6);
  page.restored();
}
for (const options of [{ fail: true }, { fail: true, footer: true }, { grow: true }, { height: 40000 }, { scrolls: false }]) {
  const page = pageEnvironment(options);
  await assert.rejects(page.environment.capturePage("session"));
  page.restored();
}

let click;
let message;
let selected = true;
let switchDuringCapture = false;
let screenshotCalls = 0;
const downloads = [];
const badges = [];
const tab = { id: 1, windowId: 2, url: "https://example.com" };
const worker = {
  crypto: { randomUUID: () => "session" },
  console: { error() {} },
  importScripts() {},
  capturePage() {},
  chrome: {
    action: {
      onClicked: { addListener(listener) { click = listener; } },
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async value => badges.push(value.text),
      setTitle: async () => {}
    },
    runtime: { onMessage: { addListener(listener) { message = listener; } } },
    tabs: {
      get: async () => ({ ...tab, active: selected }),
      captureVisibleTab: async () => { screenshotCalls++; if (switchDuringCapture) selected = false; return "frame"; }
    },
    scripting: { executeScript: async () => {
      const response = await new Promise(resolve => message({ type: "page-shot:capture", session: "session", frame: 1 }, { tab, frameId: 0 }, resolve));
      if (response.error) throw new Error(response.error);
      return [{ result: { dataUrl: "data:image/png;base64,AA==", title: "bad/\\title:*?<>|\u200e👨‍👩‍👧\u007f" } }];
    } },
    downloads: { download: async options => { downloads.push(options); return 1; } }
  }
};
vm.createContext(worker);
vm.runInContext(backgroundSource, worker);
await Promise.all([click(tab), click(tab)]);
assert.equal(downloads.length, 1, "Double clicks must not start two captures");
assert.equal(downloads[0].saveAs, false);
assert.equal(downloads[0].conflictAction, "uniquify");
assert.match(downloads[0].filename, /^page-shot-bad-title-+-\d/);
assert.ok(!/[<>:"/\\|?*]/.test(downloads[0].filename));
assert.ok(!/\p{C}/u.test(downloads[0].filename), "Control, format, and broken surrogate characters must not reach the filename");
selected = false;
await click(tab);
assert.equal(screenshotCalls, 1, "A background tab must not capture the newly selected tab");
selected = true;
switchDuringCapture = true;
await click(tab);
assert.equal(downloads.length, 1, "Switching tabs during a frame must cancel the download");
assert.equal(badges.at(-1), "ERR");
const unauthorized = await new Promise(resolve => message({ type: "page-shot:capture", session: "session", frame: 1 }, { tab, frameId: 0 }, resolve));
assert.ok(unauthorized.error);
console.log("Passed: stitching at 1x/1.25x/1.5x/2x, fixed footers at the page bottom, short/quirks pages, restoration on failure, size/loading guards, Unicode download names, double clicks, and tab-switch cancellation.");
