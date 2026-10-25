# Variables — Claude Onboarding

## What it is

An Obsidian plugin that shows note properties in place of `{{name}}` placeholders, in Reading view and Live Preview, and fills them in when code is copied. Values can come from the note, from notes linked in `vars_from`, or from a global note, and `{{link.prop}}` reads a property of a linked note. User docs are in `README.md`.

## Build / run / deploy

There is **no build step**. `main.js` is the source: plain CommonJS JavaScript that only `require`s `obsidian`, `@codemirror/view`, `@codemirror/state` and `@codemirror/language`, which Obsidian provides at runtime (plus Node's `os` for the network interface command, desktop only). There is no `package.json` and nothing to install.

Deploy to a vault, then turn the plugin off and on in Settings → Community plugins:

```bash
VAULT="/path/to/your/vault"
cp main.js manifest.json styles.css "$VAULT/.obsidian/plugins/local-variables/"
```

Make changes here and copy them into the vault, not the other way round. `data.json` (settings) belongs to the vault and is ignored by git.

There is **no automated test suite**. Verify inside Obsidian with a throwaway note in both Reading view and Live Preview: prose, inline code, a code block, a callout, a table, a secret, and the copy button. Delete the note afterwards.

## Key invariants and gotchas

- **The file always keeps `{{name}}`.** Rendering never writes to the note; only the commands do (set, mark secret, turn selection into a variable).
- **Code blocks are highlighted after post-processors run**, which rebuilds their HTML and throws replacements away. `afterHighlight()` waits for the code element's `is-loaded` class (1 s timeout), and `replaceAcrossNodes()` handles placeholders that highlighting split across text nodes.
- **Obsidian's copy buttons copy the raw source**: the Reading-view copy button and the Live Preview `.code-block-flair` label. Both clicks are intercepted (capture phase) to copy filled-in text, and so is ⌘C inside a code block.
- **Live Preview** uses a CM6 `ViewPlugin` with `Decoration.replace` widgets, skipped while the cursor is inside the placeholder. Values drawn by the post-processor inside callouts and tables are tracked as `WeakRef`s in `liveChips` and refreshed in place when properties change.
- **Secrets are declared, not guessed.** A value is secret when the reading note's `vars_secret` lists it OR the defining note's does. Guessing from names is a setting and off by default; the owner asked for it that way. The Properties panel is blurred with the generated `<style id="local-variables-secrets">` plus a `data-lv-secrets` attribute on each leaf.
- **Control keys** (`vars_from`, `vars_secret`) are never variables. **Reserved properties** (`tags`, `status`, `note_type`, …, see `RESERVED`) only resolve in their own note, never inherited or global.
- **`selectionToVariable` guards its input**: it needs a non-empty single-line selection, checks the selection is unchanged after the prompt, and its search loop always advances. An empty string once made `indexOf('')` loop forever and froze Obsidian. When testing live, run commands through the command palette path, never call a command's function directly past its `checkCallback`.
- **The plugin id starts with `local-`** so it can never match a community-store plugin and get "updated" into someone else's code.

## Conventions

- Tabs for indentation, single quotes, `'use strict'`, files end with a newline.
- No dependencies and no network access.
- User-visible strings: sentence case, no emoji. Everything reachable from the command palette.
- Bump `version` in `manifest.json` and add it to `versions.json` when behaviour changes.
