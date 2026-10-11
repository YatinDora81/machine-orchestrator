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

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

module.exports = {
  HOP_HEADERS,
  SECURITY_HEADERS,
  MAX_OUTPUT: 300_000,
  MAX_JOBS: 40,
  MAX_RUNNING: 8,
  MAX_WAIT_MS: 55_000,
  MAX_COMMAND_LENGTH: 8000,
  JOB_PREVIEW_CHARS: 1200,
  LABEL_MAX: 80,
  PROXY_REWRITE_LIMIT: 1_500_000,
  UPSTREAM_HOST_TTL_MS: 4000,
  KILL_GRACE_MS: 1500,
  TCP_LISTEN_STATE: "0A",
};
