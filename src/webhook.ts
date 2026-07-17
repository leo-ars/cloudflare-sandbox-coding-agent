// Webhook: verify signature, resolve the author's token, launch a background
// run, and return 202 — or reply needs_auth when the author hasn't authorized.

import { decrypt, verifyHmac } from "./crypto";
import { launchResolution, savePendingRun } from "./runs";
import type { Env } from "./types";

export async function webhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
