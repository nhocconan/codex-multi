const ISOLATED_VARIABLES = new Set([
  "CODEX_HOME",
  "CODEX_ELECTRON_USER_DATA_PATH",
  "CODEX_DESKTOP_RELAUNCH_OPEN_EVENTS",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "OPENAI_FEDERATION_RULE_ID",
  "OPENAI_IDENTITY_TOKEN_FILE",
]);

export function buildProfileEnv(home: string, excludedNames: string[] = []): NodeJS.ProcessEnv {
  const excluded = new Set([...ISOLATED_VARIABLES, ...excludedNames.map((name) => name.toUpperCase())]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!excluded.has(key.toUpperCase())) env[key] = value;
  }
  env.CODEX_HOME = home;
  return env;
}
