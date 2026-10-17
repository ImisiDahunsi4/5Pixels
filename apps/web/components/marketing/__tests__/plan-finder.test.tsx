import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlanFinder } from "../plan-finder";
import type { FinderPlan } from "@/lib/billing/recommend";

vi.mock("@/lib/analytics/track", () => ({
  trackEvent: vi.fn(),
}));

const COSTS = { filterCost: 6, posterCost: 12 };

const PLANS: FinderPlan[] = [
  { id: "ws", slug: "weekly-starter", name: "Starter", type: "weekly_trial", creditsGrant: 500, priceCents: 500, checkoutReady: true },
  { id: "wp", slug: "weekly-plus", name: "Plus", type: "weekly_trial", creditsGrant: 1000, priceCents: 1000, checkoutReady: true },
  { id: "c", slug: "monthly-creator", name: "Creator", type: "monthly", creditsGrant: 2000, priceCents: 2000, checkoutReady: true },
  { id: "p", slug: "monthly-pro", name: "Pro", type: "monthly", creditsGrant: 3000, priceCents: 3000, checkoutReady: true },
  { id: "s", slug: "monthly-studio", name: "Studio", type: "monthly", creditsGrant: 5500, priceCents: 5000, checkoutReady: true },
  { id: "a", slug: "monthly-agency", name: "Agency", type: "monthly", creditsGrant: 12000, priceCents: 10000, checkoutReady: false },
];

function renderFinder(over: Partial<Parameters<typeof PlanFinder>[0]> = {}) {
  return render(
    <PlanFinder plans={PLANS} costs={COSTS} isAuthenticated={false} {...over} />
  );
}

describe("PlanFinder", () => {
  it("renders the three steps and a default recommendation", () => {
    renderFinder();
    expect(screen.getByText(/What are you here to make/i)).toBeInTheDocument();
    expect(screen.getByText(/How many images per month/i)).toBeInTheDocument();
    expect(screen.getByText(/Anything else you need/i)).toBeInTheDocument();
    // Default: social → 60 filters + 10 posters = 480 credits → Creator
    expect(screen.getByText("Creator")).toBeInTheDocument();
    expect(screen.getByText(/Expected monthly usage/i)).toBeInTheDocument();
  });

  it("resets sliders to merged presets when a use case is toggled", () => {
    renderFinder();
    fireEvent.click(screen.getByText("Posters & covers"));
    // social (60/10) + posters (15/40) → merged 60/40
    expect(screen.getByText("~60 filters / month")).toBeInTheDocument();
    expect(screen.getByText("~40 posters / month")).toBeInTheDocument();
  });

  it("cannot deselect the last selected use case", () => {
    renderFinder();
    const social = screen.getByText("Social content").closest("button")!;
    expect(social).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(social);
    expect(social).toHaveAttribute("aria-pressed", "true");
  });

  it("binds the recommendation to Studio when the rate capability is selected", () => {
    renderFinder();
    fireEvent.click(screen.getByText("Best credits-per-dollar rate"));
    expect(screen.getByText("Studio")).toBeInTheDocument();
  });

  it("routes to a weekly pass when the weekly capability is selected", () => {
    renderFinder();
    fireEvent.click(screen.getByText("Weekly pass"));
    expect(screen.getByText("Starter")).toBeInTheDocument();
    expect(screen.getByText(/one-time/)).toBeInTheDocument();
  });

  it("suggests a weekly pass under the CTA for light subscription usage", () => {
    renderFinder();
    expect(screen.getByText(/Just trying it out/)).toBeInTheDocument();
  });

  it("posts the recommended plan id to checkout for signed-in users", () => {
    renderFinder({ isAuthenticated: true });
    const input = document.querySelector(
      'input[name="plan_id"]'
    ) as HTMLInputElement;
    expect(input.value).toBe("c");
    expect(
      screen.getByRole("button", { name: "Choose Creator" })
    ).toBeInTheDocument();
  });

  it("links anonymous users to signup", () => {
    renderFinder({ isAuthenticated: false });
    const cta = screen.getByRole("link", { name: "Choose Creator" });
    expect(cta).toHaveAttribute("href", "/signup?next=/pricing");
  });

  it("disables checkout when the recommended plan has no purchasable product", () => {
    renderFinder({ isAuthenticated: true });
    // Push both sliders to max → usage outgrows every tier → Agency, whose
    // fixture plan has checkoutReady: false.
    const filtersSlider = screen.getByRole("slider", { name: /filters per month/i });
    const postersSlider = screen.getByRole("slider", { name: /posters per month/i });
    fireEvent.keyDown(filtersSlider, { key: "End" });
    fireEvent.keyDown(postersSlider, { key: "End" });
    expect(screen.getByText("Agency")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Coming soon" })
    ).toBeDisabled();
  });

  it("reveals reasons via the See why disclosure", () => {
    renderFinder();
    const summary = screen.getByText("See why");
    fireEvent.click(summary);
    expect(screen.getByText(/credits\/month covers/i)).toBeInTheDocument();
  });
});
