// tools/mint-admin-token.mjs
//
// Mints a CA PRO session JWT for the super-admin account and stores it where the tooling expects.
//
//   node tools/mint-admin-token.mjs                     # sends an OTP, then asks for it
//   node tools/mint-admin-token.mjs --otp 123456        # if you already have the code
//   node tools/mint-admin-token.mjs --print             # show the token instead of writing .env
//
// WHY THIS EXISTS
// ---------------
// The admin panel at /admin/super.html has no sign-in form. It reads its bearer token straight out
// of localStorage under the key "caproadminjwt" (public/admin/super.js:4) and never mints one. So
// the token has to come from the normal login API and be placed there by hand -- which is fine, but
// undocumented, and easy to get wrong in a way that looks like the panel is broken.
//
// The panel's routes are guarded by assertSuper (appconfig.controller.js:12, super.controller.js:46),
// which demands BOTH role === "SUPER_ADMIN" AND email === the address hardcoded in those files. A
// token for any other account authenticates fine and then gets 403 on every panel call, which reads
// like a bug in the panel rather than the wrong account.
//
// SECRETS
// -------
// The token is written to capro-backend/.env (gitignored) and is NOT printed unless --print is
// passed. The OTP is read from the terminal, never from an argument by default, so it does not land
// in shell history.
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const API = process.env.CAPRO_API_BASE || "https://api.caprotoolkit.in";
const EMAIL = "saifullahfaizan786@gmail.com";
const ENV_PATH = new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ENV_KEY = "CAPRO_SUPER_ADMIN_JWT";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? true;
};
const printOnly = args.includes("--print");

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body: reported below with its status */ }
  return { status: res.status, json, text };
}

let otp = flag("--otp");

if (!otp) {
  console.log(`Requesting an OTP for ${EMAIL} ...`);
  const sent = await post("/api/auth/send-otp", { email: EMAIL });
  if (sent.status !== 200 || !sent.json?.ok) {
    console.error(`send-otp failed: HTTP ${sent.status} ${sent.text.slice(0, 200)}`);
    process.exit(1);
  }
  console.log("Sent. Check that inbox.\n");

  const rl = createInterface({ input: stdin, output: stdout });
  otp = (await rl.question("Enter the 6-digit code: ")).trim();
  rl.close();
}

const verified = await post("/api/auth/verify-otp", { email: EMAIL, otp: String(otp).trim() });

if (verified.status !== 200 || !verified.json?.token) {
  console.error(`\nverify-otp failed: HTTP ${verified.status}`);
  console.error(verified.json?.error || verified.text.slice(0, 300));
  console.error("\nA wrong or expired code is the usual cause. Re-run to get a fresh one.");
  process.exit(1);
}

const token = verified.json.token;
const role = verified.json.user?.role;

console.log("\nSigned in.");
console.log(`  role : ${role}`);
if (role !== "SUPER_ADMIN") {
  console.error(
    `\nWARNING: this account's role is ${role}, not SUPER_ADMIN. The token will authenticate but ` +
    "every admin-panel route will answer 403, which looks like the panel is broken when it is not.",
  );
}

if (printOnly) {
  console.log("\n--- token (do not paste this into a chat, an issue, or a commit) ---");
  console.log(token);
  process.exit(0);
}

// Write into .env, replacing any existing value for the key rather than appending a duplicate.
let env = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
const line = `${ENV_KEY}=${token}`;
const pattern = new RegExp(`^${ENV_KEY}=.*$`, "m");

if (pattern.test(env)) {
  env = env.replace(pattern, line);
  console.log(`\nUpdated ${ENV_KEY} in capro-backend/.env`);
} else {
  env = env.replace(/\s*$/, "\n") + line + "\n";
  console.log(`\nAdded ${ENV_KEY} to capro-backend/.env`);
}
writeFileSync(ENV_PATH, env, "utf8");

console.log("\nFor the browser admin panel, open https://api.caprotoolkit.in/admin/super.html,");
console.log("then in DevTools -> Console run:");
console.log(`  localStorage.setItem("caproadminjwt", "<the token>")`);
console.log("and reload. Re-run this script with --print if you need it on screen for that.");
console.log("\nThe token expires. If panel calls start returning 401, mint a new one.");
