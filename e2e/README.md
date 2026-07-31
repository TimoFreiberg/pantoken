# e2e test conventions

The mock-driver suite (`e2e/*.e2e.ts`) is organized as **flow tests**: one `test()`
block per coherent user journey ("sub-flow"), carrying all of that journey's
assertions. This is a deliberate departure from one-test-per-behavior: each test
walks a realistic journey end-to-end, and new behavior is added by extending the
existing flow that covers that journey — not by spawning a new test.

Why: every test pays a fixed boot cost (`gotoFresh`: mock-server reset + full
page load + greeting replay) in `beforeEach`. The suite runs serially on one
shared mock session, so test count is wall time. Flow tests keep that overhead
per journey instead of per assertion.

## Rules

- **One flow per sub-flow.** A flow is a coherent user journey ("create a
  session via the chooser and switch back to it"). Tests that act on different
  things stay in separate flows — no mega-tests bundling unrelated journeys.
  Start each `test()` with a short `//` comment naming the journey it covers.
- **One `gotoFresh` per flow.** Keep the file-level `beforeEach` calling
  `gotoFresh(page)` once; chain the rest of the state with `drive()` in mock
  state-machine order (`/debug/reset` returns to the boot fixture; `drive` moves
  to named states). Only if a sub-flow genuinely needs a fresh boot, reset+reload
  inside that flow's test body (and note why).
- **Special boot setups stay in the test body.** Flows that need WebSocket
  gating, `routeWebSocket` frame recording, or a blocked-WebSocket boot keep
  their setup inside the test body (reset → install gate → goto). If a file
  mixes normal and special-boot flows, use `test.describe` groups with separate
  `beforeEach`.
- **`test.setTimeout` for long flows.** Flows spanning several turns can exceed
  the 30s default; give them an explicit `test.setTimeout(...)` instead of
  blanket-bumping.
- **Desktop and mobile stay separate.** Desktop flows live in `*.e2e.ts`,
  mobile flows in `*.mobile.e2e.ts`; Playwright project routing depends on the
  suffix. Never merge a desktop and a mobile file.
- **Preserve assertions and drive scripts.** Merging files must carry every
  `expect(...)` (selectors/text verbatim) and every `drive()` call forward; if
  two identical assertions are consolidated, say so in the merge report.
