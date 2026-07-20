# WeftCut — agent instructions

Project glossary and domain vocabulary live in [`CONTEXT.md`](CONTEXT.md);
architectural decisions in [`docs/adr/`](docs/adr/).

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Testing

Tests are grouped by runner, not one directory: colocated Vitest unit tests in `src/`, Rust tests in `native/`, Playwright E2E in `apps/desktop/e2e/`. For the full layout map and run commands, see `docs/agents/testing.md`.
