import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

/** 请求级代理：不修改全局 dispatcher，也不共享服务商配置。 */
export function providerFetch(provider: { proxyEnabled?: boolean; proxyUrl?: string }): typeof fetch {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 5)) throw new Error("服务商代理需要 Node.js 24.5 或更高版本");
  const explicit = provider.proxyUrl?.trim();
  const proxyEnv: NodeJS.ProcessEnv = explicit
    ? { HTTP_PROXY: explicit, HTTPS_PROXY: explicit }
    : { http_proxy: process.env.http_proxy, HTTP_PROXY: process.env.HTTP_PROXY, https_proxy: process.env.https_proxy, HTTPS_PROXY: process.env.HTTPS_PROXY, no_proxy: process.env.no_proxy, NO_PROXY: process.env.NO_PROXY };
  if (!proxyEnv.https_proxy && !proxyEnv.HTTPS_PROXY) proxyEnv.HTTPS_PROXY = proxyEnv.http_proxy || proxyEnv.HTTP_PROXY;
  const httpAgent = new HttpAgent({ proxyEnv });
  const httpsAgent = new HttpsAgent({ proxyEnv });
  return async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new TypeError("仅支持 HTTP(S) 模型地址");
    const proxy = target.protocol === "https:" ? proxyEnv.https_proxy || proxyEnv.HTTPS_PROXY || proxyEnv.http_proxy || proxyEnv.HTTP_PROXY : proxyEnv.http_proxy || proxyEnv.HTTP_PROXY;
    if (!proxy) throw new Error("已启用代理，但未设置代理地址或环境代理");
    // Node 的 HTTP agent 不会自动解压响应；要求服务端直接发送未压缩内容。
    const headers = new Headers(request.headers);
    headers.set("accept-encoding", "identity");
    return await new Promise<Response>((resolve, reject) => {
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      const outgoing = send(target, { method: request.method, headers: Object.fromEntries(headers.entries()), agent: target.protocol === "https:" ? httpsAgent : httpAgent, signal: request.signal }, response => {
        const status = response.statusCode ?? 500;
        if (status >= 300 && status < 400) { response.resume(); reject(new Error("代理请求不支持重定向")); return; }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const entry of value) responseHeaders.append(name, entry);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        resolve(new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, ...(response.statusMessage ? { statusText: response.statusMessage } : {}), headers: responseHeaders }));
      });
      outgoing.on("error", reject);
      if (request.body) Readable.fromWeb(request.body as import("node:stream/web").ReadableStream).on("error", reject).pipe(outgoing);
      else outgoing.end();
    });
  };
}
