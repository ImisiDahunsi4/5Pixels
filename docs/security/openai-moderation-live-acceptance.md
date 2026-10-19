# OpenAI Moderation — Live Acceptance Checklist (#185)

Final release-gate evidence for the hosted configuration. The staging suite
(`apps/web/lib/generation/__tests__/actions-moderation-staging.test.ts`) proves
the code path over real HTTP against a stub; **this runbook proves the real
OpenAI endpoint works with our hosted credentials** and that the action-level
guarantees hold on a deployed environment.

**Do not enable `PRESET_USER_PROMPT_ENABLED` or the `release_gates` row in any
customer-facing environment until every box is checked and the owner signs.**

## Preconditions

- [ ] `OPENAI_API_KEY` provisioned in Vercel — **done** (preview + prod listed,
      confirmed by the A-section run on 2026-10-19).
- [ ] Hosted migrations applied — **pending** (tip `20261027000001` as of
      2026-10-19; five files pending through `20261031000001`).
- [ ] Fresh preview deployment carrying the moderation path.

**Gate note — most of Section B needs no release gate at all.** With
`OPENAI_API_KEY` configured, the screen fires for every generation's
user-entered option text even when custom prompts are unreleased. So B3–B7
run on an ordinary preview deploy with `PRESET_USER_PROMPT_ENABLED` OFF and
the `release_gates` row OFF — zero gate surface opened. Only B1–B2 (the
literal custom-prompt path) need `PRESET_USER_PROMPT_ENABLED=true` on the
preview deployment plus the DB gate — schedule those as a brief, supervised
window and revert immediately after; the env flag alone gates the public
surface, but treat the DB row flip as a release action requiring owner go.

- [ ] One test account + one admin-published preset with
      `prompt_override_enabled` on a prompt-capable route
      (e.g. `fal-ai/nano-banana-2/edit`) and a second preset WITHOUT prompt
      override for the legacy-path checks.
- [ ] No real customer content is used; test prompts are the strings below.

## A. Endpoint contract — `scripts/openai-moderation-smoke.mjs`

Runs real calls with the production request shape
(`POST /v1/moderations`, `omni-moderation-latest`, array input, 5s timeout)
and the same strict verdict logic as `lib/moderation/openai.ts`.

```bash
# With the hosted key in env or apps/web/.env.local
node scripts/openai-moderation-smoke.mjs            # benign / prohibited / batch
node scripts/openai-moderation-smoke.mjs --bad-key  # expect fail-closed (401)
node scripts/openai-moderation-smoke.mjs --unreachable
```

- [ ] **A1 benign** — verdict `allow`; proves key validity + endpoint + shape.
- [ ] **A2 prohibited** — verdict `blocked` with category names; proves the
      real model flags a prohibited prompt and our category-as-signal policy
      reports which categories fired.
- [ ] **A3 batch** — `[benign, prohibited]` in one call → `blocked`; proves
      the multi-input shape (normalized prompt + legacy option text) and the
      per-input result contract.
- [ ] **A4 invalid key** — `unavailable` (HTTP 401) → hosted code fails closed.
- [ ] **A5 unreachable** — `unavailable` (fetch failed) → fails closed.

## B. Hosted action path — gated preview deployment

Drive `createAndSubmitGeneration` through the preview app. After each case,
verify credits with the query below — a moderation rejection must leave the
ledger untouched.

```sql
-- Run before and after each case; counts and rows must be IDENTICAL for
-- every rejection case (B2–B5) and change only for the allowed case (B1).
select count(*) as quotes
from generation_quotes
where user_id = '<test-user-uuid>'
  and created_at > '<run-start>';

-- credit_ledger rows for the run window — a rejection must produce no
-- 'reservation' or 'debit' entries.
select id, entry_type, amount, created_at
from credit_ledger
where user_id = '<test-user-uuid>'
  and created_at > '<run-start>'
order by created_at;
```

- [ ] **B1 benign prompt** — a clearly safe prompt proceeds past moderation;
      a quote is created, credits are reserved, and the request reaches the
      provider. This is the ONLY case where the quote count may increase.
- [ ] **B2 prohibited prompt** — request rejected with the generic
      content-policy error. **Zero credit reservation**: quote count and
      ledger identical to the before snapshot. No Fal invocation (check
      function logs / provider dashboard).
- [ ] **B3 legacy text option** — on a preset WITHOUT prompt override, submit
      prohibited text in a free-text option field → same rejection, zero
      reservation. Proves the option-text screen can't be bypassed whenever
      `OPENAI_API_KEY` is configured.
- [ ] **B4 invalid key** — temporarily set `OPENAI_API_KEY` to a bad value on
      the preview deployment, redeploy, submit a benign prompt → generic
      "couldn't verify" error, zero reservation. Restore the key.
- [ ] **B5 outage** — temporarily set `OPENAI_MODERATION_URL` to an
      unroutable address on the preview deployment → same fail-closed
      behavior, zero reservation. Remove the override after.
- [ ] **B6 logs** — inspect the preview deployment's function logs for the
      blocked/failed cases: category names and moderation result ids may
      appear; the submitted text and private recipe content must NOT appear
      anywhere.
- [ ] **B7 legacy prompt-less flow** — a preset with no prompt override and
      no free-text options still generates normally (legacy behavior intact).

## Sign-off record

| Case | Result | Verified by | Date |
|---|---|---|---|
| A1–A5 endpoint contract | **PASS** — A1 benign `allow`; A2 prohibited `blocked` [`illicit`, `illicit/violent`]; A3 batch `blocked` (same categories); A4 invalid key → `unavailable` (real 401); A5 unreachable → `unavailable` | Devin (`openai-moderation-smoke.mjs`, real key) | 2026-10-19 |
| B1–B7 hosted action path | pending — hosted migrations (tip `20261027000001`) and fresh preview deploy | | |
| Privacy/AUP/Terms wording (#172) | held PR #219 — pending owner/legal sign-off | | |

**Release remains blocked** until all rows pass AND: Bachs approval scope is
documented in #173, legal copy is signed off under #172, and the owner
approves flag + key rollout for production.
