// tools/verify-admin-mobile.mjs - the firm admin panel on a phone (ledger task DS5).
//
// Loads the real public/admin/admin.html in headless Chrome at 390 x 844 with
// a touch pointer and checks: no sideways page scroll; the Menu button opens
// the sidebar as a drawer inside the screen, and Escape, the scrim and
// choosing a page close it; the task filters open as a sheet; a wide table's
// first column is held in place. Then at 1280px: no Menu button, the sidebar
// in its column, the filters inline. And super.html, which shares admin.css,
// keeps its own sidebar on a phone.
//
// The page talks to no server here: fetch is answered in the page before any
// script runs, as a signed-in firm admin with nothing in the firm, so the
// auth guard does not send the page away.
//
// USAGE
//   node tools/verify-admin-mobile.mjs        prints the readings, then ADMIN MOBILE OK
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { withBrowser } from "./browser-drive.mjs";

const ADMIN = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "admin");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const stubFor = (role) => `(() => {
  try { localStorage.setItem("caproadminjwt", "verify-admin-mobile"); } catch (_) {}
  const answer = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  window.fetch = (input) => {
    const url = String(input && input.url ? input.url : input);
    if (/\\/auth\\/me/.test(url)) return answer({ ok: true, user: { id: "u1", email: "admin@sample.test", role: "${role}", firmId: "f1", status: "ACTIVE" } });
    return answer({ ok: true, items: [], users: [], tasks: [], clients: [], data: [] });
  };
})();`;

const failures = [];
const expect = (ok, what) => {
  if (!ok) failures.push(what);
};

await withBrowser(async (page) => {
  async function open(file, { width, height, phone, role = "FIRM_ADMIN" }) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: phone ? 3 : 1, mobile: phone });
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: phone, maxTouchPoints: phone ? 5 : 1 });
    const { identifier } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: stubFor(role) });
    const [name, hash = ""] = file.split("#");
    await page.goto(pathToFileURL(join(ADMIN, name)).href + (hash ? `#${hash}` : ""), { waitMs: 2500 });
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
  const read = () =>
    page.evaluate(`(() => {
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), visibility: s.visibility, display: s.display, position: s.position }; };
      return {
        page: location.pathname.split("/").pop() + location.hash,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        width: innerWidth,
        menu: box(document.getElementById("sidebarToggle")),
        expanded: document.getElementById("sidebarToggle")?.getAttribute("aria-expanded"),
        sidebar: box(document.querySelector(".sidebar")),
        scrimHidden: document.getElementById("sidebarScrim")?.hidden,
        filterToggle: box(document.querySelector(".filter-toggle")),
        sheet: box(document.getElementById("taskFilters")),
        stickyFirst: box(document.querySelector("#page-users .table-responsive th:first-child")),
      };
    })()`);
  const press = (expression) => page.evaluate(`(() => { ${expression}; return true; })()`);
  const pause = () => sleep(350);

  // ---- Phone ----
  await open("admin.html", { width: 390, height: 844, phone: true });
  let r = await read();
  console.log("phone, closed:", JSON.stringify(r));
  expect(r.page.startsWith("admin.html"), `the page left for ${r.page}`);
  expect(r.scrollWidth <= 390, `the page scrolls sideways: ${r.scrollWidth}px wide`);
  expect(r.menu && r.menu.width > 0 && r.menu.display !== "none", "no Menu button on a phone");
  expect(r.sidebar.visibility === "hidden" && r.sidebar.right <= 0, "the sidebar shows before Menu is pressed");

  await press(`document.getElementById("sidebarToggle").click()`);
  await pause();
  r = await read();
  console.log("phone, Menu pressed:", JSON.stringify(r));
  expect(r.sidebar.visibility === "visible" && r.sidebar.left >= 0 && r.sidebar.right <= 390, "Menu did not open the drawer on screen");
  expect(r.expanded === "true" && r.scrimHidden === false, "the drawer opened without aria-expanded or its scrim");
  expect(r.scrollWidth <= 390, `the open drawer makes the page scroll sideways: ${r.scrollWidth}px`);

  await press(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await pause();
  r = await read();
  expect(r.sidebar.visibility === "hidden" && r.expanded === "false", "Escape did not close the drawer");

  await press(`document.getElementById("sidebarToggle").click()`);
  await pause();
  await press(`document.getElementById("sidebarScrim").click()`);
  await pause();
  r = await read();
  expect(r.sidebar.visibility === "hidden" && r.scrimHidden === true, "the scrim did not close the drawer");

  await press(`document.getElementById("sidebarToggle").click()`);
  await pause();
  await press(`document.querySelector('.sidebar a[href="#users"]').click()`);
  await pause();
  r = await read();
  console.log("phone, chose Users:", JSON.stringify(r));
  expect(r.page.endsWith("#users") && r.sidebar.visibility === "hidden", "choosing a page did not close the drawer and go there");
  expect(r.stickyFirst && r.stickyFirst.position === "sticky", "a wide table's first column is not held in place");

  await press(`location.hash = "#tasks"`);
  await pause();
  r = await read();
  expect(r.filterToggle && r.filterToggle.display !== "none" && r.filterToggle.width > 0, "no Filters button on the task board");
  expect(r.sheet.display === "none", "the filter sheet is open before Filters is pressed");
  await press(`document.querySelector(".filter-toggle").click()`);
  await pause();
  r = await read();
  console.log("phone, Filters pressed:", JSON.stringify(r));
  expect(r.sheet.display === "block" && r.sheet.position === "fixed" && r.sheet.bottom <= 844 && r.sheet.left >= 0 && r.sheet.right <= 390, "Filters did not open the sheet on screen");
  await press(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await pause();
  r = await read();
  expect(r.sheet.display === "none", "Escape did not close the filter sheet");
  expect(r.scrollWidth <= 390, `the task board scrolls sideways: ${r.scrollWidth}px`);

  // ---- Desktop ----
  await open("admin.html#tasks", { width: 1280, height: 800, phone: false });
  r = await read();
  console.log("desktop:", JSON.stringify(r));
  expect(r.menu.display === "none", "the Menu button shows on a desktop");
  expect(r.sidebar.visibility === "visible" && r.sidebar.position !== "fixed" && r.sidebar.left >= 0, "the sidebar is not in its column on a desktop");
  expect(r.sheet.display !== "none" && r.sheet.position !== "fixed" && r.sheet.width > 0, "the filters are not inline on a desktop");
  expect(r.filterToggle.display === "none", "the Filters button shows on a desktop");

  // ---- super.html keeps its own layout ----
  await open("super.html", { width: 390, height: 844, phone: true, role: "SUPER_ADMIN" });
  const sup = await page.evaluate(`(() => { const s = document.querySelector(".sidebar"); const st = s ? getComputedStyle(s) : null; return { page: location.pathname.split("/").pop(), firmAdmin: document.body.classList.contains("firm-admin"), visibility: st && st.visibility, position: st && st.position }; })()`);
  console.log("super.html on a phone:", JSON.stringify(sup));
  expect(sup.page === "super.html" && !sup.firmAdmin && sup.visibility === "visible" && sup.position !== "fixed", "super.html picked up the firm panel's drawer");
});

if (failures.length) {
  console.error(`\nADMIN MOBILE FAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  // process.exitCode, not process.exit(): the browser driver fetches, and exiting after a fetch
  // aborts Node 24 on Windows (V32).
  process.exitCode = 1;
} else {
  console.log("\nADMIN MOBILE OK");
}
