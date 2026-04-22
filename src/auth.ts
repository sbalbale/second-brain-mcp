import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config.js";

export interface AuthInfo {
  token?: string;
  cloudflareAccess?: {
    audience: string;
    issuer: string;
  };
}

/**
 * Build Express middleware that enforces:
 *   1. A static bearer token (Authorization: Bearer <AUTH_TOKEN>), if set.
 *   2. A Cloudflare Access JWT (Cf-Access-Jwt-Assertion), if CF_ACCESS_AUD is set.
 *
 * Either or both may be enabled. If neither is configured the server will
 * refuse to start for any non-loopback bind to avoid accidentally exposing
 * an unauthenticated vault to the internet.
 */
export function buildAuthMiddleware(config: Config) {
  const jwks = config.CF_ACCESS_TEAM_DOMAIN
    ? createRemoteJWKSet(
        new URL(`https://${config.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
      )
    : null;

  return async function authMiddleware(req: Request & { auth?: AuthInfo }, res: Response, next: NextFunction) {
    const authInfo: AuthInfo = {};

    // Bearer token (required when configured).
    if (config.AUTH_TOKEN) {
      const hdr = req.header("authorization") ?? "";
      const match = hdr.match(/^Bearer\s+(.+)$/i);
      if (!match || !timingSafeEqual(match[1] ?? "", config.AUTH_TOKEN)) {
        res.status(401).json({ error: "invalid or missing bearer token" });
        return;
      }
      authInfo.token = match[1];
    }

    // Cloudflare Access JWT (required when CF_ACCESS_AUD is set).
    if (config.CF_ACCESS_AUD && jwks && config.CF_ACCESS_TEAM_DOMAIN) {
      const token = req.header("cf-access-jwt-assertion") ?? "";
      if (!token) {
        res.status(401).json({ error: "missing Cf-Access-Jwt-Assertion header" });
        return;
      }
      try {
        await jwtVerify(token, jwks, {
          audience: config.CF_ACCESS_AUD,
          issuer: `https://${config.CF_ACCESS_TEAM_DOMAIN}`,
        });
        authInfo.cloudflareAccess = {
          audience: config.CF_ACCESS_AUD,
          issuer: `https://${config.CF_ACCESS_TEAM_DOMAIN}`,
        };
      } catch (err) {
        res.status(401).json({
          error: "Cloudflare Access JWT verification failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }

    // Attach auth info to request for MCP transport to use
    req.auth = authInfo;
    next();
  };
}

export function assertAuthConfigured(config: Config): void {
  const loopbackBind = config.HOST === "127.0.0.1" || config.HOST === "::1" || config.HOST === "localhost";
  const hasAuth = Boolean(config.AUTH_TOKEN) || Boolean(config.CF_ACCESS_AUD);
  if (!hasAuth && !loopbackBind) {
    throw new Error(
      `Refusing to start: HOST=${config.HOST} is non-loopback but no AUTH_TOKEN or CF_ACCESS_AUD is set. ` +
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
