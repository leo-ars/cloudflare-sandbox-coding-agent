// Shared types for the issue-resolution Worker.

import type { Sandbox as SandboxDO } from "@cloudflare/sandbox";

export interface Env {
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

// Per-run context, encrypted into RUN_TOKENS[run:<runToken>] and read back by
// the egress proxies to inject the right credential for that run.
export interface RunContext {
  githubToken: string;
  repo: string; // "owner/name"
  login: string;
}

// An issue queued by a user who has not authorized yet. Stored as plain JSON
// (no secrets) in USER_TOKENS[pending:<login>:<repo>:<issueNumber>] until the
// user finishes the OAuth flow, then resumed automatically.
export interface PendingRun {
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  defaultBranch: string;
}
