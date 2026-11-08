// The Interactor CMS plugin for Claude Code / the Claude desktop app's
// Code tab. One install gives a writer the CMS connection (this app's /api/mcp,
// OAuth sign-in) plus the live-editing workflow, so it is the primary way the
// CMS UI tells people to connect Claude. It lives in its own PUBLIC repo,
// github.com/InteractorOSS/cms-claude-plugins (marketplace "interactor"): this
// repo is private, and `/plugin marketplace add` has to be able to read it.

export const WRITING_PLUGIN_MARKETPLACE = "InteractorOSS/cms-claude-plugins";
export const WRITING_PLUGIN_ID = "interactor-cms@interactor";

export const WRITING_PLUGIN_COMMANDS = [
  `/plugin marketplace add ${WRITING_PLUGIN_MARKETPLACE}`,
  `/plugin install ${WRITING_PLUGIN_ID}`,
] as const;

/** Admin setup (managed settings for a whole team) is documented in the plugin repo. */
export const WRITING_PLUGIN_TEAM_SETUP_URL =
  "https://github.com/InteractorOSS/cms-claude-plugins#set-it-up-for-your-whole-team-admins";
