const http = require("http");
const zlib = require("zlib");
const config = require("../config");
const { HOP_HEADERS, PROXY_REWRITE_LIMIT, UPSTREAM_HOST_TTL_MS } = require("../constants");
const routes = require("../repositories/route.repository");
const probeService = require("./probe.service");
const { textPage } = require("../utils/http");

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

function hostHeader(host, port) {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

async function upstreamHost(port) {
  const cached = routes.getHost(port);
  if (cached && Date.now() < cached.until) return cached.host;
  if (await probeService.tcpOpen(port, "127.0.0.1")) {
    routes.saveHost(port, { host: "127.0.0.1", until: Date.now() + UPSTREAM_HOST_TTL_MS });
    return "127.0.0.1";
  }
  if (await probeService.tcpOpen(port, "::1")) {
    routes.saveHost(port, { host: "::1", until: Date.now() + UPSTREAM_HOST_TTL_MS });
    return "::1";
  }
  return "127.0.0.1";
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
  let text = rewriteRoots(decoded.toString("utf8"), route.port);
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
  return !length || length <= PROXY_REWRITE_LIMIT;
}

async function proxyHttp(req, res, route) {
  const targetHost = await upstreamHost(route.port);
  const targetPath = upstreamPath(req.originalUrl || req.url || "/", route.port, route.strip);
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
        if (size > PROXY_REWRITE_LIMIT) {
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
  proxyReq.setTimeout(config.requestTimeoutMs, () => proxyReq.destroy(new Error("upstream timeout")));
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

module.exports = { proxyHttp, proxyUpgrade };
