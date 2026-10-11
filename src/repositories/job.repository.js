const jobs = new Map();
let seq = 0;

function nextId() {
  seq += 1;
  return String(seq);
}

function save(job) {
  jobs.set(job.id, job);
  return job;
}

function get(id) {
  return jobs.get(id) || null;
}

function list() {
  return [...jobs.values()];
}

function remove(id) {
  jobs.delete(id);
}

function running() {
  return list().filter((job) => job.status === "running");
}

module.exports = { nextId, save, get, list, remove, running };
