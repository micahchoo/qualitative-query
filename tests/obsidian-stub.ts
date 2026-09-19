export async function requestUrl(): Promise<never> { throw new Error("requestUrl is unavailable in unit tests"); }
export function parseYaml(value: string): Record<string, unknown> { return Object.fromEntries(value.split("\n").flatMap((line) => { const match = line.match(/^([\w-]+):\s*(.*)$/); return match ? [[match[1], match[2]]] : []; })); }
export class Modal {}
export class Notice {}
export class Setting {}
export class TFile { constructor(public path: string) {} }
