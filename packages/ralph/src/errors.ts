/** Defines stable Ralph exit codes and typed operational failures. */
export const EXIT = {
  success: 0,
  general: 1,
  prd: 2,
  scope: 3,
  tool: 4,
  lock: 5,
  security: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class RalphError extends Error {
  public constructor(
    message: string,
    public readonly exitCode: ExitCode = EXIT.general,
  ) {
    super(message);
    this.name = "RalphError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
