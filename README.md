<div align="center">

# `codex-multi`

Multiple Codex accounts. One command. One shared skills setup.

`codex-personal` · `codex-work` · `codex-client`

</div>

Codex Multi gives every Codex account its own launcher and isolated
login while keeping your existing config, skills, plugins, rules, MCP servers,
memories, and sessions shared.

```bash
$ npx codex-multi add --name Personal --slug personal
Sign in to the Codex account for "Personal".
...
Added Personal. Launch it with: codex-personal

$ npx codex-multi add --name Work --slug work
$ codex-personal
$ codex-work exec "review this repository"
```

Profiles do not overwrite `~/.codex/auth.json`. Each launcher sets a different
`CODEX_HOME`, so two accounts can run concurrently without a global “active
account” race.

Different profiles run concurrently. A single profile is lifecycle-locked
while its Codex process is active so login, rename, or removal cannot replace
credentials underneath that process.

## Install skills once, use them everywhere

Your Codex skills stay in the normal `~/.codex/skills` directory. Codex Multi
links that same directory into every managed profile, so a skill installed once
is immediately available from `codex-personal`, `codex-work`, and every other
account alias.

The same sharing model covers rules, plugins, MCP configuration, memories, and
sessions. Only credentials, generated profile config, and process-local runtime
files stay isolated. You get separate accounts without maintaining separate
toolboxes.

## Install

Requires Node.js 18+ and the official [`codex`](https://www.npmjs.com/package/@openai/codex)
CLI on `PATH`.

### npx

```bash
npx codex-multi add
```

There is no install step. After login, launch the generated alias directly:

```bash
codex-personal
```

Launchers created from an npx run pin the manager version that created them,
so they keep working after npm clears its temporary cache without silently
adopting future code. Run `npx codex-multi sync` with a newer release to upgrade
them.

### Global install

For faster launcher startup and offline use:

```bash
npm install -g codex-multi
cpm add
```

Both `cpm` and `codex-multi` invoke the manager after a global install. Account
launchers always use the `codex-<slug>` form.

### From source

```bash
git clone https://github.com/nhocconan/codex-multi.git
cd codex-multi
npm install
npm run verify
npm install -g .
```

Launchers are installed into a writable directory on `PATH`, preferring
`~/.local/bin`. If that directory is not on `PATH`, the tool prints the exact
line to add to your shell profile.

## Quick start

```bash
# Browser login
cpm add --name Personal --slug personal

# Device-code login for a remote/headless terminal
cpm add --name Work --slug work --device-auth

# Import the login already stored in ~/.codex/auth.json
cpm import --name Current --slug current

# See all launchers
cpm list

# Use an account anywhere normal codex works
codex-personal
codex-work exec "fix the failing tests"
codex-work review
codex-personal resume --last
```

Running `cpm` with no arguments opens an interactive profile picker.

## Commands

| Command | Purpose |
|---|---|
| `cpm` | Interactive picker |
| `cpm add` | Create a profile and run `codex login` |
| `cpm import` | Copy the current file-based Codex login into a profile |
| `cpm list` | Show profiles and safe login metadata |
| `cpm launch <slug>` | Launch a profile and pass all remaining args to Codex |
| `cpm use <slug>` | Alias for `launch` |
| `cpm login <slug>` | Replace a login; restores the old one if login fails |
| `cpm edit <slug>` | Change the label or `codex-<slug>` command |
| `cpm remove <slug>` | Delete one profile and its isolated credentials |
| `cpm sync` | Rebuild profile config and launcher scripts |
| `cpm doctor` | Audit auth, isolation, duplicate credentials, and launchers |

Common options:

```text
--name, -n <label>
--slug, -s <suffix>
--device-auth
--api-key-env <ENV_NAME>
--access-token-env <ENV_NAME>
```

Secrets are deliberately accepted through environment variable names instead
of literal flags, keeping them out of shell history and process listings:

```bash
export MY_CODEX_API_KEY="..."
cpm add --name API --slug api --api-key-env MY_CODEX_API_KEY
unset MY_CODEX_API_KEY
```

## How it works

OpenAI documents that Codex stores file-based credentials in
`$CODEX_HOME/auth.json` and that `CODEX_HOME` defaults to `~/.codex`.
Codex Multi uses that supported boundary:

```text
~/.config/codex-multi/
├── profiles.json
└── profiles/
    ├── personal/
    │   ├── auth.json       real file: Personal credentials
    │   ├── config.toml     regenerated config, credential store forced to file
    │   ├── skills -> ~/.codex/skills
    │   ├── sessions -> ~/.codex/sessions
    │   └── ...             other non-auth state shared from ~/.codex
    └── work/
        ├── auth.json       real file: Work credentials
        └── ...

~/.local/bin/
├── codex-personal
└── codex-work
```

On every launch the manager:

1. verifies the profile has usable credentials;
2. refreshes links to the base Codex home;
3. regenerates `config.toml` from the current base config and forces
   `cli_auth_credentials_store = "file"`;
4. removes competing auth environment variables;
5. starts the current `codex` binary with the profile’s `CODEX_HOME`;
6. relays signals and returns Codex’s exit code.

Codex can refresh its tokens normally because each profile’s `auth.json` is a
real writable file. Process-local directories such as `ipc`, `process_manager`,
and temporary files also stay private to each profile. The registry contains
labels and slugs only—never tokens.

See OpenAI’s [Codex authentication documentation](https://developers.openai.com/codex/auth)
for the credential-storage contract and security guidance.

## Importing the current account

`cpm import` reads `~/.codex/auth.json`. If Codex is configured to keep
credentials only in the OS keyring, there may be no file to import. Create a
file-based login first:

```bash
codex -c 'cli_auth_credentials_store="file"' login
cpm import --name Current --slug current
```

Treat every managed `auth.json` like a password. They are written with mode
`0600` on Unix and must never be committed, pasted into issues, or shared.

## Environment overrides

These are useful for testing or nonstandard installations:

| Variable | Meaning |
|---|---|
| `CODEX_MULTI_HOME` | Manager state root |
| `CODEX_MULTI_BASE_HOME` | Shared base Codex home (default `~/.codex`) |
| `CODEX_MULTI_BIN_DIR` | Launcher directory |
| `CODEX_MULTI_CODEX_BIN` | Exact Codex executable |

## Design boundaries

- This tool manages Codex CLI accounts. It does not switch the desktop app.
- Codex configuration profiles selected by `codex --profile` customize model
  and sandbox settings; they are separate from the account profiles managed
  here.
- Non-auth Codex state is intentionally shared. If you need fully isolated
  histories and plugins, set up separate `CODEX_HOME` directories directly.
- Launchers never replace an unrelated existing `codex-<slug>` file. `cpm
  doctor` reports the collision.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The published CLI keeps its runtime surface small: `cross-spawn` safely runs
Codex’s Windows `.cmd` shim, and `proper-lockfile` protects profile lifecycle
operations across processes and recovers stale locks after crashes.

## License

MIT
