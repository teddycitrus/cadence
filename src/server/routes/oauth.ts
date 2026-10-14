import express, { Router, type Request } from "express";
import { z } from "zod";
import { OAuthError, OAuthServer, oauthMetadata } from "../../integrations/oauth";
import { identityOf } from "../auth-middleware";
import type { Container } from "../container";

/** Where this server is reachable, for discovery documents (CADENCE_PUBLIC_URL wins). */
export function publicBase(req: Request): string {
  if (process.env.CADENCE_PUBLIC_URL) return process.env.CADENCE_PUBLIC_URL.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.headers.host;
  return `${proto}://${host}`;
}

/** The OAuth endpoints a connector calls without a session: discovery, registration, authorize, token. */
export function publicOAuthRoutes(oauth: OAuthServer): Router {
  const r = Router();
  r.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"], (req, res) => {
    res.json(oauthMetadata(publicBase(req)).authorizationServer);
  });
  r.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => {
    res.json(oauthMetadata(publicBase(req)).protectedResource);
  });
  r.post("/oauth/register", express.json({ limit: "64kb" }), (req, res) => {
    try {
      const c = oauth.register(req.body ?? {});
      res.status(201).json({ client_id: c.id, client_name: c.name, redirect_uris: c.redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] });
    } catch (err) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: err instanceof Error ? err.message : String(err) });
    }
  });
  // The person decides in Cadence itself, where they are signed in.
  r.get("/oauth/authorize", (req, res) => {
    try {
      oauth.validate(req.query as Record<string, unknown>);
    } catch (err) {
      res.status(400).type("text/plain").send(`This sign-in request is not valid: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    res.redirect(302, `/#/oauth?${new URLSearchParams(req.query as Record<string, string>).toString()}`);
  });
  r.post("/oauth/token", express.urlencoded({ extended: false, limit: "64kb" }), express.json({ limit: "64kb" }), (req, res) => {
    try {
      res.set("Cache-Control", "no-store").json(oauth.exchange(req.body ?? {}));
    } catch (err) {
      res.status(400).json({ error: err instanceof OAuthError ? err.code : "invalid_request" });
    }
  });
  return r;
}

/** For the consent page: what is asking, and the person's answer. Needs a signed-in session. */
export function oauthConsentRoutes(oauth: OAuthServer, c: Container): Router {
  const r = Router();
  const Params = z.record(z.string(), z.string().max(2000));
  r.post("/request", (req, res) => {
    const v = oauth.validate(Params.parse(req.body));
    res.json({ clientName: v.client.name, redirectHost: new URL(v.redirectUri).host, scope: v.scope, organization: c.org().name });
  });
  r.post("/decide", (req, res) => {
    const input = z.object({ params: Params, allow: z.boolean() }).parse(req.body);
    res.json({ redirect: input.allow ? oauth.approve(input.params, identityOf(res).memberId) : oauth.deny(input.params) });
  });
  return r;
}
