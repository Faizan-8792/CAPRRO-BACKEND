// The detector behind tests/no-exit-after-network-contract.mjs (V32): which files make requests, and
// which of those call process.exit(). Pure apart from listSources(), so the suite can point it at the
// real tree, at small in-memory trees, and at a copy of an older one.
import * as acorn from "acorn";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SOURCE_FILE = /\.(mjs|cjs|js)$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "bin", "obj"]);

export function listSources(path) {
  if (!existsSync(path)) return [];
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full);
      } else if (SOURCE_FILE.test(entry.name)) {
        found.push(full);
      }
    }
  };
  if (SOURCE_FILE.test(path)) found.push(path);
  else walk(path);
  return found;
}

// ─── the analysis, pure: a Map of absolute path -> source text in, findings out ─────────────────────

const GLOBAL_OBJECTS = new Set(["globalThis", "global", "window", "self"]);
const PROCESS_MODULES = new Set(["node:process", "process"]);

function parseSource(source) {
  const base = { ecmaVersion: "latest", allowHashBang: true, locations: true };
  try {
    return acorn.parse(source, { ...base, sourceType: "module", allowAwaitOutsideFunction: true });
  } catch (moduleError) {
    try {
      return acorn.parse(source, { ...base, sourceType: "script", allowReturnOutsideFunction: true });
    } catch {
      throw moduleError;
    }
  }
}

// Visits every node with the node that holds it and the property it sits in.
function walk(node, visit, parent = null, key = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent, key);
  for (const childKey of Object.keys(node)) {
    if (childKey === "loc") continue;
    const child = node[childKey];
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit, node, childKey);
    } else if (child && typeof child === "object") {
      walk(child, visit, node, childKey);
    }
  }
}

// Is this Identifier a USE of the name, rather than a property name, a label or a declaration? The
// global fetch handed on as a value ("fetchImpl = fetch", "{ fetch }") is a request maker just as a
// call is: tools/lib/deploy-archive-exposure.mjs reaches the network that way.
function isReference(parent, key) {
  if (!parent) return true;
  switch (parent.type) {
    case "MemberExpression":
      return !(key === "property" && !parent.computed);
    case "Property":
    case "PropertyDefinition":
    case "MethodDefinition":
      return !(key === "key" && !parent.computed);
    case "VariableDeclarator":
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ClassDeclaration":
    case "ClassExpression":
      return key !== "id" && key !== "params";
    case "ArrowFunctionExpression":
      return key !== "params";
    case "AssignmentPattern":
    case "AssignmentExpression":
      return key !== "left";
    case "CatchClause":
      return key !== "param";
    case "RestElement":
    case "ArrayPattern":
    case "ObjectPattern":
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportSpecifier":
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return false;
    default:
      return true;
  }
}

const memberName = (member) => {
  if (!member.computed) return member.property.name;
  return member.property.type === "Literal" ? String(member.property.value) : null;
};

/**
 * What one file does on its own: where it exits, where it makes requests, what it imports.
 * @returns {{exits: {line: number, what: string}[], requests: {line: number, what: string}[], imports: string[]}}
 */
export function analyse(source) {
  const ast = parseSource(source);
  const processNames = new Set(["process"]);
  const exitNames = new Set();
  const out = { exits: [], requests: [], imports: [] };

  const isProcess = (node) =>
    (node.type === "Identifier" && processNames.has(node.name)) ||
    (node.type === "MemberExpression" &&
      node.object.type === "Identifier" &&
      GLOBAL_OBJECTS.has(node.object.name) &&
      memberName(node) === "process");

  // Pass 1: the names that mean "the process" or "its exit function" in this file.
  walk(ast, (node) => {
    if (node.type === "ImportDeclaration" && PROCESS_MODULES.has(node.source.value)) {
      for (const spec of node.specifiers) {
        if (spec.type === "ImportSpecifier" && spec.imported.name === "exit") exitNames.add(spec.local.name);
        else if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") processNames.add(spec.local.name);
      }
    }
    if (node.type === "VariableDeclarator" && node.init && node.id.type === "ObjectPattern" && isProcess(node.init)) {
      for (const prop of node.id.properties) {
        if (prop.type === "Property" && !prop.computed && prop.key.name === "exit" && prop.value.type === "Identifier") {
          exitNames.add(prop.value.name);
        }
      }
    }
  });

  // Pass 2: the findings.
  walk(ast, (node, parent, key) => {
    const line = node.loc?.start.line ?? 0;
    if (node.type === "Identifier" && node.name === "fetch" && isReference(parent, key)) {
      out.requests.push({ line, what: parent?.type === "CallExpression" && key === "callee" ? "fetch(" : "fetch (used as a value)" });
    }
    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (callee.type === "MemberExpression") {
        const name = memberName(callee);
        if (isProcess(callee.object) && (name === "exit" || name === "reallyExit")) {
          out.exits.push({ line, what: `process.${name}(` });
        }
        if (name === "listen" && !callee.computed) out.requests.push({ line, what: ".listen(" });
        if (name === "fetch" && callee.object.type === "Identifier" && GLOBAL_OBJECTS.has(callee.object.name)) {
          out.requests.push({ line, what: `${callee.object.name}.fetch(` });
        }
      } else if (callee.type === "Identifier") {
        if (exitNames.has(callee.name)) out.exits.push({ line, what: `${callee.name}( (process.exit)` });
      }
    }
    if (node.type === "NewExpression") {
      const callee = node.callee;
      if (callee.type === "Identifier" && callee.name === "WebSocket") out.requests.push({ line, what: "new WebSocket(" });
      if (callee.type === "MemberExpression" && memberName(callee) === "WebSocket" && callee.object.type === "Identifier" && GLOBAL_OBJECTS.has(callee.object.name)) {
        out.requests.push({ line, what: `new ${callee.object.name}.WebSocket(` });
      }
    }
    const specifier = importSpecifier(node);
    if (typeof specifier === "string" && (specifier.startsWith("./") || specifier.startsWith("../"))) out.imports.push(specifier);
  });
  return out;
}

// The module a statement or expression pulls in, when it names one literally.
function importSpecifier(node) {
  if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") {
    return node.source ? node.source.value : null;
  }
  if (node.type === "ImportExpression") {
    if (node.source.type === "Literal") return node.source.value;
    if (node.source.type === "TemplateLiteral" && node.source.expressions.length === 0) return node.source.quasis[0].value.cooked;
  }
  return null;
}

function resolveImport(from, specifier, files) {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, join(base, "index.mjs"), join(base, "index.js")]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

/**
 * @param {Map<string, string>} files absolute path -> source; only these files are scanned and only
 *   imports that resolve to one of them are followed (so src/ is outside by construction).
 */
export function scan(files) {
  const analysed = new Map();
  const parseErrors = [];
  for (const [path, source] of files) {
    try {
      analysed.set(path, analyse(source));
    } catch (error) {
      parseErrors.push({ path, message: error.message });
    }
  }

  const reasonMemo = new Map();
  // Why a file makes requests: its own call, or an import that does; null when it makes none.
  const requestReason = (path, visiting = new Set()) => {
    if (reasonMemo.has(path)) return reasonMemo.get(path);
    const info = analysed.get(path);
    if (!info || visiting.has(path)) return null;
    visiting.add(path);
    let reason = info.requests.length ? `${info.requests[0].what} at line ${info.requests[0].line}` : null;
    if (!reason) {
      for (const specifier of info.imports) {
        const target = resolveImport(path, specifier, files);
        const inner = target ? requestReason(target, visiting) : null;
        if (inner) {
          reason = `imports ${specifier}, which makes requests (${inner})`;
          break;
        }
      }
    }
    visiting.delete(path);
    // Only a settled answer is memoised: one cut short by a cycle could be wrong from another start.
    if (visiting.size === 0) reasonMemo.set(path, reason);
    return reason;
  };

  const violations = [];
  const requestMakers = new Set();
  for (const [path, info] of analysed) {
    const reason = requestReason(path);
    if (reason) requestMakers.add(path);
    if (reason && info.exits.length) {
      violations.push({ path, exits: info.exits, reason });
    }
  }
  return { violations, requestMakers, parseErrors, scanned: analysed.size };
}
