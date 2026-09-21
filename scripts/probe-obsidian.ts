/** Node stand-in for the Obsidian module. The probe needs `requestUrl` and nothing else. */
export async function requestUrl(options: { url: string; method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; json: unknown }> {
  const response = await fetch(options.url, { method: options.method, headers: options.headers, body: options.body });
  const text = await response.text();
  let json: unknown = {};
  try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 400) }; }
  return { status: response.status, json };
}
