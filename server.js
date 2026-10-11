const http = require("http");
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const os = require("os");
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
let seq = 0;

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

function tcpOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
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

function parseProc(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(1);
  const rows = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || parts[3] !== "0A") continue;
    const [ipHex, portHex] = parts[1].split(":");
    const port = Number.parseInt(portHex, 16);
    let address = ipHex;
    if (ipHex === "00000000") address = "0.0.0.0";
    else if (ipHex.length === 8) {
      address = ipHex
        .match(/../g)
        .reverse()
        .map((byte) => Number.parseInt(byte, 16))
        .join(".");
    } else {
      address = "ipv6";
    }
    rows.push({ address, port });
  }
  return rows;
}

function listListeners() {
  const fromProc = [...parseProc("/proc/net/tcp"), ...parseProc("/proc/net/tcp6")];
  if (fromProc.length || fs.existsSync("/proc/net/tcp")) {
    return { source: "proc", listeners: fromProc };
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

function clampPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error("Port must be an integer from 1 to 65535.");
    error.status = 400;
    throw error;
  }
  return port;
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
server.listen(PORT, "0.0.0.0", () => {
  console.log(`command sandbox listening on 0.0.0.0:${PORT}`);
});
