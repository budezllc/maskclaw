import { describe, expect, it } from "vitest";
import { isMaskclawFlavor } from "./engineFlavor";
import { MASKCLAW_NAV_ITEMS } from "./maskclawNav";
import { isTauriRuntime, previewInvoke, previewSnapshot } from "./browserPreview";

describe("browser preview", () => {
  it("is off when Tauri internals are present", () => {
    expect(isTauriRuntime({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(isTauriRuntime({})).toBe(false);
    expect(isTauriRuntime()).toBe(false);
  });

  it("serves a MaskClaw snapshot with no BOX nav", () => {
    const snap = previewSnapshot();
    expect(isMaskclawFlavor(snap.engine_flavor)).toBe(true);
    expect(snap.listen_url).toBe("http://127.0.0.1:4000");
    expect(MASKCLAW_NAV_ITEMS.map((item) => item.label)).not.toContain("BOX");
  });

  it("answers engine poll commands", async () => {
    const stats = (await previewInvoke("fetch_stats")) as { total_requests: number };
    expect(stats.total_requests).toBe(1216);
    const models = (await previewInvoke("fetch_models")) as { data: { id: string }[] };
    expect(models.data.map((row) => row.id)).toEqual(["lmstudio-local", "maskclaw", "minimax-m3"]);
  });
});
