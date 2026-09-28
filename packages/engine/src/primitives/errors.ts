/**
 * Shared error factories for pipeline scripts.
 */

export interface CodedError extends Error {
  code: string;
  outerCode?: string;
}

export function badInput(message: string): CodedError {
  const err = new Error(message) as CodedError;
  err.code = "E_BAD_INPUT";
  return err;
}

export function badTrace(message: string): CodedError {
  const err = new Error(message) as CodedError;
  err.code = "E_BAD_TRACE";
  return err;
}

/**
 * Create a tool-specific error with code E_<TOOL_KEY>_<SUFFIX>.
 * @param {string} toolName - Tool name (hyphens become underscores, uppercased)
 * @param {string} suffix - Error suffix (must be UPPER_SNAKE_CASE, e.g., TIMEOUT, MISSING)
 * @param {string} message - Human-readable error message
 */
export function toolError(toolName: string, suffix: string, message: string): CodedError {
  const key = toolName.toUpperCase().replace(/-/g, "_");
  const err = new Error(message) as CodedError;
  err.code = `E_${key}_${suffix}`;
  return err;
}
