# Project-local Polytoken configuration

This directory is tracked so contributors and agents get the same project-local
harness configuration.

## Playwright MCP

The `playwright` MCP server uses Microsoft's `@playwright/mcp` package and
launches an isolated Chromium context. It is disabled at startup so ordinary
sessions do not spawn a browser. Enable it from Polytoken with `/mcp` when
interactive browser inspection or control is useful.

The server does not start the Pantoken app itself. Start the isolated mock
preview first, for example with the repository's preview tooling or:

```sh
PANTOKEN_DRIVER=mock PANTOKEN_AUTO_PORT=1 bun run dev
```

Then navigate the MCP browser to the preview URL. Do not point it at a
production or live-daemon URL unless that is deliberate and authenticated.

`.polytoken/hooks/` is ignored because hooks may be generated or machine-local.
