// Run lifecycle: queue issues opened before auth, mint per-run tokens, boot the
// sandbox, resume pending issues after auth, and resolve run tokens for proxies.

import { getSandbox } from "@cloudflare/sandbox";
import { agentPrompt, runScript } from "./agent";
import { decrypt, encrypt } from "./crypto";
import { base64url } from "./http";
import type { Env, PendingRun, RunContext } from "./types";

const RUN_TOKEN_TTL_SECONDS = 900; // 15 minutes

// A user who opens an issue before authorizing has 24h to complete the browser
// OAuth flow; after that the pending issue expires from KV.
const PENDING_RUN_TTL_SECONDS = 86400;

export async function savePendingRun(env: Env, login: string, run: PendingRun): Promise<void> {
  const key = `pending:${login}:${run.repo}:${run.issueNumber}`;
  await env.USER_TOKENS.put(key, JSON.stringify(run), { expirationTtl: PENDING_RUN_TTL_SECONDS });
}

// Mint a per-run opaque token, persist the run context (short TTL), and start
// the sandbox work in the background. Returns the sandbox id.
export async function launchResolution(
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
export async function resumePendingRuns(
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

// Resolve a per-run token to its decrypted run context, or null if unknown.
export async function getRunContext(env: Env, token: string | null): Promise<RunContext | null> {
  if (!token) return null;
  const stored = await env.RUN_TOKENS.get(`run:${token}`);
  if (!stored) return null;
  try {
    return JSON.parse(await decrypt(env.TOKEN_ENC_KEY, stored)) as RunContext;
  } catch {
    return null;
  }
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
