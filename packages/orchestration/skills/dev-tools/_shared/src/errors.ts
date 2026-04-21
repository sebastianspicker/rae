export function badInput(message: string): Error {
  return Object.assign(new Error(message), { code: "E_BAD_INPUT" });
}
