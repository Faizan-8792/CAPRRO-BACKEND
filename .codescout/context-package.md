# Context Package

## Task

Fix deep system test stale cleanup retry DeepSeek evidence polling race ARIA focus exact assertions

## Detected Stack

- express

## Relevant Files

- **src/controllers/firm.controller.js** — tags: [admin, by, code, controller, controllers, create, delete, firm, firmcontroller, get, id, join, js, list, my, request, rotate, src, update, user, users], importance: 14, role: seed, hop: 0
- **tests/taxworker-flow-checklist.mjs** — tags: [checklist, flow, mjs, taxworker, tests], importance: 9, role: seed, hop: 0
- **src/middleware/request-id.middleware.js** — tags: [id, idmiddleware, js, middleware, request, src], importance: 8, role: seed, hop: 0
- **src/middleware/sanitize.middleware.js** — tags: [id, inputs, is, js, middleware, object, param, sanitize, sanitizemiddleware, src, valid, validate], importance: 8, role: seed, hop: 0
- **src/models/Firm.js** — tags: [firm, js, models, src], importance: 33, role: hop-1, hop: 1
- **src/models/User.js** — tags: [js, models, src, user], importance: 56, role: hop-1, hop: 1
- **src/models/AppConfig.js** — tags: [app, appconfig, config, default, feature, flags, js, models, src], importance: 46, role: hop-1, hop: 1
- **src/routes/firm.routes.js** — tags: [firm, firmroutes, js, routes, src], importance: 13, role: hop-1, hop: 1

## Warnings

- src/models/User.js has fan-in > 10 (18 dependents)
- src/models/AppConfig.js has fan-in > 10 (14 dependents)

## Token Budget

- Point estimate: 10843 tokens
- Range: 8674 – 13012 tokens
- Reduction: 96% vs full project
