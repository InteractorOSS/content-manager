# Interactor CMS Sync (Obsidian plugin)

Phase 3, rung 2 of `FILE-BASED-CONTENT-PLAN.md`'s desktop sync ladder — pulls CMS posts
into your vault as Markdown + frontmatter, pushes edits back. Same engine and API as
`scripts/cms-sync.ts` (the CLI), same conflict semantics (a 409 means someone else
changed the post since you last pulled it — pull again before pushing).

## Setup

1. In the CMS, create a personal access token at `/settings/tokens`.
2. `npm install && npm run build` in this directory — produces `main.js`.
3. Copy `manifest.json` and `main.js` into `<your vault>/.obsidian/plugins/interactor-cms-sync/`.
4. Enable "Interactor CMS Sync" under Settings → Community plugins in Obsidian.
5. Open the plugin's settings tab: set the CMS base URL and paste the token.

## Commands

- **Pull posts from CMS** (ribbon icon or command palette) — downloads every post into
  the configured sync folder (default `content/posts`).
- **Push current file to CMS** — imports the active file if it's a `.md` with CMS
  frontmatter; writes the server-assigned `id`/`content_hash` back into the file.
- **Push all changed files in sync folder to CMS** — same, for every file in the folder.

## Status

Built and typechecked against the real `obsidian` npm package's type definitions, and
the esbuild bundle was verified (valid syntax, `obsidian` correctly externalized,
`gray-matter`/`jszip` correctly bundled). **Not** verified inside an actual running
Obsidian instance — this environment has no desktop GUI to load a real vault into. Load
it into a test vault and try Pull/Push before trusting it against real content.
