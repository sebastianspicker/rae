/** Purpose: validate OIDC bearer tokens and enforce per-route scopes. */
import { createRemoteJWKSet, jwtVerify } from "jose";
import { PLATFORM_SCOPES } from "./authorization.mjs";
export {
  authorizedProjects,
  PLATFORM_SCOPES,
  requireProject,
  requireScope,
  requireWorkerIdentity,
} from "./authorization.mjs";

function tokenScopes(payload) {
  return new Set([
    ...(typeof payload.scope === "string" ? payload.scope.split(/\s+/) : []),
    ...(Array.isArray(payload.scp) ? payload.scp : []),
  ]);
}

export function createAuthenticator(config) {
  if (!config.oidc) {
    return async () => ({
      sub: "local-experiment",
      scopes: new Set(PLATFORM_SCOPES),
      claims: { projects: ["*"] },
    });
  }
  const jwks = createRemoteJWKSet(new URL(config.oidc.jwksUrl));
  return async (authorization) => {
    if (!authorization?.startsWith("Bearer "))
      throw Object.assign(new Error("missing bearer token"), { statusCode: 401 });
    try {
      const { payload } = await jwtVerify(authorization.slice(7), jwks, {
        issuer: config.oidc.issuer,
        audience: config.oidc.audience,
        algorithms: config.oidc.algorithms,
        typ: config.oidc.tokenType,
      });
      const now = Math.floor(Date.now() / 1000);
      if (
        typeof payload.sub !== "string" ||
        typeof payload.exp !== "number" ||
        payload.exp <= now ||
        typeof payload.iat !== "number" ||
        payload.iat > now + 60 ||
        now - payload.iat > 3600
      )
        throw Object.assign(
          new Error("token subject, bounded iat, and unexpired exp claims are required"),
          { statusCode: 401 },
        );
      return { sub: payload.sub, scopes: tokenScopes(payload), claims: payload };
    } catch (error) {
      throw Object.assign(new Error("invalid bearer token"), {
        statusCode: error.statusCode || 401,
      });
    }
  };
}
