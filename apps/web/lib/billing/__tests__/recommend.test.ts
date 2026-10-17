import { describe, expect, it } from "vitest";
import {
  estimateMonthlyCredits,
  presetsForUseCases,
  recommendPlan,
  recommendReasons,
  weeklyAlternative,
  USE_CASE_PRESETS,
  type CostProfile,
  type FinderPlan,
  type FinderSelections,
} from "../recommend";

const COSTS: CostProfile = { filterCost: 6, posterCost: 12 };

const PLANS: FinderPlan[] = [
  { id: "ws", slug: "weekly-starter", name: "Starter", type: "weekly_trial", creditsGrant: 500, priceCents: 500, checkoutReady: true },
  { id: "wp", slug: "weekly-plus", name: "Plus", type: "weekly_trial", creditsGrant: 1000, priceCents: 1000, checkoutReady: true },
  { id: "c", slug: "monthly-creator", name: "Creator", type: "monthly", creditsGrant: 2000, priceCents: 2000, checkoutReady: true },
  { id: "p", slug: "monthly-pro", name: "Pro", type: "monthly", creditsGrant: 3000, priceCents: 3000, checkoutReady: true },
  { id: "s", slug: "monthly-studio", name: "Studio", type: "monthly", creditsGrant: 5500, priceCents: 5000, checkoutReady: true },
  { id: "a", slug: "monthly-agency", name: "Agency", type: "monthly", creditsGrant: 12000, priceCents: 10000, checkoutReady: true },
];

function sel(over: Partial<FinderSelections> = {}): FinderSelections {
  return { useCases: ["social"], filters: 60, posters: 10, capabilities: [], ...over };
}

describe("presetsForUseCases", () => {
  it("returns the max of each slider across selected use cases", () => {
    expect(presetsForUseCases(["posters"])).toEqual({ filters: 15, posters: 40 });
    const merged = presetsForUseCases(["headshots", "posters"]);
    expect(merged.filters).toBe(Math.max(USE_CASE_PRESETS.headshots.filters, USE_CASE_PRESETS.posters.filters));
    expect(merged.posters).toBe(USE_CASE_PRESETS.posters.posters);
  });

  it("returns zero volumes for an empty selection", () => {
    expect(presetsForUseCases([])).toEqual({ filters: 0, posters: 0 });
  });
});

describe("estimateMonthlyCredits", () => {
  it("prices filters and posters at their own costs", () => {
    expect(estimateMonthlyCredits({ filters: 60, posters: 10 }, COSTS)).toBe(480);
    expect(estimateMonthlyCredits({ filters: 0, posters: 0 }, COSTS)).toBe(0);
    expect(estimateMonthlyCredits({ filters: -10, posters: -5 }, COSTS)).toBe(0);
  });
});

describe("recommendPlan", () => {
  it("returns null with no plans", () => {
    expect(recommendPlan(sel(), [], COSTS)).toBeNull();
  });

  it("picks the smallest covering tier", () => {
    const rec = recommendPlan(sel({ filters: 60, posters: 10 }), PLANS, COSTS);
    expect(rec?.plan.name).toBe("Creator"); // 480 ≤ 2000
    expect(rec?.kind).toBe("subscription");
    expect(rec?.driver).toBe("volume");
  });

  it("scales up with volume", () => {
    const rec = recommendPlan(sel({ filters: 500, posters: 100 }), PLANS, COSTS);
    expect(rec?.plan.name).toBe("Studio"); // 500×6 + 100×12 = 4,200 → Studio (5,500)
  });

  it("caps at the largest plan and reports over-capacity usage", () => {
    const rec = recommendPlan(sel({ filters: 3000, posters: 0 }), PLANS, COSTS);
    expect(rec?.plan.name).toBe("Agency"); // 18,000 > 12,000
    expect(rec?.usageRatio).toBeGreaterThan(1);
  });

  it("returns the smallest plan for zero usage", () => {
    const rec = recommendPlan(sel({ filters: 0, posters: 0 }), PLANS, COSTS);
    expect(rec?.plan.name).toBe("Creator");
  });

  it("rate capability binds to at least Studio", () => {
    const rec = recommendPlan(
      sel({ filters: 10, posters: 0, capabilities: ["rate"] }),
      PLANS,
      COSTS
    );
    expect(rec?.plan.slug).toBe("monthly-studio");
    expect(rec?.driver).toBe("capability");
    expect(rec?.capability).toBe("rate");
  });

  it("rate capability keeps the higher volume tier when usage is larger", () => {
    const rec = recommendPlan(
      sel({ filters: 3000, posters: 0, capabilities: ["rate"] }),
      PLANS,
      COSTS
    );
    expect(rec?.plan.name).toBe("Agency");
    expect(rec?.driver).toBe("volume");
  });

  it("weekly capability routes to the smallest covering pass", () => {
    const rec = recommendPlan(
      sel({ filters: 30, posters: 5, capabilities: ["weekly"] }),
      PLANS,
      COSTS
    );
    expect(rec?.kind).toBe("weekly");
    expect(rec?.plan.name).toBe("Starter"); // 30*6+5*12=240 ≤ 500
  });

  it("weekly capability falls back to the largest pass", () => {
    const rec = recommendPlan(
      sel({ filters: 300, posters: 0, capabilities: ["weekly"] }),
      PLANS,
      COSTS
    );
    expect(rec?.kind).toBe("weekly");
    expect(rec?.plan.name).toBe("Plus"); // 1,800 > Starter's 500
    expect(rec?.usageRatio).toBeGreaterThan(1);
  });
});

describe("weeklyAlternative", () => {
  it("suggests the smallest covering weekly pass", () => {
    expect(weeklyAlternative(400, PLANS)?.name).toBe("Starter");
    expect(weeklyAlternative(800, PLANS)?.name).toBe("Plus");
    expect(weeklyAlternative(5000, PLANS)).toBeNull();
    expect(weeklyAlternative(0, PLANS)).toBeNull();
  });
});

describe("recommendReasons", () => {
  it("always produces at most 3 reasons", () => {
    const rec = recommendPlan(sel(), PLANS, COSTS)!;
    const reasons = recommendReasons(sel(), rec);
    expect(reasons.length).toBeLessThanOrEqual(3);
    expect(reasons.length).toBeGreaterThan(0);
  });

  it("names the capability driver", () => {
    const rec = recommendPlan(sel({ capabilities: ["rate"] }), PLANS, COSTS)!;
    const reasons = recommendReasons(sel(), rec);
    expect(reasons.some((r) => r.includes("Studio"))).toBe(true);
  });

  it("mentions top-ups when usage outgrows the largest plan", () => {
    const rec = recommendPlan(sel({ filters: 3000, posters: 0 }), PLANS, COSTS)!;
    const reasons = recommendReasons(sel({ filters: 3000, posters: 0 }), rec);
    expect(reasons.some((r) => r.includes("top up"))).toBe(true);
  });
});
