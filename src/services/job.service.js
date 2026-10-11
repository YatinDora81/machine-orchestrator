const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { MAX_OUTPUT, MAX_JOBS, MAX_RUNNING, MAX_WAIT_MS, JOB_PREVIEW_CHARS, KILL_GRACE_MS } = require("../constants");
const jobs = require("../repositories/job.repository");
const { httpError } = require("../utils/http-error");

function append(job, text) {
  job.output += text;
  if (job.output.length > MAX_OUTPUT) {
    job.output = job.output.slice(-MAX_OUTPUT);
    job.truncated = true;
  }
}

function present(job, full) {
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
    output: full ? job.output : job.output.slice(-JOB_PREVIEW_CHARS),
  };
}

function resolveCwd(input) {
  const raw = String(input || "").trim();
  const resolved = raw
    ? path.resolve(raw.startsWith("/") ? raw : path.join(config.workspace, raw))
    : config.workspace;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw httpError(400, `Working directory does not exist: ${resolved}`);
  }
  return resolved;
}

function trim() {
  const finished = jobs.list().filter((job) => job.status !== "running");
  while (jobs.list().length > MAX_JOBS && finished.length) {
    jobs.remove(finished.shift().id);
  }
}

function start(command, cwd) {
  if (jobs.running().length >= MAX_RUNNING) {
    throw httpError(429, `Too many running commands (max ${MAX_RUNNING}). Kill one first.`);
  }

  const job = {
    id: jobs.nextId(),
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

  jobs.save(job);
  trim();
  return job;
}

function wait(job, ms) {
  if (job.status !== "running") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    job.child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function kill(job) {
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
  }, KILL_GRACE_MS);
  return true;
}

function waitMs(requested) {
  const value = Number(requested);
  if (!Number.isFinite(value)) return 20_000;
  return Math.min(Math.max(value, 0), MAX_WAIT_MS);
}

async function run({ command, cwd, background, timeoutMs }) {
  const job = start(command, resolveCwd(cwd));
  console.log(`job ${job.id} pid ${job.pid} cwd ${job.cwd}: ${command}`);
  const waitFor = waitMs(timeoutMs);
  if (!background && waitFor > 0) await wait(job, waitFor);
  return present(job, true);
}

function listJobs() {
  return jobs.list().map((job) => present(job, false)).reverse();
}

function getJob(id) {
  return jobs.get(id);
}

module.exports = { run, listJobs, getJob, present, kill, runningPids: () => jobs.running().map((job) => job.pid).filter(Boolean) };
