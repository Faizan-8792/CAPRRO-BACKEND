// Loads environment variables as early as possible, before any module that
// reads process.env at import time (e.g. controllers that require JWT_SECRET).
//
// Import this FIRST in src/server.js. It attempts the current working
// directory first, then falls back to the package root resolved from this
// file's location, so a bundled .env is found regardless of the process cwd
// (Hostinger and other hosts may run the app from a different directory).
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// src/config/load-env.js -> package root is two levels up.
const packageRootEnv = path.resolve(currentDir, "..", "..", ".env");

// cwd-based load first (no-op if absent). dotenv does not override existing
// process.env values, so real host-provided env vars always win.
dotenv.config();
// Absolute-path fallback for hosts that run with a different cwd.
dotenv.config({ path: packageRootEnv });
