const http = require("http");
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const os = require("os");
const zlib = require("zlib");
const { spawn, execFile } = require("child_process");

const PORT = Number(process.env.PORT) || 8787;
const WORKSPACE = path.join(process.cwd(), "workspace");
const INDEX_PATH = path.join(__dirname, "public", "index.html");
const MAX_OUTPUT = 300_000;
const MAX_JOBS = 40;
const MAX_RUNNING = 8;
const MAX_WAIT_MS = 55_000;

const jobs = new Map();
const authFails = new Map();
const routes = new Map();
const upstreamHosts = new Map();
let seq = 0;

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

fs.mkdirSync(WORKSPACE, { recursive: true });

function send(res, status, body) {
  const json = typeof body !== "string";
  const payload = json ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Content-Type": json
      ? "application/json; charset=utf-8"
      : "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function bearer(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function tokenOk(provided) {
  const expected = process.env.CMD_TOKEN || "";
  if (!expected || !provided) return false;
  const a = crypto.createHash("sha256").update(String(expected)).digest();
  const b = crypto.createHash("sha256").update(String(provided)).digest();
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function authorize(req) {
  if (!process.env.CMD_TOKEN) {
    return {
      ok: false,
      status: 503,
      error: "Set CMD_TOKEN on this service, then paste that value into the page.",
    };
  }
  const ip = clientIp(req);
  const row = authFails.get(ip);
  if (row && row.n >= 8 && Date.now() < row.reset) {
    return { ok: false, status: 429, error: "Too many bad tokens. Wait a minute." };
  }
  if (!tokenOk(bearer(req))) {
    const next = row && Date.now() < row.reset ? row : { n: 0, reset: Date.now() + 60_000 };
    next.n += 1;
    authFails.set(ip, next);
    return { ok: false, status: 401, error: "Bad or missing token." };
  }
  authFails.delete(ip);
  return { ok: true };
}

function append(job, text) {
  job.output += text;
  if (job.output.length > MAX_OUTPUT) {
    job.output = job.output.slice(-MAX_OUTPUT);
    job.truncated = true;
  }
}

function publicJob(job, full) {
  const output = full ? job.output : job.output.slice(-1200);
  return {
    id: job.id,
    command: job.command,
    cwd: job.cwd,
    status: job.status,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    pid: job.pid,
    truncated: job.truncated,
    output,
  };
}

function resolveCwd(input) {
  const raw = String(input || "").trim();
  const resolved = raw
    ? path.resolve(raw.startsWith("/") ? raw : path.join(WORKSPACE, raw))
    : WORKSPACE;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    const error = new Error(`Working directory does not exist: ${resolved}`);
    error.status = 400;
    throw error;
  }
  return resolved;
}

function runningCount() {
  let n = 0;
  for (const job of jobs.values()) {
    if (job.status === "running") n += 1;
  }
  return n;
}

function trimJobs() {
  const finished = [...jobs.values()].filter((job) => job.status !== "running");
  while (jobs.size > MAX_JOBS && finished.length) {
    const oldest = finished.shift();
    jobs.delete(oldest.id);
  }
}

function startJob(command, cwd) {
  if (runningCount() >= MAX_RUNNING) {
    const error = new Error(`Too many running commands (max ${MAX_RUNNING}). Kill one first.`);
    error.status = 429;
    throw error;
  }

  const id = String(++seq);
  const job = {
    id,
    command,
    cwd,
    status: "running",
    exitCode: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    output: "",
    truncated: false,
    pid: null,
    child: null,
  };

  const child = spawn("/bin/bash", ["-c", command], {
    cwd,
    env: {
      ...process.env,
      BROWSER: "none",
      CI: process.env.CI || "true",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  job.child = child;
  job.pid = child.pid;
  append(job, `$ ${command}\n`);

  const onData = (buf) => append(job, buf.toString("utf8"));
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (err) => {
    append(job, `\n[spawn error] ${err.message}\n`);
    job.status = "error";
    job.endedAt = new Date().toISOString();
  });
  child.on("close", (code) => {
    if (job.status === "running") job.status = "exited";
    job.exitCode = code;
    job.endedAt = new Date().toISOString();
    append(job, `\n[exit ${code}]\n`);
  });

  jobs.set(id, job);
  trimJobs();
  return job;
}

function waitJob(job, ms) {
  if (job.status !== "running") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    job.child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function killJob(job) {
  if (!job.pid || job.status !== "running") return false;
  try {
    process.kill(-job.pid, "SIGTERM");
  } catch {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    if (job.status !== "running") return;
    try {
      process.kill(-job.pid, "SIGKILL");
    } catch {
      try {
        process.kill(job.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 1500);
  return true;
}

function tcpOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function httpGet(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET", timeout: 2000 },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size <= 800) chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8").slice(0, 400),
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "timeout" });
    });
    req.on("error", (err) => resolve({ error: err.message }));
    req.end();
  });
}

async function probePort(port) {
  const tcp = await tcpOpen(port);
  if (!tcp) return { port, tcp: false, thisService: port === PORT };
  const httpResult = await httpGet(port);
  return { port, tcp: true, http: httpResult, thisService: port === PORT };
}

function clampPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error("Port must be an integer from 1 to 65535.");
    error.status = 400;
    throw error;
  }
  return port;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

function textPage(res, status, message) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(
    `<!DOCTYPE html><meta charset="utf-8"><title>${status}</title><p>${escapeHtml(message)}</p>`
  );
}

function publicPath(port) {
  return `/p/${port}/`;
}

function publishRoute(port, options = {}) {
  if (port === PORT) {
    const error = new Error("That port is this sandbox. Publish the port your other server is using.");
    error.status = 400;
    throw error;
  }
  const prev = routes.get(port);
  const route = {
    port,
    label: String(options.label || "").trim().slice(0, 80),
    strip: options.strip !== false,
    createdAt: prev ? prev.createdAt : new Date().toISOString(),
  };
  routes.set(port, route);
  console.log(`published ${publicPath(port)} -> 127.0.0.1:${port} strip=${route.strip}`);
  return route;
}

function routeJson(route, online) {
  return {
    port: route.port,
    label: route.label,
    strip: route.strip,
    path: publicPath(route.port),
    createdAt: route.createdAt,
    online: Boolean(online),
  };
}

function processTable() {
  return new Promise((resolve) => {
    execFile("ps", ["-eo", "pid=,ppid="], { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve([]);
        return;
      }
      const rows = [];
      for (const line of stdout.trim().split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/).map((part) => Number(part));
        if (pid && ppid >= 0) rows.push({ pid, ppid });
      }
      resolve(rows);
    });
  });
}

function descendantPids(roots, rows) {
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const seen = new Set(roots);
  const stack = [...roots];
  while (stack.length) {
    const pid = stack.pop();
    for (const child of children.get(pid) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      stack.push(child);
    }
  }
  return [...seen];
}

function socketInodes(pid) {
  const fdDir = `/proc/${pid}/fd`;
  if (!fs.existsSync(fdDir)) return [];
  const inodes = [];
  for (const fd of fs.readdirSync(fdDir)) {
    try {
      const target = fs.readlinkSync(path.join(fdDir, fd));
      const match = target.match(/^socket:\[(\d+)\]$/);
      if (match) inodes.push(Number(match[1]));
    } catch {
      /* fd vanished */
    }
  }
  return inodes;
}

function parseProc(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(1);
  const rows = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10 || parts[3] !== "0A") continue;
    const [ipHex, portHex] = parts[1].split(":");
    const port = Number.parseInt(portHex, 16);
    const inode = Number(parts[9]);
    let address = ipHex;
    if (ipHex === "00000000" || ipHex === "00000000000000000000000000000000") address = "0.0.0.0";
    else if (ipHex.length === 8) {
      address = ipHex
        .match(/../g)
        .reverse()
        .map((byte) => Number.parseInt(byte, 16))
        .join(".");
    } else {
      address = "ipv6";
    }
    rows.push({ address, port, inode });
  }
  return rows;
}

function listenersFromProc(pids) {
  const open = [...parseProc("/proc/net/tcp"), ...parseProc("/proc/net/tcp6")];
  const inodes = new Set();
  for (const pid of pids) {
    for (const inode of socketInodes(pid)) inodes.add(inode);
  }
  return open.filter((row) => inodes.has(row.inode));
}

function listenersFromLsof(pids) {
  return new Promise((resolve) => {
    const args = ["-nP", "-Fpn", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(",")];
    execFile("lsof", args, { timeout: 3000 }, (err, stdout) => {
      if (!stdout) {
        resolve([]);
        return;
      }
      const rows = [];
      for (const line of stdout.split("\n")) {
        if (!line.startsWith("n")) continue;
        const name = line.slice(1);
        const match = name.match(/:(\d+)$/);
        if (!match) continue;
        const port = Number(match[1]);
        let address = name.slice(0, name.length - match[0].length);
        if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
        if (address === "*") address = "0.0.0.0";
        rows.push({ address, port });
      }
      resolve(err && !rows.length ? [] : rows);
    });
  });
}

function dedupeListeners(rows) {
  const byPort = new Map();
  for (const row of rows) {
    if (!row.port || row.port < 1 || row.port > 65535) continue;
    if (!byPort.has(row.port)) byPort.set(row.port, { address: row.address, port: row.port });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

async function jobListeners() {
  const roots = [];
  for (const job of jobs.values()) {
    if (job.status === "running" && job.pid) roots.push(job.pid);
  }
  if (!roots.length) return [];
  const pids = descendantPids(roots, await processTable());
  if (!pids.length) return [];
  const rows = fs.existsSync("/proc/net/tcp")
    ? listenersFromProc(pids)
    : await listenersFromLsof(pids);
  return dedupeListeners(rows).filter((row) => row.port !== PORT);
}

async function upstreamHost(port) {
  const cached = upstreamHosts.get(port);
  if (cached && Date.now() < cached.until) return cached.host;
  if (await tcpOpen(port, "127.0.0.1")) {
    upstreamHosts.set(port, { host: "127.0.0.1", until: Date.now() + 4000 });
    return "127.0.0.1";
  }
  if (await tcpOpen(port, "::1")) {
    upstreamHosts.set(port, { host: "::1", until: Date.now() + 4000 });
    return "::1";
  }
  return "127.0.0.1";
}

function hostHeader(host, port) {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function listListeners() {
  if (fs.existsSync("/proc/net/tcp")) {
    return {
      source: "proc",
      listeners: dedupeListeners([...parseProc("/proc/net/tcp"), ...parseProc("/proc/net/tcp6")]),
    };
  }
  return new Promise((resolve) => {
    execFile("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { timeout: 3000 }, (err, stdout) => {
      resolve({
        source: err ? "unavailable" : "lsof",
        text: err ? err.message : stdout,
      });
    });
  });
}

function upstreamPath(rawUrl, port, strip) {
  const queryAt = rawUrl.indexOf("?");
  const pathname = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const search = queryAt === -1 ? "" : rawUrl.slice(queryAt);
  if (!strip) return pathname + search;
  const prefix = `/p/${port}`;
  let next = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
  if (!next.startsWith("/")) next = `/${next}`;
  return next + search;
}

function clientForwardedFor(req) {
  const current = req.headers["x-forwarded-for"];
  const ip = req.socket.remoteAddress || "";
  if (typeof current === "string" && current.length) return `${current}, ${ip}`;
  return ip;
}

function requestHeaders(req, port, upgrade, targetHost) {
  const connection = String(req.headers.connection || "")
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const listed = new Set(connection);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const name = key.toLowerCase();
    if (HOP_HEADERS.has(name) || listed.has(name)) continue;
    headers[name] = value;
  }
  headers.host = hostHeader(targetHost, port);
  headers["x-forwarded-for"] = clientForwardedFor(req);
  headers["x-forwarded-host"] = req.headers.host || "";
  headers["x-forwarded-proto"] = req.headers["x-forwarded-proto"] || "http";
  headers["x-forwarded-prefix"] = `/p/${port}`;
  if (upgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade || "websocket";
  } else {
    headers["accept-encoding"] = "identity";
  }
  return headers;
}

function copyResponseHeaders(upstream) {
  const headers = {};
  for (const [key, value] of Object.entries(upstream)) {
    if (HOP_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  return headers;
}

function rewriteLocation(location, route, req) {
  if (!location || Array.isArray(location)) return location;
  const prefix = `/p/${route.port}`;
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  if (location.startsWith("/")) {
    if (!route.strip || location === prefix || location.startsWith(`${prefix}/`)) return location;
    return prefix + location;
  }
  try {
    const target = new URL(location);
    const localHost =
      target.hostname === "127.0.0.1" || target.hostname === "localhost" || target.hostname === "::1";
    if (!localHost || Number(target.port) !== route.port) return location;
    let pathname = target.pathname;
    if (route.strip && pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
      pathname = prefix + (pathname.startsWith("/") ? pathname : `/${pathname}`);
    }
    return `${proto}://${host}${pathname}${target.search}${target.hash}`;
  } catch {
    return location;
  }
}

function rewriteCookie(cookie, route) {
  if (!route.strip) return cookie;
  const prefix = `/p/${route.port}`;
  if (!/path=/i.test(cookie)) return `${cookie}; Path=${prefix}/`;
  return cookie.replace(new RegExp(String.raw`Path=/(?!p/${route.port}(?:/|$))`, "i"), `Path=${prefix}/`);
}

function rewriteRoots(text, port) {
  const prefix = `/p/${port}`;
  const attr = new RegExp(
    String.raw`\b(href|src|action|poster|formaction)\s*=\s*(["'])/(?!/|p/${port}/)`,
    "gi"
  );
  const cssUrl = new RegExp(String.raw`url\(\s*(["']?)/(?!/|p/${port}/)`, "gi");
  const srcset = new RegExp(String.raw`\bsrcset\s*=\s*(["'])([\s\S]*?)\1`, "gi");
  const srcsetPath = new RegExp(String.raw`(^|,\s*)/(?!/|p/${port}/)`, "g");
  return text
    .replace(attr, (_match, name, quote) => `${name}=${quote}${prefix}/`)
    .replace(cssUrl, (_match, quote) => `url(${quote || ""}${prefix}/`)
    .replace(srcset, (_match, quote, value) => {
      return `srcset=${quote}${value.replace(srcsetPath, `$1${prefix}/`)}${quote}`;
    });
}

function proxyShim(port) {
  const prefix = JSON.stringify(`/p/${port}`);
  return `<script data-port-proxy>(function(){var p=${prefix};function prefixed(path){return path===p||path.indexOf(p+"/")===0}function map(u){if(typeof u!=="string"||u===p||u.indexOf(p+"/")===0||u.indexOf(p+"?")===0||u.indexOf(p+"#")===0||u.charAt(0)==="#"||u.indexOf("data:")===0||u.indexOf("blob:")===0||u.indexOf("mailto:")===0||u.indexOf("javascript:")===0)return u;if(u.charAt(0)==="/"&&u.charAt(1)!=="/")return p+u;if(/^(https?:|wss?:)/.test(u)){try{var x=new URL(u);if(x.hostname!==location.hostname)return u;if(/^wss?:/.test(x.protocol)){x.protocol=location.protocol==="https:"?"wss:":"ws:";x.port=location.port}if(!prefixed(x.pathname))x.pathname=p+x.pathname;return x.toString()}catch(e){}}return u}function patchProp(proto,prop){var d=Object.getOwnPropertyDescriptor(proto,prop);if(!d||!d.set||!d.get)return;Object.defineProperty(proto,prop,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){d.set.call(this,map(String(v)))}})}patchProp(HTMLScriptElement.prototype,"src");patchProp(HTMLLinkElement.prototype,"href");patchProp(HTMLImageElement.prototype,"src");var setAttr=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if(/^(src|href|action|poster)$/i.test(n))v=map(String(v));return setAttr.call(this,n,v)};var origFetch=window.fetch;if(origFetch)window.fetch=function(input,init){if(typeof input==="string")input=map(input);else if(input&&typeof input.url==="string"){var next=map(input.url);if(next!==input.url)input=new Request(next,input)}return origFetch.call(this,input,init)};var origOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=map(String(u));return origOpen.apply(this,arguments)};var OrigWS=window.WebSocket;if(OrigWS){var WS=function(u,protos){return protos===undefined?new OrigWS(map(String(u))):new OrigWS(map(String(u)),protos)};WS.prototype=OrigWS.prototype;WS.CONNECTING=OrigWS.CONNECTING;WS.OPEN=OrigWS.OPEN;WS.CLOSING=OrigWS.CLOSING;WS.CLOSED=OrigWS.CLOSED;window.WebSocket=WS}var OrigES=window.EventSource;if(OrigES){var ES=function(u,c){return c===undefined?new OrigES(map(String(u))):new OrigES(map(String(u)),c)};ES.prototype=OrigES.prototype;window.EventSource=ES}["pushState","replaceState"].forEach(function(name){var orig=history[name];history[name]=function(state,title,url){if(typeof url==="string")url=map(url);return orig.call(this,state,title,url)}})})();</script>`;
}

function injectShim(html, port) {
  const shim = proxyShim(port);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (match) => match + shim);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (match) => `${match}<head>${shim}</head>`);
  return shim + html;
}

function decodeBody(body, encoding) {
  const kind = String(encoding || "").toLowerCase();
  if (!kind || kind === "identity") return body;
  if (kind === "gzip") return zlib.gunzipSync(body);
  if (kind === "deflate") return zlib.inflateSync(body);
  if (kind === "br") return zlib.brotliDecompressSync(body);
  return null;
}

function rewriteBody(body, headers, route) {
  const type = String(headers["content-type"] || "");
  const html = /text\/html|application\/xhtml\+xml/i.test(type);
  const css = /text\/css/i.test(type);
  if (!html && !css) return { body, headers };
  const decoded = decodeBody(body, headers["content-encoding"]);
  if (!decoded) return { body, headers };
  let text = decoded.toString("utf8");
  text = rewriteRoots(text, route.port);
  if (html) text = injectShim(text, route.port);
  const nextHeaders = { ...headers };
  delete nextHeaders["content-encoding"];
  delete nextHeaders["content-length"];
  const nextBody = Buffer.from(text);
  nextHeaders["content-length"] = String(nextBody.length);
  return { body: nextBody, headers: nextHeaders };
}

function shouldRewrite(headers) {
  const type = String(headers["content-type"] || "");
  if (!/text\/html|application\/xhtml\+xml|text\/css/i.test(type)) return false;
  if (/text\/event-stream/i.test(type)) return false;
  const length = Number(headers["content-length"] || 0);
  return !length || length <= 1_500_000;
}

async function proxyHttp(req, res, route) {
  const targetHost = await upstreamHost(route.port);
  const targetPath = upstreamPath(req.url || "/", route.port, route.strip);
  const headers = requestHeaders(req, route.port, false, targetHost);
  const proxyReq = http.request(
    {
      host: targetHost,
      port: route.port,
      method: req.method,
      path: targetPath,
      headers,
      agent: false,
    },
    (proxyRes) => {
      proxyReq.setTimeout(0);
      const responseHeaders = copyResponseHeaders(proxyRes.headers);
      if (responseHeaders.location) {
        responseHeaders.location = rewriteLocation(responseHeaders.location, route, req);
      }
      if (responseHeaders["set-cookie"]) {
        const cookies = Array.isArray(responseHeaders["set-cookie"])
          ? responseHeaders["set-cookie"]
          : [responseHeaders["set-cookie"]];
        responseHeaders["set-cookie"] = cookies.map((cookie) => rewriteCookie(cookie, route));
      }
      if (!route.strip || !shouldRewrite(responseHeaders)) {
        res.writeHead(proxyRes.statusCode || 502, responseHeaders);
        proxyRes.pipe(res);
        return;
      }
      const chunks = [];
      let size = 0;
      let overflow = false;
      proxyRes.on("data", (chunk) => {
        size += chunk.length;
        if (overflow) {
          res.write(chunk);
          return;
        }
        if (size > 1_500_000) {
          overflow = true;
          res.writeHead(proxyRes.statusCode || 502, responseHeaders);
          res.write(Buffer.concat(chunks));
          res.write(chunk);
          return;
        }
        chunks.push(chunk);
      });
      proxyRes.on("end", () => {
        try {
          if (overflow) {
            res.end();
            return;
          }
          if (res.writableEnded) return;
          const rewritten = rewriteBody(Buffer.concat(chunks), responseHeaders, route);
          res.writeHead(proxyRes.statusCode || 502, rewritten.headers);
          res.end(rewritten.body);
        } catch (err) {
          if (res.headersSent || res.writableEnded) {
            res.destroy();
            return;
          }
          textPage(res, 502, err.message);
        }
      });
    }
  );
  proxyReq.setTimeout(120_000, () => proxyReq.destroy(new Error("upstream timeout")));
  proxyReq.on("error", (err) => {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    const down = err.code === "ECONNREFUSED" || err.code === "ECONNRESET";
    textPage(
      res,
      502,
      down
        ? `Nothing is accepting connections on ${targetHost}:${route.port} yet.`
        : `Could not reach ${targetHost}:${route.port} (${err.message}).`
    );
  });
  res.on("close", () => {
    if (!res.writableEnded) proxyReq.destroy();
  });
  req.on("error", () => proxyReq.destroy());
  req.pipe(proxyReq);
}

async function proxyUpgrade(req, socket, head) {
  const url = new URL(req.url || "/", "http://localhost");
  const match = url.pathname.match(/^\/p\/([1-9]\d{0,4})(\/.*)?$/);
  const fail = (status, message) => {
    if (!socket.writable) return;
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}\n`);
  };
  if (!match) {
    fail(404, "Not found");
    return;
  }
  const port = Number(match[1]);
  const route = port <= 65535 ? routes.get(port) : null;
  if (!route) {
    fail(404, "Port is not published");
    return;
  }
  const targetHost = await upstreamHost(route.port);
  const proxyReq = http.request({
    host: targetHost,
    port: route.port,
    method: "GET",
    path: upstreamPath(req.url || "/", route.port, route.strip),
    headers: requestHeaders(req, route.port, true, targetHost),
    agent: false,
  });
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    const lines = ["HTTP/1.1 101 Switching Protocols"];
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (item != null) lines.push(`${key}: ${item}`);
      }
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (proxyHead.length) socket.write(proxyHead);
    if (head.length) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
  });
  proxyReq.on("response", (proxyRes) => {
    proxyRes.resume();
    fail(502, "Upstream did not upgrade");
  });
  proxyReq.on("error", () => fail(502, "Upstream unavailable"));
  proxyReq.end();
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    send(res, 200, fs.readFileSync(INDEX_PATH, "utf8"));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/meta") {
    send(res, 200, {
      port: PORT,
      hostname: os.hostname(),
      node: process.version,
      platform: process.platform,
      workspace: WORKSPACE,
      tokenConfigured: Boolean(process.env.CMD_TOKEN),
    });
    return;
  }

  const proxyMatch = url.pathname.match(/^\/p\/([1-9]\d{0,4})(\/.*)?$/);
  if (proxyMatch) {
    const port = Number(proxyMatch[1]);
    if (port > 65535) {
      textPage(res, 404, "Not a port.");
      return;
    }
    const route = routes.get(port);
    if (!route) {
      textPage(res, 404, `Port ${port} is not published. Open the sandbox page and publish it.`);
      return;
    }
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === `/p/${port}`) {
      res.writeHead(308, {
        Location: `/p/${port}/${url.search}`,
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }
    await proxyHttp(req, res, route);
    return;
  }

  if (!url.pathname.startsWith("/api/")) {
    send(res, 404, { error: "Not found" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run") {
    const body = await readBody(req);
    const command = String(body.command || "").trim();
    if (!command) {
      send(res, 400, { error: "Command is empty." });
      return;
    }
    if (command.length > 8000) {
      send(res, 400, { error: "Command is too long." });
      return;
    }
    const cwd = resolveCwd(body.cwd);
    const background = Boolean(body.background);
    const requestedWait = Number(body.timeoutMs);
    const waitMs = Number.isFinite(requestedWait)
      ? Math.min(Math.max(requestedWait, 0), MAX_WAIT_MS)
      : 20_000;
    const job = startJob(command, cwd);
    console.log(`job ${job.id} pid ${job.pid} cwd ${cwd}: ${command}`);
    if (!background && waitMs > 0) await waitJob(job, waitMs);
    send(res, 200, publicJob(job, true));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs") {
    send(res, 200, {
      jobs: [...jobs.values()].map((job) => publicJob(job, false)).reverse(),
    });
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/(\d+)(\/kill)?$/);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) {
      send(res, 404, { error: "No such job." });
      return;
    }
    if (jobMatch[2]) {
      if (req.method !== "POST") {
        send(res, 405, { error: "Use POST." });
        return;
      }
      const killed = killJob(job);
      send(res, 200, { killed, job: publicJob(job, true) });
      return;
    }
    if (req.method === "GET") {
      send(res, 200, publicJob(job, true));
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/probe") {
    const body = await readBody(req);
    const port = clampPort(body.port);
    send(res, 200, await probePort(port));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/scan") {
    const body = await readBody(req);
    const ports = Array.isArray(body.ports) ? body.ports.slice(0, 20) : [];
    const unique = [...new Set(ports.map((port) => clampPort(port)))];
    const results = [];
    for (const port of unique) results.push(await probePort(port));
    send(res, 200, { results });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/listeners") {
    send(res, 200, await listListeners());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/services") {
    const listeners = await jobListeners();
    const open = new Set(listeners.map((row) => row.port));
    const published = [...routes.values()].sort((a, b) => a.port - b.port);
    const listed = [];
    for (const route of published) {
      const online = open.has(route.port) || (await tcpOpen(route.port)) || (await tcpOpen(route.port, "::1"));
      listed.push(routeJson(route, online));
    }
    send(res, 200, { listeners, routes: listed });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/routes") {
    const body = await readBody(req);
    const port = clampPort(body.port);
    const route = publishRoute(port, { label: body.label, strip: body.strip !== false });
    const online = (await tcpOpen(port)) || (await tcpOpen(port, "::1"));
    send(res, 200, routeJson(route, online));
    return;
  }

  const routeMatch = url.pathname.match(/^\/api\/routes\/([1-9]\d{0,4})$/);
  if (routeMatch && req.method === "DELETE") {
    const port = Number(routeMatch[1]);
    if (port > 65535 || !routes.has(port)) {
      send(res, 404, { error: "That port is not published." });
      return;
    }
    routes.delete(port);
    upstreamHosts.delete(port);
    console.log(`unpublished ${publicPath(port)}`);
    send(res, 200, { removed: port });
    return;
  }

  send(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) {
      send(res, err.status || 500, { error: err.message || "Server error" });
    }
  });
});

server.requestTimeout = 120_000;
server.on("upgrade", (req, socket, head) => {
  proxyUpgrade(req, socket, head).catch((err) => {
    console.error(err);
    if (socket.writable) socket.destroy();
  });
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(`command sandbox listening on 0.0.0.0:${PORT}`);
});
