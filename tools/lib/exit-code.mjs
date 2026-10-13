// How a script that talks to the network ends: it sets process.exitCode and lets Node finish. It does
// not call process.exit().
//
// WHY THIS EXISTS
// ---------------
// On Node 24 under Windows, process.exit() after a fetch() aborts the process with exit code
// 3221226505 (0xC0000409) and "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
// src\win\async.c, line 76". fetch() makes V8 compile undici's WebAssembly HTTP parser in the
// background, and exiting while that compile is still running trips libuv. Measured 2026-10-05: a
// script that made three requests and then called process.exit() aborted 8 runs of 8; the same script
// ending with process.exitCode exited cleanly 8 of 8, as did node --liftoff-only, a 3 s wait before
// the exit, and http.get in place of fetch. So a gate suite that had PASSED could end with a crash
// code, and an operator tool could report a crash code for a clean run (V32).
//
// The fix is to never exit early, which means a failure that has to stop a long flow cannot be a
// process.exit(1) inside a helper. It is an ExitRequest thrown from wherever the failure is found and
// turned into the exit code in one place:
//
//   async function main() {
//     if (!token) throw new ExitRequest(2, "TOKEN is not set.");   // or: return 2;
//     ...
//     return failed ? 1 : 0;
//   }
//   await runToExitCode(main);
//
// An unexpected error is printed and ends the run with code 1 instead of being rethrown: an uncaught
// exception also leaves through Node's exit path, so rethrowing after a fetch would reintroduce the
// same crash code.
//
// tests/no-exit-after-network-contract.mjs fails the gates if a file that uses fetch(), listen() or a
// WebSocket calls process.exit(), so this is enforced rather than remembered.

export class ExitRequest extends Error {
  constructor(code, message = "") {
    super(message);
    this.name = "ExitRequest";
    this.code = code;
  }
}

/**
 * Runs main() and sets process.exitCode from the number it returns, or from an ExitRequest thrown
 * anywhere inside it (whose message, if there is one, goes to stderr). A main() that returns nothing
 * leaves process.exitCode as it set it.
 *
 * @param {() => Promise<number | void> | number | void} main
 */
export async function runToExitCode(main) {
  try {
    const code = await main();
    if (typeof code === "number") process.exitCode = code;
  } catch (error) {
    if (error instanceof ExitRequest) {
      if (error.message) console.error(error.message);
      process.exitCode = error.code;
    } else {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    }
  }
}
