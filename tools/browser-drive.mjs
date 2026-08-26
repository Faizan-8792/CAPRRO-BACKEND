// tools/browser-drive.mjs
//
// A minimal Chrome DevTools Protocol driver, with NO npm dependencies.
//
// WHY THIS EXISTS
// ---------------
// Several release gates assert things that only exist in a rendered page: that a card renders, that
// a checkbox grid matches the API, that cancelling a dialog issues ZERO network requests. Those were
// all recorded as owner-manual on the grounds that "there is no browser and no puppeteer/playwright".
//
// Half of that was true and half was an assumption. There is no puppeteer — but Chrome IS installed,
// and Node 24 ships a native `WebSocket`. CDP is a WebSocket protocol. So a browser is drivable here
// with zero packages, which means those gates were never owner-manual; they were unattempted.
//
// Adding puppeteer instead would have put a large dependency tree into a repo days from release, to
// do something the platform already does.
//
// USAGE
//   import { withBrowser } from "./browser-drive.mjs";
//   await withBrowser(async (page) => {
//     await page.goto("https://example.test/");
//     const n = await page.evaluate("document.querySelectorAll('input').length");
//     const requests = page.requests();          // every request since the last clearRequests()
//   });
//
// Headless by default. Pass { headless: false } to watch it, which is worth doing once when a
// selector will not match and you cannot see why.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findBrowser() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error("No Chrome or Edge found in the usual install locations.");
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`DevTools did not come up on ${port}: ${lastError?.message ?? "no page target"}`);
}

/**
 * Opens a browser, hands a small page API to `body`, and always closes it again.
 */
export async function withBrowser(body, { headless = true, port = 9333 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "capro-cdp-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    // A fresh profile in a temp dir has no extensions and no sync, which is what makes a run
    // repeatable. Without it the driver would attach to whatever the owner happens to have open.
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    ...(headless ? ["--headless=new", "--disable-gpu"] : []),
    "about:blank",
  ];

  const proc = spawn(findBrowser(), args, { stdio: "ignore", detached: false });
  let ws;
  try {
    const target = await waitForDevTools(port);
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
    });

    let id = 0;
    const pending = new Map();
    const requests = [];
    const consoleLines = [];

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      if (msg.method === "Network.requestWillBeSent") {
        requests.push({ url: msg.params.request.url, method: msg.params.request.method });
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        consoleLines.push((msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
      }
    });

    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const messageId = ++id;
        pending.set(messageId, { resolve, reject });
        ws.send(JSON.stringify({ id: messageId, method, params }));
      });

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");

    const page = {
      send,
      requests: () => [...requests],
      clearRequests: () => { requests.length = 0; },
      consoleLines: () => [...consoleLines],

      async goto(url, { waitMs = 2500 } = {}) {
        await send("Page.navigate", { url });
        await sleep(waitMs);
      },

      /** Evaluates an expression in the page and returns its value. */
      async evaluate(expression) {
        const result = await send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails) {
          throw new Error(
            `page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
          );
        }
        return result.result?.value;
      },
    };

    return await body(page);
  } finally {
    try { ws?.close(); } catch { /* already gone */ }
    try { proc.kill(); } catch { /* already gone */ }
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* temp dir; best effort */ }
  }
}
