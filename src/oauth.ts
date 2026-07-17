// GitHub OAuth: one-time browser consent, per-user token stored encrypted.

import { encrypt } from "./crypto";
import { resumePendingRuns } from "./runs";
import type { Env } from "./types";

export function oauthLogin(request: Request, env: Env): Response {
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

export async function oauthCallback(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
