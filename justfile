# Default recipe — show available commands
default:
    @just --list

# Spawn a polytoken TUI agent to implement a GitHub issue.
# Usage: just implement-issue <issue-url>
#        just implement-issue --dry-run <issue-url>  (print commands, don't execute)
implement-issue *args:
    bun run scripts/implement-issue.ts {{args}}

# Integrate the current workspace's commits onto main.
# Acquires a repo-local lock, pulls, rebases, tests, pushes.
# Exit codes: 0=success, 2=conflicts (lock held, resolve and retry), 1=error
integrate-into-main issue-number:
    scripts/integrate-into-main.sh {{issue-number}}

# Create an issue workspace from the default jj workspace.
# Usage: just create-workspace <name> [revision]
create-workspace name revision="main":
    scripts/create-workspace.sh {{name}} {{revision}}

# Clean up the current integrated issue workspace (must run inside it).
# Usage: just cleanup-current-workspace
cleanup-current-workspace:
    scripts/cleanup-current-workspace.sh

# Legacy manual name-based cleanup; prefer cleanup-current-workspace.
# Usage: just cleanup-workspace <workspace-name>
cleanup-workspace workspace-name:
    scripts/cleanup-workspace.sh {{workspace-name}}
