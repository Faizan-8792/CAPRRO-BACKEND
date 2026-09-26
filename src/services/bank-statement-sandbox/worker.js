// Entry point of the isolated bank-statement PDF process. Started only by
// bank-statement-sandbox.service.js, under the permission model and after network-guard.js.
//
// It receives one request over the IPC channel, answers once, and exits. Its stdout and stderr are
// discarded by the parent, and console output is silenced here as well, so a parser warning can
// never carry statement text into a log.

for (const method of ["log", "info", "warn", "error", "debug", "trace"]) console[method] = () => {};

// PDF.js constructs a DOMMatrix at module load and, when none exists, loads the native
// @napi-rs/canvas addon to polyfill it. Native addons bypass the permission model, so this process
// is started without --allow-addons and supplies these instead. Text and operator-list extraction do
// not use them; rendering would. Any use throws, so it fails closed rather than computing with a
// matrix that has no values.
function renderingOnly(name) {
  return class RenderingUnavailable {
    constructor() {
      return new Proxy({}, {
        get(_target, property) {
          if (typeof property === "symbol") return undefined;
          throw new Error(`${name} is not available in the bank-statement sandbox.`);
        },
        set() {
          throw new Error(`${name} is not available in the bank-statement sandbox.`);
        },
      });
    }
  };
}
for (const name of ["DOMMatrix", "ImageData", "Path2D"]) {
  if (!(name in globalThis)) globalThis[name] = renderingOnly(name);
}

const { extractBankStatementTextPositions, inspectBankStatementPdf } = await import("../bank-statement-intake.service.js");

const OPERATIONS = Object.freeze({
  inspect: inspectBankStatementPdf,
  extract: extractBankStatementTextPositions,
});

function reply(message) {
  process.send(message, () => process.exit(0));
}

if (typeof process.send !== "function") {
  process.exit(70);
} else {
  process.once("message", async (request) => {
    const operation = Object.hasOwn(OPERATIONS, request?.operation) ? OPERATIONS[request.operation] : null;
    if (!operation) {
      reply({ ok: false, reason: "UNKNOWN_OPERATION" });
      return;
    }
    try {
      const result = await operation({
        bytes: Buffer.from(request.bytes ?? []),
        fileName: request.fileName ?? "",
        password: request.password ?? null,
        limits: request.limits ?? {},
      });
      reply({ ok: true, result });
    } catch {
      reply({ ok: false, reason: "WORKER_ERROR" });
    }
  });
}
