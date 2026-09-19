/** Narrow untrusted JSON and messages before reading their fields. */
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!record(value)) throw new Error("Expected a JSON object.");
  return value;
}
export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
