// Runs under the exact bank-statement sandbox command line, in place of the worker, and tries every
// escape the boundary claims to close. It reports "refused" or "ALLOWED: <detail>" per attempt.

import child_process from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { connect as namedConnect } from "node:net";
import tls from "node:tls";
import { Worker } from "node:worker_threads";

// An attempt that was let through can fail later (a refused TCP connect emits "error"); it has
// already been reported as ALLOWED, so the late failure must not kill the probe before it reports.
process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});

// A call that is still pending was not refused - it was let through and is waiting on the network.
async function attempt(action) {
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(action),
      new Promise((settle) => { timer = setTimeout(() => settle("pending"), 3_000); }),
    ]);
    if (typeof value?.on === "function") value.on("error", () => {});
    return `ALLOWED: ${String(value).slice(0, 80)}`;
  } catch (error) {
    // Only the boundary's own refusals count. A connection that was attempted and then refused by
    // the far end (ECONNREFUSED) proves the call was let through.
    const refusedByBoundary = error?.code === "ERR_BANK_STATEMENT_SANDBOX_NETWORK"
      || error?.code === "ERR_ACCESS_DENIED"
      || error instanceof EvalError
      || (error instanceof TypeError && /read.only|not writable|Cannot assign/i.test(error.message));
    return refusedByBoundary ? "refused" : `ALLOWED: attempted, then ${error?.code ?? error?.name}`;
  } finally {
    clearTimeout(timer);
  }
}

process.once("message", async ({ secretFile, writeFile, canaryName }) => {
  const results = {
    fetch: await attempt(() => fetch("http://127.0.0.1:9/")),
    webSocket: await attempt(() => new WebSocket("ws://127.0.0.1:9/")),
    netConnect: await attempt(() => net.connect({ host: "127.0.0.1", port: 9 })),
    netNamedImport: await attempt(() => namedConnect({ host: "127.0.0.1", port: 9 })),
    netSocketConnect: await attempt(() => new net.Socket().connect({ host: "127.0.0.1", port: 9 })),
    netListen: await attempt(() => net.createServer().listen(0)),
    tlsConnect: await attempt(() => tls.connect({ host: "127.0.0.1", port: 9 })),
    httpGet: await attempt(() => http.get("http://127.0.0.1:9/")),
    httpsRequest: await attempt(() => https.request("https://127.0.0.1:9/")),
    dnsLookup: await attempt(() => new Promise((ok, fail) => dns.lookup("localhost", (e, a) => (e ? fail(e) : ok(a))))),
    dnsPromisesLookup: await attempt(() => dns.promises.lookup("localhost")),
    dnsResolver: await attempt(() => new dns.promises.Resolver().resolve4("localhost")),
    udpSocket: await attempt(() => dgram.createSocket("udp4")),
    tcpBinding: await attempt(() => process.binding("tcp_wrap")),
    restoreNetConnect: await attempt(() => { net.connect = () => "restored"; return net.connect(); }),
    readOutsideAllowList: await attempt(() => fs.readFileSync(secretFile, "utf8")),
    writeFile: await attempt(() => { fs.writeFileSync(writeFile, "x"); return "written"; }),
    spawnProcess: await attempt(() => child_process.spawnSync(process.execPath, ["-v"]).stdout),
    workerThread: await attempt(() => new Worker("process.exit(0)", { eval: true })),
    stringEval: await attempt(() => eval("1 + 1")),
    functionConstructor: await attempt(() => new Function("return 1")()),
    environmentCanary: process.env[canaryName] === undefined ? "refused" : "ALLOWED: canary visible",
  };
  process.send(results, () => process.exit(0));
});
