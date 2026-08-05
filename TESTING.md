# Test architecture

Unit tests cover things that are fully unit testable with zero or minimal mocks.
Don't add unit tests that only exercise mocks or parallel implementations.

e2e tests should be used for superior real world coverage, but they must be written and maintained carefully.
Instead of adding a huge number of e2e tests, it is preferrable to add assertions to existing tests that exercise the same interaction flow.
Every UI transition must be verified by adding checkpoints or polling before asserting, any timing dependent assertions must be avoided (CI can run very slow)

Tooling should only be tested if the tooling is complex, nonobvious and testable. Avoid writing scripts that are worth testing, they're probably too complex.

Documentation should not have automated tests.
