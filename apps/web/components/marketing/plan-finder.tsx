"use client";

import { useMemo, useState } from "react";
import {
  presetsForUseCases,
  recommendPlan,
  recommendReasons,
  weeklyAlternative,
  type Capability,
  type CostProfile,
  type FinderPlan,
  type UseCase,
} from "@/lib/billing/recommend";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { trackEvent } from "@/lib/analytics/track";
import {
  ShareNetwork,
  UserFocus,
  Newspaper,
  Palette,
  FilmStrip,
  Sparkle,
  Check,
  CaretDown,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

const USE_CASES: { key: UseCase; label: string; icon: typeof Sparkle }[] = [
  { key: "social", label: "Social content", icon: ShareNetwork },
  { key: "headshots", label: "Profile & professional headshots", icon: UserFocus },
  { key: "posters", label: "Posters & covers", icon: Newspaper },
  { key: "illustrated", label: "Illustrated & stylized art", icon: Palette },
  { key: "cinematic", label: "Cinematic edits", icon: FilmStrip },
  { key: "fun", label: "Just for fun", icon: Sparkle },
];

const CAPABILITIES: {
  key: Capability;
  label: string;
  hint: string;
}[] = [
  { key: "rate", label: "Best credits-per-dollar rate", hint: "Studio+" },
  { key: "weekly", label: "Weekly pass", hint: "no subscription" },
];

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

interface PlanFinderProps {
  plans: FinderPlan[];
  costs: CostProfile;
  /** Post-checkout path; signed-in users go straight to checkout. */
  isAuthenticated: boolean;
}

export function PlanFinder({ plans, costs, isAuthenticated }: PlanFinderProps) {
  const [useCases, setUseCases] = useState<UseCase[]>(["social"]);
  const initial = presetsForUseCases(["social"]);
  const [filters, setFilters] = useState(initial.filters);
  const [posters, setPosters] = useState(initial.posters);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);

  const selections = useMemo(
    () => ({ useCases, filters, posters, capabilities }),
    [useCases, filters, posters, capabilities]
  );
  const rec = useMemo(
    () => recommendPlan(selections, plans, costs),
    [selections, plans, costs]
  );
  const reasons = useMemo(
    () => (rec ? recommendReasons(selections, rec) : []),
    [selections, rec]
  );
  const weeklyAlt = useMemo(
    () =>
      rec && rec.kind !== "weekly"
        ? weeklyAlternative(rec.neededCredits, plans)
        : null,
    [rec, plans]
  );

  const toggleUseCase = (key: UseCase) => {
    const active = !useCases.includes(key);
    const next = active
      ? [...useCases, key]
      : useCases.filter((k) => k !== key);
    // Keep at least one use case selected.
    if (next.length === 0) return;
    const preset = presetsForUseCases(next);
    setUseCases(next);
    setFilters(preset.filters);
    setPosters(preset.posters);
    trackEvent({ event: "plan_finder_use_case", props: { useCase: key, active } });
  };

  const toggleCapability = (key: Capability) => {
    const active = !capabilities.includes(key);
    setCapabilities(
      active ? [...capabilities, key] : capabilities.filter((k) => k !== key)
    );
    trackEvent({ event: "plan_finder_capability", props: { capability: key, active } });
  };

  const usagePct = rec ? Math.min(100, Math.round(rec.usageRatio * 100)) : 0;
  const overCapacity = rec ? rec.usageRatio > 1 : false;

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
      {/* Questionnaire */}
      <div className="space-y-10">
        <div>
          <p className="text-text-muted text-xs font-semibold uppercase tracking-wider">
            1 · What are you here to make?
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {USE_CASES.map(({ key, label, icon: ItemIcon }) => {
              const selected = useCases.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleUseCase(key)}
                  aria-pressed={selected}
                  className={cn(
                    "flex items-center gap-3 rounded-[15px] border p-4 text-left transition-colors",
                    selected
                      ? "border-lime-500/40 bg-charcoal-800 text-cream-50"
                      : "border-cream-100/10 bg-charcoal-850 text-text-secondary hover:border-cream-100/20 hover:text-cream-100"
                  )}
                >
                  <ItemIcon
                    size={18}
                    weight={selected ? "fill" : "regular"}
                    className={selected ? "text-lime-400" : "text-text-muted"}
                  />
                  <span className="flex-1 text-sm font-medium">{label}</span>
                  {selected && (
                    <Check size={16} weight="bold" className="text-lime-400" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <p className="text-text-muted text-xs font-semibold uppercase tracking-wider">
            2 · How many images per month?
          </p>
          <div className="mt-4 space-y-3">
            <div className="border-cream-100/10 bg-charcoal-850 rounded-[15px] border p-5">
              <div className="flex items-baseline justify-between">
                <p className="text-cream-50 text-sm font-medium">
                  ~{filters} filters / month
                </p>
                <p className="text-text-secondary text-xs">
                  ≈ {(filters * costs.filterCost).toLocaleString()} credits ·{" "}
                  {costs.filterCost} each
                </p>
              </div>
              <Slider
                value={[filters]}
                onValueChange={([v]) => setFilters(v)}
                min={5}
                max={1500}
                step={5}
                className="mt-4"
                aria-label="Filters per month"
              />
              <div className="text-text-muted mt-2 flex justify-between text-xs">
                <span>5</span>
                <span>1,500</span>
              </div>
            </div>

            <div className="border-cream-100/10 bg-charcoal-850 rounded-[15px] border p-5">
              <div className="flex items-baseline justify-between">
                <p className="text-cream-50 text-sm font-medium">
                  ~{posters} posters / month
                </p>
                <p className="text-text-secondary text-xs">
                  ≈ {(posters * costs.posterCost).toLocaleString()} credits ·{" "}
                  {costs.posterCost} each
                </p>
              </div>
              <Slider
                value={[posters]}
                onValueChange={([v]) => setPosters(v)}
                min={0}
                max={300}
                step={5}
                className="mt-4"
                aria-label="Posters per month"
              />
              <div className="text-text-muted mt-2 flex justify-between text-xs">
                <span>0</span>
                <span>300</span>
              </div>
            </div>
          </div>
        </div>

        <div>
          <p className="text-text-muted text-xs font-semibold uppercase tracking-wider">
            3 · Anything else you need?
          </p>
          <div className="mt-4 flex flex-wrap gap-2.5">
            {CAPABILITIES.map(({ key, label, hint }) => {
              const selected = capabilities.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleCapability(key)}
                  aria-pressed={selected}
                  className={cn(
                    "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                    selected
                      ? "border-lime-500/40 bg-lime-500/10 text-cream-50"
                      : "border-cream-100/10 bg-charcoal-850 text-text-secondary hover:border-cream-100/20 hover:text-cream-100"
                  )}
                >
                  {label}
                  <span className="text-text-muted ml-1.5 text-xs">
                    {hint}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Recommendation */}
      <div className="lg:sticky lg:top-24 lg:self-start">
        <div className="border-lime-500/25 bg-charcoal-800 rounded-[20px] border p-6">
          {rec ? (
            <>
              <div aria-live="polite">
                <p className="text-text-muted text-xs font-semibold uppercase tracking-wider">
                  We recommend
                </p>
                <p className="text-cream-50 mt-2 text-2xl font-semibold">
                  {rec.plan.name}
                </p>
                <p className="text-cream-50 mt-1 text-lg">
                  {formatPrice(rec.plan.priceCents)}
                  <span className="text-text-secondary text-sm font-normal">
                    {" "}
                    {rec.kind === "weekly" ? "one-time" : "/ month"} ·{" "}
                    {rec.plan.creditsGrant.toLocaleString()} credits
                  </span>
                </p>
              </div>

              {/* Expected usage */}
              <div className="mt-5">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-text-secondary">
                    Expected monthly usage
                  </span>
                  <span className="text-cream-100 font-medium">
                    {rec.neededCredits.toLocaleString()} /{" "}
                    {rec.plan.creditsGrant.toLocaleString()}
                  </span>
                </div>
                <div
                  className="bg-charcoal-700 mt-2 h-1.5 overflow-hidden rounded-full"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={rec.plan.creditsGrant}
                  aria-valuenow={rec.neededCredits}
                  aria-label="Expected monthly usage"
                >
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      overCapacity ? "bg-warning" : "bg-lime-500"
                    )}
                    style={{ width: `${usagePct}%` }}
                  />
                </div>
                {overCapacity && (
                  <p className="text-warning mt-1.5 text-xs">
                    Beyond {rec.plan.name} — top up extra credits anytime
                  </p>
                )}
              </div>

              <ul className="border-cream-100/10 mt-5 space-y-2.5 border-t pt-5">
                {(rec.kind === "weekly"
                  ? [
                      `${rec.plan.creditsGrant.toLocaleString()} credits for the week`,
                      "Full preset & poster catalog",
                      "Failed transformations release credits",
                    ]
                  : [
                      `${rec.plan.creditsGrant.toLocaleString()} credits every month`,
                      "Full preset & poster catalog",
                      "Top up extra credits anytime",
                      "Failed transformations release credits",
                    ]
                ).map((benefit) => (
                  <li key={benefit} className="flex items-start gap-2.5">
                    <Check
                      size={15}
                      weight="bold"
                      className="text-lime-400 mt-0.5 shrink-0"
                    />
                    <span className="text-text-secondary text-sm">
                      {benefit}
                    </span>
                  </li>
                ))}
              </ul>

              <details className="group mt-5">
                <summary className="text-text-secondary hover:text-cream-100 flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium transition-colors [&::-webkit-details-marker]:hidden">
                  See why
                  <CaretDown
                    size={14}
                    className="transition-transform group-open:rotate-180"
                  />
                </summary>
                <ul className="mt-3 space-y-2">
                  {reasons.map((reason) => (
                    <li key={reason} className="flex items-start gap-2.5">
                      <Check
                        size={14}
                        weight="bold"
                        className="text-lime-400 mt-0.5 shrink-0"
                      />
                      <span className="text-text-secondary text-sm">
                        {reason}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>

              {isAuthenticated ? (
                <form
                  action="/api/billing/checkout"
                  method="post"
                  className="mt-6"
                >
                  <input type="hidden" name="plan_id" value={rec.plan.id} />
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={!rec.plan.checkoutReady}
                    onClick={() =>
                      trackEvent({
                        event: "plan_finder_cta",
                        props: { planSlug: rec.plan.slug, kind: rec.kind },
                      })
                    }
                  >
                    {rec.plan.checkoutReady
                      ? `Choose ${rec.plan.name}`
                      : "Coming soon"}
                  </Button>
                </form>
              ) : (
                <Button asChild className="mt-6 w-full">
                  <a
                    href="/signup?next=/pricing"
                    onClick={() =>
                      trackEvent({
                        event: "plan_finder_cta",
                        props: { planSlug: rec.plan.slug, kind: rec.kind },
                      })
                    }
                  >
                    Choose {rec.plan.name}
                  </a>
                </Button>
              )}

              {weeklyAlt && (
                <p className="text-text-muted mt-3 text-xs">
                  Just trying it out? {weeklyAlt.name} —{" "}
                  {formatPrice(weeklyAlt.priceCents)} one-time covers your
                  estimate.
                </p>
              )}
              <p className="text-text-muted mt-3 text-xs leading-relaxed">
                Estimates vary with the presets you choose — every preset shows
                its exact credit cost before you generate.
              </p>
            </>
          ) : (
            <p className="text-text-secondary text-sm">
              Plans are loading — try again shortly.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
