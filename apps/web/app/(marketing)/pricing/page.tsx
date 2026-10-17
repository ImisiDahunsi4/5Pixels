import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getPlansForPurchase } from "@/lib/db/plans";
import { getCatalogCostProfile } from "@/lib/db/explore";
import { getActivePlan } from "@/lib/billing/entitlements";
import { PlanFinder } from "@/components/marketing/plan-finder";
import { PricingComparison } from "@/components/marketing/pricing-comparison";
import { PricingFaq } from "@/components/marketing/pricing-faq";
import { Button } from "@/components/ui/button";
import { Check } from "@phosphor-icons/react/dist/ssr";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

const FREE_BENEFITS = [
  "10 welcome credits",
  "Full preset catalog",
  "Failed transformations release credits",
];

function paidBenefits(plan: {
  credits_grant: number;
  markup_multiplier: number;
}): string[] {
  const benefits = [
    `${plan.credits_grant.toLocaleString()} credits every month`,
    "Top up extra credits anytime",
    "Failed transformations release credits",
  ];
  if (plan.markup_multiplier <= 2.5) {
    benefits.push("Lower credit cost per transformation");
  } else {
    benefits.push("Better credit rates than weekly trials");
  }
  return benefits.slice(0, 4);
}

export default async function PricingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [plans, activePlan, costProfile] = await Promise.all([
    getPlansForPurchase(),
    getActivePlan(),
    getCatalogCostProfile(),
  ]);

  const monthlyPlans = plans.filter((p) => p.type === "monthly");
  const weeklyPlans = plans.filter((p) => p.type === "weekly_trial");
  const recommendedSlug = "monthly-pro";

  const cta = (planId: string | null, label: string, primary: boolean) => {
    if (!user) {
      return (
        <Button
          asChild
          size="sm"
          variant={primary ? "brand" : "secondary"}
          className="w-full"
        >
          <Link href="/signup?next=/pricing">{label}</Link>
        </Button>
      );
    }
    return (
      <form action="/api/billing/checkout" method="post">
        <input type="hidden" name="plan_id" value={planId ?? ""} />
        <Button
          type="submit"
          size="sm"
          variant={primary ? "brand" : "secondary"}
          className="w-full"
          disabled={!planId}
        >
          {planId ? label : "Coming soon"}
        </Button>
      </form>
    );
  };

  return (
    <main className="flex flex-1 flex-col">
      {/* Hero */}
      <section className="px-4 pb-10 pt-16 text-center sm:px-6 lg:pt-24">
        <h1 className="text-cream-50 mx-auto max-w-3xl text-3xl font-semibold sm:text-4xl lg:text-5xl">
          Choose the plan that fits your creativity.
        </h1>
        <p className="text-text-secondary mx-auto mt-4 max-w-xl text-base">
          Plans give you monthly credits to spend on transformations — every
          preset shows its exact cost before you generate.
        </p>
      </section>

      {/* Plan cards */}
      <section className="px-4 sm:px-6">
        <div className="mx-auto grid max-w-7xl gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {/* Free */}
          <div className="border-cream-100/10 bg-charcoal-850 flex flex-col rounded-[20px] border p-6">
            <p className="text-cream-50 text-sm font-semibold">Free</p>
            <p className="text-cream-50 mt-3 text-3xl font-semibold">$0</p>
            <p className="text-text-secondary mt-1 text-xs">
              10 credits to start
            </p>
            <ul className="mt-5 flex-1 space-y-2.5">
              {FREE_BENEFITS.map((b) => (
                <li key={b} className="flex items-start gap-2.5">
                  <Check
                    size={15}
                    weight="bold"
                    className="text-lime-400 mt-0.5 shrink-0"
                  />
                  <span className="text-text-secondary text-sm">{b}</span>
                </li>
              ))}
            </ul>
            <div className="mt-6">
              {user ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  disabled
                >
                  {activePlan ? "Included" : "Current plan"}
                </Button>
              ) : (
                <Button
                  asChild
                  variant="secondary"
                  size="sm"
                  className="w-full"
                >
                  <Link href="/signup">Sign up free</Link>
                </Button>
              )}
            </div>
          </div>

          {/* Monthly plans */}
          {monthlyPlans.map((plan) => {
            const recommended = plan.slug === recommendedSlug;
            const isCurrent = activePlan?.planId === plan.id;
            return (
              <div
                key={plan.id}
                className={cn(
                  "relative flex flex-col rounded-[20px] border p-6",
                  recommended
                    ? "border-lime-500/35 bg-charcoal-800"
                    : "border-cream-100/10 bg-charcoal-850"
                )}
              >
                {recommended && (
                  <span className="bg-lime-500/10 text-lime-300 absolute -top-2.5 left-5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                    Best value
                  </span>
                )}
                <p className="text-cream-50 text-sm font-semibold">
                  {plan.name}
                </p>
                <p className="text-cream-50 mt-3 text-3xl font-semibold">
                  {formatPrice(plan.price_cents)}
                  <span className="text-text-secondary text-sm font-normal">
                    /mo
                  </span>
                </p>
                <p className="text-text-secondary mt-1 text-xs">
                  {plan.credits_grant.toLocaleString()} credits / month
                </p>
                <ul className="mt-5 flex-1 space-y-2.5">
                  {paidBenefits(plan).map((b) => (
                    <li key={b} className="flex items-start gap-2.5">
                      <Check
                        size={15}
                        weight="bold"
                        className="text-lime-400 mt-0.5 shrink-0"
                      />
                      <span className="text-text-secondary text-sm">{b}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-6">
                  {isCurrent ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full"
                      disabled
                    >
                      Current plan
                    </Button>
                  ) : (
                    cta(
                      plan.dodo_product_id ? plan.id : null,
                      `Choose ${plan.name}`,
                      recommended
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Weekly trials */}
        {weeklyPlans.length > 0 && (
          <div className="border-cream-100/10 bg-charcoal-850 mx-auto mt-6 flex max-w-7xl flex-wrap items-center justify-between gap-4 rounded-[15px] border px-5 py-4">
            <p className="text-text-secondary text-sm">
              <span className="text-cream-50 font-medium">New here?</span> Try a
              week before committing —{" "}
              {weeklyPlans
                .map(
                  (p) =>
                    `${p.name.replace("Weekly Trial - ", "")} ${formatPrice(p.price_cents)}`
                )
                .join(" or ")}
              .
            </p>
            {user ? (
              <form action="/api/billing/checkout" method="post">
                <input
                  type="hidden"
                  name="plan_id"
                  value={weeklyPlans[0]?.id ?? ""}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  disabled={!weeklyPlans[0]?.dodo_product_id}
                >
                  Start a weekly trial
                </Button>
              </form>
            ) : (
              <Button asChild variant="secondary" size="sm">
                <Link href="/signup?next=/pricing">Start a weekly trial</Link>
              </Button>
            )}
          </div>
        )}
      </section>

      {/* Plan finder */}
      <section className="px-4 py-20 sm:px-6 lg:py-28">
        <div className="mx-auto max-w-7xl">
          <h2 className="text-cream-50 text-2xl font-semibold sm:text-3xl">
            Find the best plan for you
          </h2>
          <p className="text-text-secondary mt-2 max-w-xl">
            Answer three quick questions and we&apos;ll suggest a plan based on
            how much you expect to create.
          </p>
          <div className="mt-10">
            <PlanFinder
              plans={plans
                .filter(
                  (p) => p.type === "monthly" || p.type === "weekly_trial"
                )
                .map((p) => ({
                  id: p.id,
                  slug: p.slug,
                  name: p.name.replace("Weekly Trial - ", ""),
                  type: p.type,
                  creditsGrant: p.credits_grant,
                  priceCents: p.price_cents,
                  checkoutReady: Boolean(p.dodo_product_id),
                }))}
              costs={costProfile}
              isAuthenticated={Boolean(user)}
            />
          </div>
        </div>
      </section>

      {/* Comparison */}
      <section className="px-4 pb-20 sm:px-6">
        <div className="mx-auto max-w-7xl">
          <h2 className="text-cream-50 text-2xl font-semibold sm:text-3xl">
            Compare plans
          </h2>
          <p className="text-text-secondary mt-2 max-w-xl">
            Every plan gets the full preset catalog. Paid plans differ on
            monthly credits and credit rates.
          </p>
          <div className="mt-8 overflow-x-auto">
            <PricingComparison
              monthlyPlans={monthlyPlans}
              recommendedSlug={recommendedSlug}
            />
          </div>
        </div>
      </section>

      {/* FAQ + final CTA */}
      <section id="faq" className="px-4 pb-20 sm:px-6">
        <PricingFaq />
        <div className="mt-16 text-center">
          <p className="text-cream-50 text-lg font-semibold">Ready to create?</p>
          <Button asChild className="mt-4">
            <Link href={user ? "/app/billing/plan" : "/signup?next=/pricing"}>
              Choose your plan
            </Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
