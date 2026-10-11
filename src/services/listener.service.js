const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const config = require("../config");
const { TCP_LISTEN_STATE } = require("../constants");
const jobService = require("./job.service");

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
    if (parts.length < 10 || parts[3] !== TCP_LISTEN_STATE) continue;
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

function dedupe(rows) {
  const byPort = new Map();
  for (const row of rows) {
    if (!row.port || row.port < 1 || row.port > 65535) continue;
    if (!byPort.has(row.port)) byPort.set(row.port, { address: row.address, port: row.port });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

async function jobListeners() {
  const roots = jobService.runningPids();
  if (!roots.length) return [];
  const pids = descendantPids(roots, await processTable());
  if (!pids.length) return [];
  const rows = fs.existsSync("/proc/net/tcp")
    ? listenersFromProc(pids)
    : await listenersFromLsof(pids);
  return dedupe(rows).filter((row) => row.port !== config.port);
}

function listAll() {
  if (fs.existsSync("/proc/net/tcp")) {
    return {
      source: "proc",
      listeners: dedupe([...parseProc("/proc/net/tcp"), ...parseProc("/proc/net/tcp6")]),
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

module.exports = { jobListeners, listAll };
