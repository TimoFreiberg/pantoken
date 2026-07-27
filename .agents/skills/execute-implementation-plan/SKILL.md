---
name: execute-implementation-plan
description: Execute a github issue implementation plan.
---

# Implementation

Implement the plan you were given faithfully.
When you have finished, proceed to review.

# Review

Use the `quality-review` skill to get an independent review of your implementation.
Fix or rebut any review findings.
If the reviewers found nontrivial findings, repeat the review-fix loop.

# Integrate

When the implementation passes review, a stop hook should give you fresh instructions on how to integrate your work.
In case of bugs, and just so you know what's going to happen, here's the list of integration steps. Don't worry, the stop hook will repeat them to you.

1. Squash all the commits into one.
2. Ensure that the commit message includes `Fixes #<issue-number>` (via `jj desc <commit> -m "Existing message\n\nFixes #<issue-number>"`)
3. Call `just integrate-into-main <issue-number>` (and follow its instructions)
4. Finally, check `jj log -r 'main::@`, you should be in an empty commit on top of `main`. Run `just cleanup-current-workspace`.

And you're done!

## Constraints

- All `gh` commands include `--repo TimoFreiberg/pantoken`.
- Do not push directly; use `just integrate-into-main`.
- Keep the commit message's `Fixes #<N>` line and squash all implementation fixes before integration.
