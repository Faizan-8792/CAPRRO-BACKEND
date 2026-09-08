// Mutations for the Web View desktop-only exemption.
//
//   node tools/mutation-harness.mjs tools/mutations/webview-desktop-only.mjs
//
// An exemption in a parity contract is the easiest thing in a codebase to turn into a rubber stamp:
// it looks like a decision, it sits next to a reason, and nothing checks the reason is still true.
// These mutations are what stop that here.
//
// THE RUN THAT JUSTIFIED EXTRACTING THE GUARD. On the first attempt the exemption's three checks
// were written inline in a test, and mutations 3, 4 and 6 -- deleting each check outright -- ALL
// SURVIVED. With three healthy exemptions there was nothing for any of them to find, so removing
// them changed no result. They were guards that had never been demonstrated working. The checks now
// live in auditDesktopOnly(), which the suite calls with deliberately broken exemptions, and all
// three mutations are caught.
//
// Every string below uses String.raw so a ${...} inside an anchor stays literal text rather than
// being interpolated when this file is imported.

const nodeExe = process.execPath;

export const command = [nodeExe, "--test", "tests/webview-feature-parity.test.mjs"];
export const cwd = "../audit-nlp-extension";

const PARITY = "../audit-nlp-extension/tests/webview-feature-parity.test.mjs";
const WORKSPACE = "../audit-nlp-extension/workspace.js";

export const mutations = [
  {
    name: "1. the coverage test stops applying the exemption, so an exempt page reads as a hole",
    target: PARITY,
    find: String.raw`  const unreachable = targets
    .filter((t) => !DESKTOP_ONLY.has(t))
    .filter((t) => !reachable.has(t));`,
    replace: String.raw`  const unreachable = targets.filter((t) => !reachable.has(t));`,
  },
  {
    name: "2. the pane comparison stops applying it, so the pane reads as drifted",
    target: PARITY,
    find: String.raw`  const paneWithoutDesktopOnly = desktopPane().filter(
    (entry) => !(entry.tag && DESKTOP_ONLY.has(entry.tag)),
  );`,
    replace: String.raw`  const paneWithoutDesktopOnly = desktopPane();`,
  },
  {
    name: "3. a stale exemption for a page the desktop no longer has is tolerated",
    target: PARITY,
    find: String.raw`    if (!catalogueTags.has(tag)) {
      problems.push(`,
    replace: String.raw`    if (false) {
      problems.push(`,
  },
  {
    name: "4. Web View implementing an exempted view no longer invalidates the exemption",
    target: PARITY,
    find: String.raw`    if (claimed.test(workspaceSource) || claimed.test(webviewSource)) {`,
    replace: String.raw`    if (false) {`,
  },
  {
    name: "5. an exemption may carry no reason worth reading",
    target: PARITY,
    find: String.raw`    if (!reason || reason.length <= 40) {`,
    replace: String.raw`    if (false) {`,
  },
  {
    name: "6. the audit stops looking at webview.js, only at workspace.js",
    target: PARITY,
    find: String.raw`    if (claimed.test(workspaceSource) || claimed.test(webviewSource)) {`,
    replace: String.raw`    if (claimed.test(workspaceSource)) {`,
  },

  // 7 is the one that matters most, and it mutates the EXTENSION rather than the test: it makes the
  // exemption's stated reason false. "taskmatrix is desktop-only" stops being true the moment
  // workspace.js grows a matrix view, and at that point the page is built AND unreachable from the
  // menu -- exactly the defect this whole parity file was written for. The exemption must fail
  // rather than go on excusing it.
  {
    name: "7. Web View grows a view for an exempted page, making its reason false",
    target: WORKSPACE,
    find: String.raw`  if (view === "calendar") renderCalendar();`,
    replace: String.raw`  if (view === "taskmatrix") return;
  if (view === "calendar") renderCalendar();`,
  },
];
