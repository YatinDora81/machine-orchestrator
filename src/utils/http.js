const { SECURITY_HEADERS } = require("../constants");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

function send(res, status, body) {
  const json = typeof body !== "string";
  const payload = json ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Content-Type": json ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
    ...SECURITY_HEADERS,
  });
  res.end(payload);
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

module.exports = { escapeHtml, send, textPage };
