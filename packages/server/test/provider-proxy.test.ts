import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { providerFetch } from "../src/agent/proxy.js";

test("empty proxy address reads the environment", async () => {
  const names = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const proxy = createServer((_request, response) => response.end("environment proxy"));
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    const address = proxy.address();
    assert.ok(address && typeof address === "object");
    for (const name of names) delete process.env[name];
    process.env.HTTP_PROXY = `http://127.0.0.1:${address.port}`;
    assert.equal(await (await providerFetch({ proxyEnabled: true, proxyUrl: "" })("http://example.invalid/")).text(), "environment proxy");
  } finally {
    for (const name of names) { const value = previous[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});

test("HTTPS uses a CONNECT tunnel through the chosen proxy", async () => {
  let target = "";
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    target = request.url ?? "";
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    const address = proxy.address();
    assert.ok(address && typeof address === "object");
    const request = providerFetch({ proxyEnabled: true, proxyUrl: `http://127.0.0.1:${address.port}` });
    await assert.rejects(request("https://example.invalid/v1"));
    assert.equal(target, "example.invalid:443");
  } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
});

test("provider proxy sends the request through the configured proxy", async () => {
  const seen: Array<{ url?: string; body: string }> = [];
  const proxy = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      seen.push({ url: req.url, body });
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("代理成功");
    });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    const address = proxy.address();
    assert.ok(address && typeof address === "object");
    const request = providerFetch({ proxyEnabled: true, proxyUrl: `http://127.0.0.1:${address.port}` });
    const response = await request("http://example.invalid/v1/chat/completions", { method: "POST", body: "test" });
    assert.equal(await response.text(), "代理成功");
    assert.equal(seen[0]?.url, "http://example.invalid/v1/chat/completions");
    assert.equal(seen[0]?.body, "test");
  } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
});
