/**
 * Provides the shared typed input-error factory for tool contract violations.
 */
export function badInput(message: string): Error {
  return Object.assign(new Error(message), { code: "E_BAD_INPUT" });
}
