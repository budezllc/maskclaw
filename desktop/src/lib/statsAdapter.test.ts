import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptStats, findTrackStats, routeTargetAliases, trackStatsByRoute } from "./statsAdapter";

const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "stats-snapshot.json"),
    "utf8",
  ),
) as unknown;

describe("adaptStats", () => {
  it("maps a /v1/stats fixture onto the dashboard view model", () => {
    const view = adaptStats(fixture);
    expect(view.totalRequests).toBe(12);
    expect(view.totalErrors).toBe(1);
    expect(view.classifierRequests).toBe(10);
    expect(view.classifierErrors).toBe(0);
    expect(view.routingOverhead).toEqual({ count: 10, sumMs: 45.5, avgMs: 4.55 });
    expect(view.routingFallbacks).toEqual({ count: 1 });
    expect(view.totalTokens.prompt_tokens).toBe(0);
    expect(view.byModel.find((m) => m.id === "switchyard")?.avgLatencyMs).toBe(21.25);
    expect(view.stageRouter.present).toBe(true);
    const smart = view.byModel.find((m) => m.id === "switchyard");
    expect(smart?.calls).toBe(10);
    expect(smart?.tokens.prompt_tokens).toBe(1000);
    expect(smart?.tokens.cacheable_prompt_tokens).toBe(800);
    expect(smart?.tokens.reasoning_tokens).toBe(40);
    expect(smart?.latencySamples).toEqual([12.5, 30]);
    expect(view.byClassifier[0]?.id).toBe("unsloth/gemma-4-E4B-it-GGUF");
  });

  it("tolerates an empty object", () => {
    const view = adaptStats({});
    expect(view.totalRequests).toBe(0);
    expect(view.byModel).toEqual([]);
    expect(view.stageRouter.present).toBe(false);
  });

  it("maps the live /v1/stats shape onto track rows", () => {
    const live = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "stats-live.json"),
        "utf8",
      ),
    ) as unknown;
    const view = adaptStats(live);
    expect(view.totalRequests).toBe(2);
    expect(view.classifierRequests).toBe(2);
    expect(view.classifierErrors).toBe(2);
    expect(view.byModel[0]?.id).toBe("MiniMax-M3");
    expect(view.byModel[0]?.calls).toBe(2);
    expect(view.byModel[0]?.tokens.prompt_tokens).toBe(8707);

    const aliases = routeTargetAliases(`
[targets.strong]
id = "MiniMax-M3"
[targets.weak]
id = "unsloth/gemma-4-E4B-it-GGUF"
[routes.smart]
id = "switchyard"
strong_target = "strong"
weak_target = "weak"
[routes.minimax]
id = "minimax-m3"
target = "strong"
[routes.local]
id = "unsloth-local"
target = "weak"
`);
    expect(findTrackStats("minimax-m3", view, aliases["minimax-m3"])?.calls).toBe(2);
    expect(findTrackStats("switchyard", view, aliases["switchyard"])?.calls).toBe(2);
    expect(findTrackStats("unsloth-local", view, aliases["unsloth-local"])?.errors).toBe(2);
  });

  it("assigns leftover local stats to the unmatched local track", () => {
    const stats = adaptStats({
      by_model: { "gemma-4-e4b-it": { calls: 1044, errors: 0, latency_ms: [1700] } },
    });
    const byRoute = trackStatsByRoute(["maskclaw", "lmstudio-local"], stats);
    expect(byRoute["lmstudio-local"]?.calls).toBe(1044);
    expect(byRoute["lmstudio-local"]?.avgLatencyMs).toBe(1700);
    expect(byRoute.maskclaw).toBeUndefined();
  });
});
