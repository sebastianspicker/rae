/** Checks whether the configured provider environment exposes sensitive values. */
import { EXIT, RalphError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { CliOptions } from "./types.js";

export function securityPreflight(options: CliOptions, logger: Logger): void {
  if (!options.securityPreflight) {
    logger.event("INFO", "security_preflight=disabled");
    return;
  }
  const patterns = [
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "API_KEY",
    "ACCESS_KEY",
    "PRIVATE_KEY",
    "AWS_",
    "DATABASE_URL",
    "POSTGRES_URL",
    "STRIPE_",
    "GITHUB_",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ];
  const detected = Object.keys(process.env)
    .filter(
      (name) =>
        process.env[name] && patterns.some((pattern) => name.toUpperCase().includes(pattern)),
    )
    .sort();
  if (!detected.length) {
    logger.event("INFO", "security_preflight=clean");
    return;
  }
  logger.event("WARN", `security_preflight=detected vars=${detected.join(",")}`);
  logger.warn(`Security preflight detected sensitive environment variables: ${detected.join(",")}`);
  logger.warn("Use least privilege and unset unneeded secrets for autonomous runs.");
  if (options.securityPreflightFail)
    throw new RalphError(
      `Security preflight blocked run due sensitive environment variables (vars=${detected.join(",")})`,
      EXIT.security,
    );
}
