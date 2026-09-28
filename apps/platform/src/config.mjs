/** Purpose: load and validate the experimental platform configuration. */
import fs from "node:fs/promises";
import net from "node:net";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const configSchema = z.object({
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.coerce.number().int().min(1).max(65535).default(8080),
      publicBaseUrl: z.url().optional(),
    })
    .default({}),
  database: z.object({ url: z.string().min(1) }),
  oidc: z
    .object({
      issuer: z.url(),
      audience: z.string().min(1),
      jwksUrl: z.url(),
      tokenType: z.string().min(1).default("at+jwt"),
      algorithms: z
        .array(z.enum(["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"]))
        .min(1)
        .default(["RS256"]),
    })
    .optional(),
  storage: z
    .object({
      bucket: z.string().min(1),
      region: z.string().min(1),
      endpoint: z.url().optional(),
      forcePathStyle: z.boolean().default(false),
    })
    .optional(),
  platform: z
    .object({
      development: z.boolean().default(false),
      allowInsecureAuth: z.boolean().default(false),
      allowInsecureHttp: z.boolean().default(false),
      leaseSeconds: z.coerce.number().int().min(60).max(60).default(60),
      heartbeatSeconds: z.coerce.number().int().min(20).max(20).default(20),
    })
    .default({}),
});

/** Classifies hostnames for configuration policy without performing DNS lookups. */
export function classifyHost(hostname) {
  const host = String(hostname)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  const privateName =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal");
  const privateV4 =
    net.isIPv4(host) &&
    (/^10\./.test(host) ||
      /^127\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host));
  const privateV6 =
    net.isIPv6(host) &&
    (host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb"));
  return privateName || privateV4 || privateV6 ? "private" : "public";
}

/** Identifies bind addresses that cannot resolve to a non-loopback interface. */
export function isLiteralLoopbackHost(hostname) {
  const host = String(hostname)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return host === "127.0.0.1" || host === "::1";
}

/** Rejects OIDC endpoints that could redirect production trust to a private host. */
export function assertPublicHttpsUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error(`${label} must be a credential-free HTTPS URL without query or fragment`);
  if (classifyHost(url.hostname) === "private")
    throw new Error(`${label} must not target a private or loopback address`);
}

function assertInsecureConfigurationIsDevelopment(platform) {
  if ((platform.allowInsecureAuth || platform.allowInsecureHttp) && !platform.development) {
    throw new Error("insecure authentication or HTTP requires platform.development=true");
  }
}

function assertInsecureConfigurationIsLoopback(config) {
  if (!config.platform.allowInsecureAuth && !config.platform.allowInsecureHttp) return;
  if (!isLiteralLoopbackHost(config.server.host))
    throw new Error("insecure authentication or HTTP requires a literal loopback server.host");
  if (!config.server.publicBaseUrl)
    throw new Error("insecure authentication or HTTP requires server.publicBaseUrl");
  const publicUrl = new URL(config.server.publicBaseUrl);
  if (
    !["http:", "https:"].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new Error(
      "insecure authentication or HTTP requires a credential-free HTTP(S) origin",
    );
  }
  if (!isLiteralLoopbackHost(publicUrl.hostname))
    throw new Error(
      "insecure authentication or HTTP requires a literal loopback server.publicBaseUrl",
    );
}

function assertConfigurationTransport(config) {
  const publicUrl = config.server.publicBaseUrl ? new URL(config.server.publicBaseUrl) : null;
  if (!config.platform.allowInsecureHttp && publicUrl?.protocol !== "https:") {
    throw new Error("server.publicBaseUrl must use HTTPS unless platform.allowInsecureHttp=true");
  }
  if (config.oidc && !config.platform.allowInsecureHttp) {
    assertPublicHttpsUrl(config.oidc.issuer, "OIDC issuer");
    assertPublicHttpsUrl(config.oidc.jwksUrl, "OIDC JWKS URL");
  }
}

export async function loadConfig(path = process.env.RAE_PLATFORM_CONFIG) {
  if (!path) throw new Error("RAE_PLATFORM_CONFIG must point to a TOML configuration file");
  const parsed = configSchema.parse(parseToml(await fs.readFile(path, "utf8")));
  if (!parsed.oidc && !parsed.platform.allowInsecureAuth) {
    throw new Error(
      "OIDC configuration is required unless platform.allowInsecureAuth=true for local experiments",
    );
  }
  assertInsecureConfigurationIsDevelopment(parsed.platform);
  assertInsecureConfigurationIsLoopback(parsed);
  assertConfigurationTransport(parsed);
  return parsed;
}

export { configSchema };
