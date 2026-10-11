const { MAX_COMMAND_LENGTH } = require("../constants");
const jobService = require("../services/job.service");
const { send } = require("../utils/http");

async function run(req, res) {
  const body = req.body || {};
  const command = String(body.command || "").trim();
  if (!command) {
    send(res, 400, { error: "Command is empty." });
    return;
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    send(res, 400, { error: "Command is too long." });
    return;
  }
  const job = await jobService.run({
    command,
    cwd: body.cwd,
    background: Boolean(body.background),
    timeoutMs: body.timeoutMs,
  });
  send(res, 200, job);
}

function list(_req, res) {
  send(res, 200, { jobs: jobService.listJobs() });
}

function get(req, res) {
  const job = jobService.getJob(req.params.id);
  if (!job) {
    send(res, 404, { error: "No such job." });
    return;
  }
  send(res, 200, jobService.present(job, true));
}

function kill(req, res) {
  const job = jobService.getJob(req.params.id);
  if (!job) {
    send(res, 404, { error: "No such job." });
    return;
  }
  const killed = jobService.kill(job);
  send(res, 200, { killed, job: jobService.present(job, true) });
}

module.exports = { run, list, get, kill };
