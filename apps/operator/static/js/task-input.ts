/** Applies the operator start contract to browser text, including multibyte input. */
export function validateTask(task: string): string | null {
  if (!task.trim()) return "Describe the repository change before starting a run.";
  if (new TextEncoder().encode(task).byteLength > 32 * 1024)
    return "Task exceeds 32 KiB. Shorten it before starting the run.";
  return null;
}
