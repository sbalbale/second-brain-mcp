import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config.js";

export interface AuthInfo {
  token?: string;
  oauth?: {
    sub?: string;
    aud?: string | string[];
  };
  cloudflareAccess?: {
    audience: string;
    issuer: string;
  };
}

/**
 * Build Express middleware that enforces:
 *   1. A static bearer token (Authorization: Bearer <AUTH_TOKEN>), if set.
 *   2. An OAuth JWT (Authorization: Bearer <JWT>), if OAUTH_ISSUER is set.
 *   3. A Cloudflare Access JWT (Cf-Access-Jwt-Assertion), if CF_ACCESS_AUD is set.
 *
 * If both AUTH_TOKEN and OAuth are configured, the Authorization header is checked
 * against both (OAuth first).
 */
export function buildAuthMiddleware(config: Config) {
  const cfJwks = config.CF_ACCESS_TEAM_DOMAIN
    ? createRemoteJWKSet(
        new URL(`https://${config.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
      )
    : null;

  const oauthJwks = config.OAUTH_ISSUER
    ? createRemoteJWKSet(
        new URL(".well-known/jwks.json", config.OAUTH_ISSUER),
      )
    : null;

  return async function authMiddleware(req: Request & { auth?: AuthInfo }, res: Response, next: NextFunction) {
    const authInfo: AuthInfo = {};
    const requirements: { bearer?: boolean; cloudflare?: boolean } = {};
    const results: { bearer?: boolean; cloudflare?: boolean } = {};

    // Determine what is required based on config
    if (config.AUTH_TOKEN || (config.OAUTH_ISSUER && oauthJwks)) {
      requirements.bearer = true;
    }
    if (config.CF_ACCESS_AUD && cfJwks && config.CF_ACCESS_TEAM_DOMAIN) {
      requirements.cloudflare = true;
    }

    // 1. Check Authorization header (Static Bearer or OAuth JWT)
    if (requirements.bearer) {
      const hdr = req.header("authorization") ?? "";
      const match = hdr.match(/^Bearer\s+(.+)$/i);
      const token = match?.[1];

      if (token) {
        // Try OAuth first if configured
        if (config.OAUTH_ISSUER && config.OAUTH_AUDIENCE && oauthJwks) {
          try {
            const { payload } = await jwtVerify(token, oauthJwks, {
              audience: config.OAUTH_AUDIENCE,
              issuer: config.OAUTH_ISSUER,
            });
            authInfo.oauth = {
              sub: payload.sub,
              aud: payload.aud,
            };
            results.bearer = true;
          } catch (err) {
            // Log error but don't fail yet, might have static token fallback
            console.error(`OAuth verification failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Try static token if not already authenticated by OAuth
        if (!results.bearer && config.AUTH_TOKEN) {
          if (timingSafeEqual(token, config.AUTH_TOKEN)) {
            authInfo.token = token;
            results.bearer = true;
          }
        }
      }
    }

    // 2. Check Cloudflare Access JWT
    if (requirements.cloudflare) {
      const token = req.header("cf-access-jwt-assertion") ?? "";
      if (token) {
        try {
          await jwtVerify(token, cfJwks!, {
            audience: config.CF_ACCESS_AUD!,
            issuer: `https://${config.CF_ACCESS_TEAM_DOMAIN}`,
          });
          authInfo.cloudflareAccess = {
            audience: config.CF_ACCESS_AUD!,
            issuer: `https://${config.CF_ACCESS_TEAM_DOMAIN}!`,
          };
          results.cloudflare = true;
        } catch (err) {
          console.error(`Cloudflare Access verification failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Final Validation:
    // If a method is configured, it MUST be present and valid.
    // This supports AND logic when both headers are expected.
    if (requirements.bearer && !results.bearer) {
      res.status(401).json({ error: "Invalid or missing Bearer/OAuth token" });
      return;
    }
    if (requirements.cloudflare && !results.cloudflare) {
      res.status(401).json({ error: "Invalid or missing Cloudflare Access JWT" });
      return;
    }

    // Attach auth info to request for MCP transport to use
    req.auth = authInfo;
    next();
  };
}

export function assertAuthConfigured(config: Config): void {
  const loopbackBind = config.HOST === "127.0.0.1" || config.HOST === "::1" || config.HOST === "localhost";
  const hasAuth = Boolean(config.AUTH_TOKEN) || Boolean(config.CF_ACCESS_AUD) || Boolean(config.OAUTH_ISSUER);
  if (!hasAuth && !loopbackBind) {
    throw new Error(
      `Refusing to start: HOST=${config.HOST} is non-loopback but no AUTH_TOKEN, OAUTH_ISSUER, or CF_ACCESS_AUD is set. ` +
        `Set at least one (both recommended) or bind to 127.0.0.1.`,
    );
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
