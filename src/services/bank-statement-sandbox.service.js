// The process boundary every request path must use to open a bank-statement PDF.
//
// PDF.js parses hostile input. It therefore runs in a separate Node process that:
//   - is under the permission model, with read access to exactly the parser's own code and no
//     filesystem write, child-process, worker, addon or WASI permission;
//   - gets an empty environment, so no database URI, provider key or session secret is reachable;
//   - loads network-guard.js before the parser, removing every socket, DNS and fetch API;
//   - refuses string code generation, runs under a heap cap, and is killed at a wall-clock limit;
//   - talks to this process only over IPC, with stdout and stderr discarded.
//
// Every failure of the boundary fails closed as R-07. The child's answer is accepted only when it
// has the intake result shape and carries the content hash of the bytes this process sent, so a
// confused or compromised child cannot hand back a verdict about a different document.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BANK_STATEMENT_INTAKE_CODES,
  BANK_STATEMENT_INTAKE_LIMITS,
  bankStatementIntakeRejection,
  describeBankStatementFile,
} from "./bank-statement-intake.service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX_DIR = realpathSync(join(HERE, "bank-statement-sandbox"));
const GUARD = join(SANDBOX_DIR, "network-guard.js");
const WORKER = join(SANDBOX_DIR, "worker.js");

export const BANK_STATEMENT_SANDBOX_LIMITS = Object.freeze({
  // Process start-up and PDF.js module load, on top of the intake's own processing limit.
  startupGraceMs: 10_000,
  maxOldSpaceMb: 512,
});

const OPERATIONS = new Set(["inspect", "extract"]);
const RESULT_STATUSES = new Set(["REJECTED", "READY_FOR_LAYOUT_DETECTION"]);

function readAllowList(entry) {
  const require = createRequire(import.meta.url);
  const backendRoot = resolve(HERE, "..", "..");
  const pdfjsDir = realpathSync(dirname(require.resolve("pdfjs-dist/package.json")));
  // The ESM resolver reads the package through the logical node_modules path before it resolves
  // links, so both spellings of the same directory are needed when node_modules is a link.
  const pdfjsLogicalDir = join(backendRoot, "node_modules", "pdfjs-dist");
  return [...new Set([
    realpathSync(GUARD),
    realpathSync(entry),
    realpathSync(join(HERE, "bank-statement-intake.service.js")),
    // The nearest package.json decides that a .js file is an ES module.
    realpathSync(join(backendRoot, "package.json")),
    pdfjsDir,
    pdfjsLogicalDir,
  ])];
}

/**
 * The exact command line of the isolated process, or null when this Node runtime has no stable
 * permission model (the caller must then refuse rather than parse in-process). `entry` exists so a
 * test can run a probe script under the identical restrictions.
 */
export function bankStatementSandboxInvocation({ entry = WORKER } = {}) {
  if (!process.allowedNodeEnvironmentFlags.has("--permission")) return null;
  const args = [
    "--permission",
    ...readAllowList(entry).map((path) => `--allow-fs-read=${path}`),
    // Resolve modules by their logical path, so a linked node_modules never needs the link itself
    // (and with it the whole of node_modules) added to the read list. No effect without links.
    "--preserve-symlinks",
    "--disallow-code-generation-from-strings",
    `--max-old-space-size=${BANK_STATEMENT_SANDBOX_LIMITS.maxOldSpaceMb}`,
    "--import",
    pathToFileURL(realpathSync(GUARD)).href,
    realpathSync(entry),
  ];
  return {
    command: process.execPath,
    args,
    options: {
      cwd: SANDBOX_DIR,
      env: {},
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
      windowsHide: true,
    },
  };
}

function isIntakeResult(result, file) {
  return Boolean(result)
    && typeof result === "object"
    && typeof result.accepted === "boolean"
    && RESULT_STATUSES.has(result.status)
    && result.accepted === (result.status === "READY_FOR_LAYOUT_DETECTION")
    && result.file?.sha256 === file.sha256
    && result.file?.size === file.size;
}

/**
 * Runs the intake ("inspect") or positional extraction ("extract") in the isolated process.
 * Resolves with the same result shape as the in-process helpers; never rejects for a bad document.
 * `entry` replaces the worker script and exists only so the contract suite can prove that a child
 * which crashes or answers about a different document is refused.
 */
export function runBankStatementPdfInSandbox({
  operation,
  bytes,
  fileName = "",
  password = null,
  limits = {},
  timeoutMs,
  entry,
} = {}) {
  if (!OPERATIONS.has(operation)) {
    throw new TypeError(`Unknown bank-statement sandbox operation: ${operation}`);
  }
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const file = describeBankStatementFile(input, fileName);
  const effectiveLimits = { ...BANK_STATEMENT_INTAKE_LIMITS, ...limits };
  const unsafe = (message) => bankStatementIntakeRejection(BANK_STATEMENT_INTAKE_CODES.UNSAFE, message, { file });

  // Never ship an over-limit buffer across the process boundary.
  if (input.length > effectiveLimits.maxBytes) {
    return Promise.resolve(bankStatementIntakeRejection(
      BANK_STATEMENT_INTAKE_CODES.FILE_LIMIT,
      "This PDF exceeds the supported file-size limit.",
      { file },
    ));
  }
  const invocation = bankStatementSandboxInvocation(entry ? { entry } : {});
  if (!invocation) {
    return Promise.resolve(unsafe("Safe PDF processing is not available on this server."));
  }

  const deadlineMs = timeoutMs ?? effectiveLimits.maxProcessingMs + BANK_STATEMENT_SANDBOX_LIMITS.startupGraceMs;
  return new Promise((settle) => {
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      settle(result);
    };
    const timer = setTimeout(
      () => finish(unsafe("This PDF could not be processed within the configured safety limits.")),
      deadlineMs,
    );
    try {
      child = spawn(invocation.command, invocation.args, invocation.options);
    } catch {
      finish(unsafe("This PDF could not be processed safely."));
      return;
    }
    // "on", not "once": a ChildProcess can emit more than one error (a failed IPC write after an early exit),
    // and an unhandled second one would take down the API process that called us.
    child.on("error", () => finish(unsafe("This PDF could not be processed safely.")));
    // "close", not "exit": it follows the IPC channel draining, so a last message is never lost.
    child.once("close", () => finish(unsafe("This PDF could not be processed safely.")));
    child.once("message", (message) => {
      if (message?.ok === true && isIntakeResult(message.result, file)) finish(message.result);
      else finish(unsafe("This PDF could not be processed safely."));
    });
    child.send(
      { operation, bytes: new Uint8Array(input), fileName, password, limits },
      (error) => { if (error) finish(unsafe("This PDF could not be processed safely.")); },
    );
  });
}
