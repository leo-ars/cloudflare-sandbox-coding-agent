// Small HTTP helpers shared by the egress proxies and run-token minting.

/** URL-safe base64 of raw bytes, without padding. */
export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Extract the token from an Authorization header, tolerating a bare value. */
export function bearer(header: string | null): string | null {
  if (!header) return null;
  return header.startsWith("Bearer ") ? header.slice(7) : header;
}

/** Strip hop-by-hop and inbound auth headers before forwarding upstream. */
export function forwardHeaders(src: Headers): Headers {
  const h = new Headers(src);
  for (const k of ["host", "authorization", "x-api-key", "cookie", "content-length"]) h.delete(k);
  return h;
}

/** Strip encoding/length headers that don't survive re-proxying. */
export function passthroughRespHeaders(src: Headers): Headers {
  const h = new Headers(src);
  for (const k of ["content-encoding", "transfer-encoding", "connection"]) h.delete(k);
  return h;
}
