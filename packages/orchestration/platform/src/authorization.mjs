/** Purpose: define the dependency-free hosted authorization contract. */
export const PLATFORM_SCOPES = Object.freeze([
  "rae.run.submit",
  "rae.run.read",
  "rae.run.signal",
  "rae.run.cancel",
  "rae.policy.write",
  "rae.work.claim",
  "rae.work.report",
]);

export function authorizedProjects(principal) {
  const projects = principal.claims?.projects || principal.claims?.project_ids || [];
  if (!Array.isArray(projects) || projects.some((value) => typeof value !== "string" || !value)) {
    throw Object.assign(new Error("token project membership must be an array of strings"), {
      statusCode: 403,
    });
  }
  return [...new Set(projects)];
}

export function requireScope(principal, scope) {
  if (!principal.scopes.has(scope))
    throw Object.assign(new Error(`missing required scope: ${scope}`), { statusCode: 403 });
}

export function requireProject(principal, projectId) {
  const projects = authorizedProjects(principal);
  if (!projects.includes(projectId) && !projects.includes("*"))
    throw Object.assign(new Error("principal is not authorized for this project"), {
      statusCode: 403,
    });
}

export function requireWorkerIdentity(principal, workerId) {
  if (principal.sub !== workerId)
    throw Object.assign(new Error("worker identity must match token subject"), { statusCode: 403 });
}
