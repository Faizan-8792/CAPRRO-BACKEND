# Context Package

## Task

Locate exact monetization code only: subscription, billing, pricing, paid plan, free tier, entitlement, feature quota, upgrade paywall, trial, payment. Also separate rollout flags, auth, authorization, usage telemetry, consent, rate limits, and operational abuse controls.

## Detected Stack

- express

## Relevant Files

- **src/middleware/auth.middleware.js** — tags: [auth, authmiddleware, js, middleware, required, src, tracking, usage, without], importance: 70, role: seed, hop: 0

## Warnings

- src/middleware/auth.middleware.js has fan-in > 10 (18 dependents)

## Token Budget

- Point estimate: 560 tokens
- Range: 448 – 672 tokens
- Reduction: 100% vs full project
