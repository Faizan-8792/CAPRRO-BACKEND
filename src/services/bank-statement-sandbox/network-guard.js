// Preloaded with --import into the bank-statement PDF process before any parser code is loaded.
//
// Node 24's permission model restricts the filesystem, child processes, workers, addons and WASI,
// but it has no network permission. This module closes that gap at the API level: every built-in
// way to open a socket, resolve a name, or listen is replaced with a function that throws, the
// replacements are made non-writable, and the ESM named exports are re-synced so an `import
// { connect } from "node:net"` sees the refusal too. It is defence in depth for a process that
// already has no secrets in its environment and no file access beyond the parser's own code; it is
// not kernel-level network isolation.

import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

export const SANDBOX_NETWORK_REFUSAL = "ERR_BANK_STATEMENT_SANDBOX_NETWORK";

function refusal(name) {
  return function refusedNetworkAccess() {
    const error = new Error(`Network access is disabled in the bank-statement sandbox (${name}).`);
    error.code = SANDBOX_NETWORK_REFUSAL;
    throw error;
  };
}

function seal(target, key, name) {
  if (!target || !(key in target)) return;
  Object.defineProperty(target, key, {
    value: refusal(name),
    writable: false,
    configurable: false,
    enumerable: true,
  });
}

for (const key of ["connect", "createConnection", "createServer"]) seal(net, key, `net.${key}`);
seal(net.Socket.prototype, "connect", "net.Socket.connect");
seal(net.Server.prototype, "listen", "net.Server.listen");
for (const key of ["connect", "createServer", "createSecureContext"]) seal(tls, key, `tls.${key}`);
for (const key of ["request", "get", "createServer"]) {
  seal(http, key, `http.${key}`);
  seal(https, key, `https.${key}`);
}
for (const key of ["connect", "createServer", "createSecureServer"]) seal(http2, key, `http2.${key}`);
seal(dgram, "createSocket", "dgram.createSocket");

function namesInChain(object) {
  const names = new Set();
  for (let current = object; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
    for (const name of Object.getOwnPropertyNames(current)) names.add(name);
  }
  return names;
}

const NAME_RESOLUTION = /^(lookup|resolve|reverse)/;
for (const [target, label] of [
  [dns, "dns"],
  [dns.promises, "dns.promises"],
  [dns.Resolver.prototype, "dns.Resolver"],
  [dns.promises.Resolver.prototype, "dns.promises.Resolver"],
]) {
  for (const key of namesInChain(target)) {
    if (NAME_RESOLUTION.test(key) && typeof target[key] === "function") seal(target, key, `${label}.${key}`);
  }
}
for (const key of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) seal(globalThis, key, key);

syncBuiltinESMExports();
