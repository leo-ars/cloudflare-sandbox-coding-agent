// Automated issue-resolution Worker — request router.
//
// Flow:
//   GitHub Action (issues:opened) --HMAC-signed webhook--> POST /webhook
//     -> verify signature
//     -> resolve the triggering user's stored GitHub OAuth token
//     -> spin up an ephemeral Sandbox container
//     -> run Claude Code inside it (async, detached background process)
//     -> Claude reads the issue, edits code, commits, pushes, opens a PR
//
// Secret handling ("outbound worker" property):
//   The sandbox NEVER receives real credentials. It only gets a short-lived,
//   per-run opaque token (RUN_TOKEN). All egress from the sandbox to Anthropic
//   and GitHub is pointed at THIS Worker's /proxy/* endpoints, which validate
//   the RUN_TOKEN and inject the real credential before forwarding upstream.
//
// Module map:
//   types.ts    shared interfaces (Env, RunContext, PendingRun)
//   crypto.ts   HMAC verification + AES-GCM token encryption
//   http.ts     small header / encoding helpers
//   agent.ts    the prompt + bash wrapper that run inside the sandbox
//   runs.ts     run lifecycle: pending queue, token minting, sandbox boot
//   oauth.ts    GitHub OAuth login + callback
//   webhook.ts  signed webhook handler
//   proxies.ts  the three credential-injecting egress proxies

import { oauthCallback, oauthLogin } from "./oauth";
import { proxyAnthropic, proxyGitHubApi, proxyGitHubGit } from "./proxies";
import type { Env } from "./types";
import { webhook } from "./webhook";

// Re-export the Sandbox Durable Object class so the runtime can bind it.
export { Sandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;

    try {
      if (path === "/" || path === "/health") return info(env);
      if (path === "/oauth/login") return oauthLogin(request, env);
      if (path === "/oauth/callback") return oauthCallback(request, env, ctx);
      if (path === "/webhook" && request.method === "POST") return webhook(request, env, ctx);

      // Egress proxies used by the sandbox. Real credentials injected here.
      // Claude Code sends a HEAD/GET connectivity probe to the base URL before
      // real calls; answer it 200 so the client proceeds to /v1/messages.
      if (path === "/proxy/anthropic" || path === "/proxy/anthropic/") {
        return new Response(null, { status: 200 });
      }
      if (path.startsWith("/proxy/anthropic/")) return proxyAnthropic(request, env, "/proxy/anthropic/");
      if (path.startsWith("/proxy/github/")) return proxyGitHubGit(request, env, "/proxy/github/");
      if (path.startsWith("/proxy/gh-api/")) return proxyGitHubApi(request, env, "/proxy/gh-api/");

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("Unhandled error:", err);
      return new Response("Internal error", { status: 500 });
    }
  },
};

function info(env: Env): Response {
  return new Response(
    [
      "Issue Resolver",
      "",
      "One-time setup per developer:",
      `  Visit ${env.PUBLIC_URL}/oauth/login to authorize GitHub access.`,
      "",
      "Then opening an issue triggers an automated Claude Code PR.",
    ].join("\n"),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}
