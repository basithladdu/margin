# Contributing

Short version: fork, branch, change, `claude plugin test .`, then open a PR.

**Run it while you work**

```bash
claude --plugin-dir /path/to/margin
```

Saving a file reloads the mod in that session. A hook that fails prints one dim line in the transcript saying why.

**House rules**
- **No build step, no dependencies.** Plain TypeScript the engine loads as is. Vendored code goes in `hooks/vendor/` with its licence.
- **Leave Claude's replies alone** unless they have a highlight or a marker. A reply with nothing marked must draw exactly as the engine draws it.
- **Local only.** Margin never sends anything off the machine.
- **Test both surfaces.** Tests loop over `terminal` and `desktop`. Say in the PR what you tried in the real app.

**Good first issues:** keyboard shortcuts for the colours, export the notebook as one PDF, colour picker for the sketch pad, highlights in tool output.
