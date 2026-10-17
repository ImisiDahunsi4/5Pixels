export interface FinderPlan {
  id: string;
  slug: string;
  name: string;
  /** "monthly" | "weekly_trial" | "extra_credit" */
  type: string;
  creditsGrant: number;
  priceCents: number;
  /** A purchasable product id exists for the active payment provider. */
  checkoutReady: boolean;
}

export type UseCase =
  | "social"
  | "headshots"
  | "posters"
  | "illustrated"
  | "cinematic"
  | "fun";

/** Step-3 extras — bind the recommendation to a rate tier or product type. */
export type Capability = "rate" | "weekly";

export interface UsagePreset {
  filters: number;
  posters: number;
}

export interface CostProfile {
  /** Median credit cost of one Filter transformation. */
  filterCost: number;
  /** Median credit cost of one Poster generation. */
  posterCost: number;
}

export interface FinderSelections {
  useCases: UseCase[];
  /** Expected Filter transformations per month. */
  filters: number;
  /** Expected Poster generations per month. */
  posters: number;
  capabilities: Capability[];
}

/**
 * Per-use-case monthly volume presets. Selecting a use case applies its
 * volumes; multiple selections take the max of each slider (same merge
 * semantics as the reference wizard).
 */
export const USE_CASE_PRESETS: Record<UseCase, UsagePreset> = {
  social: { filters: 60, posters: 10 },
  headshots: { filters: 40, posters: 0 },
  posters: { filters: 15, posters: 40 },
  illustrated: { filters: 50, posters: 15 },
  cinematic: { filters: 70, posters: 5 },
  fun: { filters: 30, posters: 10 },
};

/**
 * Capabilities that bind the recommendation. "rate" forces at least the
 * tier whose markup unlocks the better credit rate (Studio); "weekly"
 * routes to a one-time weekly pass instead of a subscription.
 */
const CAPABILITY_MIN_TIER_SLUG: Partial<Record<Capability, string>> = {
  rate: "monthly-studio",
};

export function presetsForUseCases(useCases: UseCase[]): UsagePreset {
  const merged: UsagePreset = { filters: 0, posters: 0 };
  for (const useCase of useCases) {
    const preset = USE_CASE_PRESETS[useCase];
    merged.filters = Math.max(merged.filters, preset.filters);
    merged.posters = Math.max(merged.posters, preset.posters);
  }
  return merged;
}

/** Estimated monthly credits: filters × filterCost + posters × posterCost. */
export function estimateMonthlyCredits(
  selections: Pick<FinderSelections, "filters" | "posters">,
  costs: CostProfile
): number {
  const filters = Number.isFinite(selections.filters)
    ? Math.max(0, selections.filters)
    : 0;
  const posters = Number.isFinite(selections.posters)
    ? Math.max(0, selections.posters)
    : 0;
  return Math.ceil(filters * costs.filterCost + posters * costs.posterCost);
}

export interface Recommendation {
  plan: FinderPlan;
  kind: "subscription" | "weekly";
  neededCredits: number;
  /** neededCredits / plan grant — may exceed 1 when usage outgrows the top tier. */
  usageRatio: number;
  /** What set the tier: raw volume, or a selected capability. */
  driver: "volume" | "capability";
  capability?: Capability;
}

function byGrant(a: FinderPlan, b: FinderPlan): number {
  return a.creditsGrant - b.creditsGrant;
}

/**
 * Recommend a plan: the smallest tier covering the estimated credits,
 * raised to the minimum tier any selected capability requires. A "weekly"
 * capability routes to the smallest weekly pass that covers the estimate
 * (largest pass when it doesn't fit).
 */
export function recommendPlan(
  selections: FinderSelections,
  plans: FinderPlan[],
  costs: CostProfile
): Recommendation | null {
  const needed = estimateMonthlyCredits(selections, costs);
  const monthly = plans.filter((p) => p.type === "monthly").sort(byGrant);
  const weekly = plans.filter((p) => p.type === "weekly_trial").sort(byGrant);

  if (selections.capabilities.includes("weekly")) {
    if (weekly.length === 0) return null;
    const plan = weekly.find((p) => p.creditsGrant >= needed) ?? weekly.at(-1)!;
    return {
      plan,
      kind: "weekly",
      neededCredits: needed,
      usageRatio: plan.creditsGrant > 0 ? needed / plan.creditsGrant : 1,
      driver: "capability",
      capability: "weekly",
    };
  }

  if (monthly.length === 0) return null;
  if (needed <= 0) {
    const plan = monthly[0]!;
    return {
      plan,
      kind: "subscription",
      neededCredits: 0,
      usageRatio: 0,
      driver: "volume",
    };
  }

  const volumeIdx = monthly.findIndex((p) => p.creditsGrant >= needed);
  let tierIdx = volumeIdx === -1 ? monthly.length - 1 : volumeIdx;
  let driver: Recommendation["driver"] = "volume";
  let capability: Capability | undefined;

  for (const cap of selections.capabilities) {
    const minSlug = CAPABILITY_MIN_TIER_SLUG[cap];
    if (!minSlug) continue;
    const minIdx = monthly.findIndex((p) => p.slug === minSlug);
    if (minIdx > tierIdx) {
      tierIdx = minIdx;
      driver = "capability";
      capability = cap;
    }
  }

  const plan = monthly[tierIdx]!;
  return {
    plan,
    kind: "subscription",
    neededCredits: needed,
    usageRatio: plan.creditsGrant > 0 ? needed / plan.creditsGrant : 1,
    driver,
    capability,
  };
}

/** Smallest weekly pass that covers the estimate, if any. */
export function weeklyAlternative(
  neededCredits: number,
  plans: FinderPlan[]
): FinderPlan | null {
  if (neededCredits <= 0) return null;
  const weekly = plans
    .filter((p) => p.type === "weekly_trial")
    .sort(byGrant);
  return weekly.find((p) => p.creditsGrant >= neededCredits) ?? null;
}

export function recommendReasons(
  selections: FinderSelections,
  rec: Recommendation
): string[] {
  const reasons: string[] = [];
  const { plan } = rec;

  if (rec.neededCredits > 0) {
    reasons.push(
      `≈ ${rec.neededCredits.toLocaleString()} credits/month covers ~${selections.filters.toLocaleString()} filters and ~${selections.posters.toLocaleString()} posters`
    );
  }
  if (plan.creditsGrant >= rec.neededCredits) {
    reasons.push(
      `${plan.name} includes ${plan.creditsGrant.toLocaleString()} credits — your estimate fits`
    );
  } else {
    reasons.push(
      `${plan.name} is the largest ${rec.kind === "weekly" ? "pass" : "plan"} — top up extra credits anytime`
    );
  }
  if (rec.capability === "rate") {
    reasons.push("Studio and above unlock the best credits-per-dollar rate");
  } else if (rec.kind === "weekly") {
    reasons.push("One-time weekly pass — no subscription");
  } else {
    reasons.push("Upgrade or downgrade anytime — changes apply next cycle");
  }

  return reasons.slice(0, 3);
}
