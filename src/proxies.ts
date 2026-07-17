// Egress proxies. The sandbox points all its outbound traffic here using only
// the per-run RUN_TOKEN; each proxy validates that token and injects the real
// credential before forwarding upstream — so no secret ever enters the sandbox.

import { bearer, forwardHeaders, passthroughRespHeaders } from "./http";
import { getRunContext } from "./runs";
import type { Env } from "./types";

export async function proxyAnthropic(request: Request, env: Env, prefix: string): Promise<Response> {
  const token = request.headers.get("x-api-key") ?? bearer(request.headers.get("authorization"));
  const runCtx = await getRunContext(env, token);
  if (!runCtx) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const rest = url.pathname.slice(prefix.length);
  const target = `https://api.anthropic.com/${rest}${url.search}`;

  const headers = forwardHeaders(request.headers);
  headers.set("x-api-key", env.ANTHROPIC_API_KEY); // real key injected here

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error - duplex is required when streaming a request body
    duplex: "half",
    redirect: "manual",
  });
  return new Response(upstream.body, { status: upstream.status, headers: passthroughRespHeaders(upstream.headers) });
}

export async function proxyGitHubGit(request: Request, env: Env, prefix: string): Promise<Response> {
  // git sends Basic auth; the password is the per-run token.
  const auth = request.headers.get("authorization") ?? "";
  let token: string | null = null;
  if (auth.startsWith("Basic ")) {
    try {
      const [, pass] = atob(auth.slice(6)).split(":");
      token = pass ?? null;
    } catch {
      token = null;
    }
  }
  const runCtx = await getRunContext(env, token);
  if (!runCtx) {
    // git issues its first request unauthenticated and only sends credentials
    // after a 401 that advertises Basic auth. Without this header git gives up.
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="issue-resolver-proxy"' },
    });
  }

  const url = new URL(request.url);
  const rest = url.pathname.slice(prefix.length);
  const target = `https://github.com/${rest}${url.search}`;

  const headers = forwardHeaders(request.headers);
  // Inject the real token as the git Basic-auth password.
  headers.set("authorization", `Basic ${btoa(`x-access-token:${runCtx.githubToken}`)}`);

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error - duplex is required when streaming a request body
    duplex: "half",
    redirect: "manual",
  });
  return new Response(upstream.body, { status: upstream.status, headers: passthroughRespHeaders(upstream.headers) });
}

export async function proxyGitHubApi(request: Request, env: Env, prefix: string): Promise<Response> {
  const runCtx = await getRunContext(env, bearer(request.headers.get("authorization")));
  if (!runCtx) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const rest = url.pathname.slice(prefix.length);
  const target = `https://api.github.com/${rest}${url.search}`;

  const headers = forwardHeaders(request.headers);
  headers.set("authorization", `Bearer ${runCtx.githubToken}`); // real token injected
  headers.set("user-agent", "issue-resolver");
  if (!headers.has("accept")) headers.set("accept", "application/vnd.github+json");

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error - duplex is required when streaming a request body
    duplex: "half",
    redirect: "manual",
  });
  return new Response(upstream.body, { status: upstream.status, headers: passthroughRespHeaders(upstream.headers) });
}
