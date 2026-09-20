import { expect, it, vi } from "vitest";
import { cooperative } from "../src/cooperative";

it("finishes an early question before the whole burst of scans completes", async () => {
  vi.useFakeTimers();
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => ++clock);
  const events: string[] = [];
  try {
    const runs = Array.from({ length: 20 }, (_, i) => cooperative((function* () {
      for (let step = 0; step < 100; step++) yield;
      events.push(`scan${i}`);
    })()).then(() => cooperative((function* () {
      yield;
      events.push(`finish${i}`);
    })(), undefined, true)));
    await vi.runAllTimersAsync();
    await Promise.all(runs);
    expect(events.indexOf("finish0")).toBeLessThan(events.indexOf("scan19"));
    expect(events.filter(value => value.startsWith("finish"))).toHaveLength(20);
  } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
});
