// Automated issue-resolution Worker.
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
//   and GitHub is pointed at THIS Worker's /proxy/* endpoints. The Worker
//   validates the RUN_TOKEN and injects the real credential before forwarding
//   upstream. This is the shipped Sandbox-SDK equivalent of outbound-worker
//   credential injection (see the "Proxy requests to external APIs" guide).

import { getSandbox, type Sandbox as SandboxDO } from "@cloudflare/sandbox";
import { decrypt, encrypt, verifyHmac } from "./crypto";

// Re-export the Sandbox Durable Object class so the runtime can bind it.
export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<SandboxDO>;
  USER_TOKENS: KVNamespace;
  RUN_TOKENS: KVNamespace;
  PUBLIC_URL: string;
  WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  TOKEN_ENC_KEY: string;
}

const RUN_TOKEN_TTL_SECONDS = 900; // 15 minutes

interface RunContext {
  githubToken: string;
  repo: string; // "owner/name"
  login: string;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

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

// ---------------------------------------------------------------------------
// GitHub OAuth: one-time browser consent, per-user token stored encrypted.
// ---------------------------------------------------------------------------
function oauthLogin(request: Request, env: Env): Response {
  const state = crypto.randomUUID();
  // Optional hint (?login=<actor>) forwarded from the "needs_auth" webhook
  // response so GitHub pre-selects the account we expect to authorize.
  const loginHint = new URL(request.url).searchParams.get("login");

  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${env.PUBLIC_URL}/oauth/callback`);
  authUrl.searchParams.set("scope", "repo");
  authUrl.searchParams.set("state", state);
  if (loginHint) authUrl.searchParams.set("login", loginHint);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      // Bind the state to the browser to defend against CSRF on the callback.
      "Set-Cookie": `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    },
  });
}

async function oauthCallback(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("oauth_state="))
    ?.slice("oauth_state=".length);

  if (!code) return new Response("Missing code", { status: 400 });
  if (!state || !cookieState || state !== cookieState) {
    return new Response("Invalid OAuth state", { status: 400 });
  }

  // Exchange the code for an access token.
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${env.PUBLIC_URL}/oauth/callback`,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenJson.access_token) {
    return new Response(`OAuth exchange failed: ${tokenJson.error ?? "unknown"}`, { status: 400 });
  }

  // Identify the user this token belongs to.
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${tokenJson.access_token}`,
      "user-agent": "issue-resolver",
      accept: "application/vnd.github+json",
    },
  });
  const user = (await userRes.json()) as { login?: string };
  if (!user.login) return new Response("Could not resolve GitHub user", { status: 400 });

  // Store the token encrypted at rest, keyed by login.
  const enc = await encrypt(env.TOKEN_ENC_KEY, tokenJson.access_token);
  await env.USER_TOKENS.put(`user:${user.login}`, enc);

  // If they opened issues before authorizing, start working on them right now
  // so they don't have to re-open or file a fresh issue.
  const resumed = await resumePendingRuns(env, ctx, user.login, tokenJson.access_token);
  const resumedMsg =
    resumed > 0
      ? ` I found ${resumed} issue${resumed === 1 ? "" : "s"} you opened earlier and started working on ${
          resumed === 1 ? "it" : "them"
        } now — watch for a pull request shortly.`
      : "";

  return new Response(
    `Authorized as @${user.login}. Automated issue resolution is now enabled for issues you open.${resumedMsg}`,
    {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        // Clear the state cookie.
        "Set-Cookie": "oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Webhook: verify, resolve token, launch background run, return 202.
// ---------------------------------------------------------------------------
async function webhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await request.text();
  const signature = request.headers.get("X-Signature-256");

  if (!(await verifyHmac(env.WEBHOOK_SECRET, raw, signature))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: {
    title?: string;
    body?: string;
    repo?: string;
    issue_number?: number;
    actor?: string;
    default_branch?: string;
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { title, body, repo, issue_number, actor } = payload;
  const defaultBranch = payload.default_branch || "main";
  if (!title || !repo || !issue_number || !actor) {
    return new Response("Missing required fields", { status: 400 });
  }

  // Resolve the triggering user's stored GitHub token.
  const stored = await env.USER_TOKENS.get(`user:${actor}`);
  if (!stored) {
    // The user hasn't authorized yet. Remember this issue so we can pick it up
    // automatically the moment they finish the browser OAuth flow, then tell the
    // Action to post the authorization link (with its own GITHUB_TOKEN).
    console.warn(`No stored token for @${actor}; saving pending run and requesting authorization.`);
    await savePendingRun(env, actor, {
      repo,
      issueNumber: issue_number,
      issueTitle: title,
      issueBody: body ?? "",
      defaultBranch,
    });
    const authUrl = `${env.PUBLIC_URL}/oauth/login?login=${encodeURIComponent(actor)}`;
    return Response.json(
      {
        status: "needs_auth",
        login: actor,
        auth_url: authUrl,
        reason: `@${actor} has not authorized issue-resolver yet.`,
      },
      { status: 200 },
    );
  }
  const githubToken = await decrypt(env.TOKEN_ENC_KEY, stored);

  const sandboxId = await launchResolution(env, ctx, {
    githubToken,
    actor,
    repo,
    issueNumber: issue_number,
    issueTitle: title,
    issueBody: body ?? "",
    defaultBranch,
  });

  return Response.json({ status: "accepted", sandboxId }, { status: 202 });
}

interface PendingRun {
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  defaultBranch: string;
}

// A user who opens an issue before authorizing has 24h to complete the browser
// OAuth flow; after that the pending issue expires from KV.
const PENDING_RUN_TTL_SECONDS = 86400;

async function savePendingRun(env: Env, login: string, run: PendingRun): Promise<void> {
  const key = `pending:${login}:${run.repo}:${run.issueNumber}`;
  await env.USER_TOKENS.put(key, JSON.stringify(run), { expirationTtl: PENDING_RUN_TTL_SECONDS });
}

// Mint a per-run opaque token, persist the run context (short TTL), and start
// the sandbox work in the background. Returns the sandbox id.
async function launchResolution(
  env: Env,
  ctx: ExecutionContext,
  args: { githubToken: string; actor: string } & PendingRun,
): Promise<string> {
  const runToken = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const runCtx: RunContext = { githubToken: args.githubToken, repo: args.repo, login: args.actor };
  await env.RUN_TOKENS.put(`run:${runToken}`, await encrypt(env.TOKEN_ENC_KEY, JSON.stringify(runCtx)), {
    expirationTtl: RUN_TOKEN_TTL_SECONDS,
  });

  const sandboxId = `run-${args.issueNumber}-${runToken.slice(0, 8)}`;
  ctx.waitUntil(
    launchRun(env, {
      sandboxId,
      runToken,
      repo: args.repo,
      issueNumber: args.issueNumber,
      issueTitle: args.issueTitle,
      issueBody: args.issueBody,
      defaultBranch: args.defaultBranch,
    }).catch((err) => console.error(`Run ${sandboxId} failed:`, err)),
  );
  console.log(`Launched resolution ${sandboxId} for ${args.repo}#${args.issueNumber}`);
  return sandboxId;
}

// After a user authorizes, start any issues they opened while unauthorized.
async function resumePendingRuns(
  env: Env,
  ctx: ExecutionContext,
  login: string,
  githubToken: string,
): Promise<number> {
  const { keys } = await env.USER_TOKENS.list({ prefix: `pending:${login}:` });
  let launched = 0;
  for (const key of keys) {
    const raw = await env.USER_TOKENS.get(key.name);
    // Always clear the pending marker so we never double-launch or get stuck.
    await env.USER_TOKENS.delete(key.name);
    if (!raw) continue;
    let pending: PendingRun;
    try {
      pending = JSON.parse(raw) as PendingRun;
    } catch {
      continue;
    }
    await launchResolution(env, ctx, { githubToken, actor: login, ...pending });
    launched++;
  }
  return launched;
}

// ---------------------------------------------------------------------------
// Background run: set up the sandbox and start Claude Code detached.
// ---------------------------------------------------------------------------
async function launchRun(
  env: Env,
  run: {
    sandboxId: string;
    runToken: string;
    repo: string;
    issueNumber: number;
    issueTitle: string;
    issueBody: string;
    defaultBranch: string;
  },
): Promise<void> {
  const sandbox = getSandbox(env.Sandbox, run.sandboxId);

  // Only placeholder/proxy credentials enter the sandbox. No real secrets.
  await sandbox.setEnvVars({
    PROXY_BASE: env.PUBLIC_URL,
    RUN_TOKEN: run.runToken,
    ANTHROPIC_BASE_URL: `${env.PUBLIC_URL}/proxy/anthropic`,
    ANTHROPIC_API_KEY: run.runToken, // swapped for the real key by the proxy
    GITHUB_REPOSITORY: run.repo,
    ISSUE_NUMBER: String(run.issueNumber),
    DEFAULT_BRANCH: run.defaultBranch,
    // Pin models to ones this Anthropic account can access (Claude Code's
    // built-in defaults may not be available on every key).
    ANTHROPIC_MODEL: "claude-sonnet-4-5-20250929",
    ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5-20251001",
    // The container runs as root; Claude Code blocks --dangerously-skip-permissions
    // for root unless it knows it is in a sandbox.
    IS_SANDBOX: "1",
    // Keep Claude Code from making non-essential calls to un-proxied hosts.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  });

  // Issue context for the agent to read.
  await sandbox.writeFile(
    "/workspace/ISSUE.md",
    [
      `# ${run.issueTitle}`,
      "",
      `Repository: ${run.repo}`,
      `Issue number: #${run.issueNumber}`,
      "",
      "## Description",
      "",
      run.issueBody || "(no description provided)",
    ].join("\n"),
  );
  await sandbox.writeFile("/workspace/pr_title.txt", `Fix: ${run.issueTitle}`);
  await sandbox.writeFile("/workspace/PROMPT.txt", agentPrompt(run.issueNumber));
  await sandbox.writeFile("/workspace/run.sh", runScript());
  await sandbox.exec("chmod +x /workspace/run.sh");

  // Detached: the container keeps running Claude Code after this Worker
  // invocation ends. Progress is written to /workspace/run.log.
  await sandbox.startProcess('bash -lc "/workspace/run.sh > /workspace/run.log 2>&1"');
  console.log(`Run ${run.sandboxId} started for ${run.repo}#${run.issueNumber}`);
}

function agentPrompt(issueNumber: number): string {
  return [
    "You are an autonomous software engineer working in the current directory,",
    "which is a freshly cloned Git repository on a new feature branch.",
    "",
    "1. Read the issue context in /workspace/ISSUE.md.",
    "2. Explore the repository to understand the relevant code.",
    `3. Implement the minimal, focused change that resolves issue #${issueNumber}.`,
    "4. Stage and commit your work with a clear, conventional commit message.",
    "",
    "Do not attempt to configure credentials or remotes; that is already handled.",
    "The surrounding wrapper will push your branch and open the Pull Request,",
    "so focus on producing a correct, well-scoped commit.",
  ].join("\n");
}

// Deterministic wrapper: clone via the proxy, run Claude Code, then guarantee
// a branch is pushed and a PR is opened even if the agent stopped at committing.
// It also comments back on the issue with progress and the final result.
function runScript(): string {
  return `#!/bin/bash
set -uo pipefail

GH_API="\${PROXY_BASE}/proxy/gh-api"

# Post a comment on the triggering issue via the gh-api egress proxy.
# The real GitHub token is injected by the Worker; only RUN_TOKEN is used here.
post_comment() {
  jq -n --arg body "$1" '{body:$body}' \\
    | curl -sS -X POST "\${GH_API}/repos/\${GITHUB_REPOSITORY}/issues/\${ISSUE_NUMBER}/comments" \\
        -H "Authorization: Bearer \${RUN_TOKEN}" \\
        -H "Accept: application/vnd.github+json" \\
        -H "Content-Type: application/json" \\
        --data @- > /dev/null || echo "comment post failed"
}

post_comment "🤖 On it — spinning up an isolated sandbox and asking Claude Code to work on this issue. I'll follow up with a pull request."

git config --global user.name "issue-resolver[bot]"
git config --global user.email "issue-resolver[bot]@users.noreply.github.com"

# Route all github.com git traffic through the Worker egress proxy, and supply
# the per-run token as the credential. The real GitHub token is injected by the
# Worker and never exists inside this container.
git config --global url."\${PROXY_BASE}/proxy/github/".insteadOf "https://github.com/"
git config --global credential.helper store
PROXY_HOST=$(printf '%s' "\${PROXY_BASE}" | sed -E 's#^https?://##')
printf 'https://x-access-token:%s@%s\\n' "\${RUN_TOKEN}" "\${PROXY_HOST}" > ~/.git-credentials
chmod 600 ~/.git-credentials

cd /workspace
if ! git clone "https://github.com/\${GITHUB_REPOSITORY}.git" repo; then
  post_comment "❌ I couldn't clone the repository. Please check my access and try again."
  exit 1
fi
cd repo

BRANCH="issue-resolver/issue-\${ISSUE_NUMBER}"
git checkout -b "\${BRANCH}"

# Run Claude Code headlessly. It reads the issue and edits + commits the code.
# Capture its final summary so we can report it back on the issue.
claude -p "$(cat /workspace/PROMPT.txt)" --dangerously-skip-permissions > /workspace/claude_out.txt 2>&1 || echo "claude exited non-zero"
cat /workspace/claude_out.txt
CLAUDE_SUMMARY="$(head -c 3000 /workspace/claude_out.txt)"

# Safety net: ensure everything is committed and pushed.
git add -A
git commit -m "fix: resolve issue #\${ISSUE_NUMBER}" || echo "nothing to commit"

AHEAD=$(git rev-list --count "\${DEFAULT_BRANCH}..\${BRANCH}" 2>/dev/null || echo 0)
if [ "\${AHEAD}" = "0" ]; then
  post_comment "⚠️ Claude Code did not produce any code changes for this issue, so there is nothing to open a PR for.

<details><summary>Claude Code output</summary>

\\\`\\\`\\\`
\${CLAUDE_SUMMARY}
\\\`\\\`\\\`
</details>"
  exit 0
fi

if ! git push -u origin "\${BRANCH}"; then
  post_comment "❌ I made changes but failed to push the branch \\\`\${BRANCH}\\\`."
  exit 1
fi

# Open the PR through the gh-api egress proxy (real token injected by Worker).
PR_TITLE="$(cat /workspace/pr_title.txt)"
PR_BODY="Automated fix for issue #\${ISSUE_NUMBER}, generated by Claude Code.

Closes #\${ISSUE_NUMBER}."
PR_RESP=$(jq -n --arg t "\${PR_TITLE}" --arg h "\${BRANCH}" --arg b "\${DEFAULT_BRANCH}" --arg body "\${PR_BODY}" \\
  '{title:$t, head:$h, base:$b, body:$body}' \\
  | curl -sS -X POST "\${GH_API}/repos/\${GITHUB_REPOSITORY}/pulls" \\
      -H "Authorization: Bearer \${RUN_TOKEN}" \\
      -H "Accept: application/vnd.github+json" \\
      -H "Content-Type: application/json" \\
      --data @-)
PR_URL=$(printf '%s' "\${PR_RESP}" | jq -r '.html_url // empty')

if [ -n "\${PR_URL}" ]; then
  post_comment "✅ I opened a pull request with a proposed fix: \${PR_URL}

**What I changed:**

\${CLAUDE_SUMMARY}"
else
  # A PR may already exist for this branch; surface whatever the API returned.
  ERR=$(printf '%s' "\${PR_RESP}" | jq -r '.errors[0].message // .message // "unknown error"')
  post_comment "⚠️ I pushed the branch \\\`\${BRANCH}\\\` but could not open a pull request: \${ERR}"
fi

echo "done"
`;
}

// ---------------------------------------------------------------------------
// Egress proxies. Validate the per-run token, inject the real credential.
// ---------------------------------------------------------------------------
async function getRunContext(env: Env, token: string | null): Promise<RunContext | null> {
  if (!token) return null;
  const stored = await env.RUN_TOKENS.get(`run:${token}`);
  if (!stored) return null;
  try {
    return JSON.parse(await decrypt(env.TOKEN_ENC_KEY, stored)) as RunContext;
  } catch {
    return null;
  }
}

function bearer(header: string | null): string | null {
  if (!header) return null;
  return header.startsWith("Bearer ") ? header.slice(7) : header;
}

// Strip hop-by-hop and auth headers before forwarding.
function forwardHeaders(src: Headers): Headers {
  const h = new Headers(src);
  for (const k of ["host", "authorization", "x-api-key", "cookie", "content-length"]) h.delete(k);
  return h;
}

async function proxyAnthropic(request: Request, env: Env, prefix: string): Promise<Response> {
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

async function proxyGitHubGit(request: Request, env: Env, prefix: string): Promise<Response> {
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

async function proxyGitHubApi(request: Request, env: Env, prefix: string): Promise<Response> {
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

function passthroughRespHeaders(src: Headers): Headers {
  const h = new Headers(src);
  for (const k of ["content-encoding", "transfer-encoding", "connection"]) h.delete(k);
  return h;
}

// ---------------------------------------------------------------------------
function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
