"use client";

import { useCallback } from "react";

type AnalyticsEvent =
  | "homepage_view"
  | "hero_primary_cta_click"
  | "hero_upload_click"
  | "curated_section_view"
  | "preset_preview_play"
  | "preset_preview_complete"
  | "preset_card_click"
  | "category_chip_click"
  | "view_all_presets_click"
  | "how_it_works_view"
  | "pricing_view"
  | "pricing_cta_click"
  | "final_cta_click"
  | "signup_cta_click"
  | "faq_toggle"
  | "plan_finder_use_case"
  | "plan_finder_capability"
  | "plan_finder_cta";

interface TrackPayload {
  event: AnalyticsEvent;
  props?: Record<string, unknown>;
}

/**
 * Lightweight analytics tracker. In development it logs to the console; in
 * production it is a no-op until an analytics provider is wired in Phase 10.
 */
export function trackEvent({ event, props }: TrackPayload): void {
  if (process.env.NODE_ENV === "development") {
    console.log("[analytics]", event, props ?? {});
  }
  // Placeholder for Phase 10 provider integration (PostHog / Mixpanel / GA4).
}

export function useTrackClick(event: AnalyticsEvent, props?: Record<string, unknown>) {
  return useCallback(() => {
    trackEvent({ event, props });
  }, [event, props]);
}
