# Claude Memory Daemon

Stop Claude Code from starting every session blind. This daemon watches your conversations in the background and builds a compressed memory file so Claude already knows where files are, what was tried, what failed, what decisions were made, your preferences, project gotchas, and all the tribal knowledge that builds up over weeks of working on a codebase. Zero workflow changes, no vector databases, no RAG. Just a background process and two LLM passes.

**TL;DR:** Install → `claude-memory init` in your project → `claude-memory start` → work normally → Claude remembers everything next session.

## Prerequisites

- **Node.js >= 20** (check with `node -v`)
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** — the daemon uses `claude -p` for processing. Works with a Max plan or an API key connection
- **Linux or macOS** — the optional systemd service only works on Linux, but the daemon itself runs on both

## Quick Start

```bash
# Clone and install
git clone https://github.com/Dekadinious/claude-memory-daemon.git
cd claude-memory-daemon
npm install
npm link    # makes 'claude-memory' command available globally

# Initialize a project
cd ~/my-project
claude-memory init

# Start the daemon
claude-memory start
```

Verify it's working:

```bash
claude-memory status
```

You should see the daemon running and your project listed. Now just use Claude Code normally — memory builds itself.

### What `npm link` does

`npm link` creates a global symlink so you can run `claude-memory` from any directory, not just inside this repo. It's the standard way to install a CLI tool from a local git clone. (For a published npm package, you'd use `npm install -g` instead.)

### Token warning

When you run `claude-memory init` on a project with existing conversations, the daemon catches up on **up to 10 recent conversations** via `claude -p`. Each pass runs through the Claude API.

For projects with long conversation histories, this initial catchup can use a significant number of tokens. To skip it and only process new conversations going forward:

```bash
claude-memory init --no-catchup
```

After the initial catchup, ongoing usage is minimal — conversations are processed with a 5-minute debounce, one at a time.

## What Problem This Solves

Without memory, every Claude Code session starts blind. Claude re-reads files, retries approaches that already failed, forgets architectural decisions from last week. On a complex project, this wastes thousands of tokens per session on rediscovery.

With the daemon running, Claude starts each session already knowing:

- Where important files actually live (especially non-obvious locations)
- What approaches were tried and failed
- Architectural decisions and their reasoning
- Bug root causes and fixes
- Code conventions and project-specific patterns

## What It Feels Like

You won't notice anything different about your workflow. The magic happens between sessions.

1. **You work normally** in Claude Code. Conversations get saved as JSONL files (this already happens — Claude Code does this by default).
2. **The daemon watches** those files in the background. Five minutes after a conversation goes quiet, it processes the new content through an **Observer** — an LLM pass that extracts structured observations (decisions made, files found, dead ends hit, bugs fixed).
3. **Observations accumulate** in `OBSERVATIONS.md` in your project root (right next to `CLAUDE.md`).
4. **Next time you start a Claude Code session**, a SessionStart hook fires automatically. It injects the full observations file into Claude's context. Claude also gets a health check — if the daemon isn't running, you'll see a warning.
5. **Claude already knows things.** You can ask "where's the payment handler?" and Claude goes straight to `app/Services/PaymentWebhookHandler.php` instead of searching through `app/Listeners/` first (because a previous session already discovered it wasn't there).

Over time, if observations grow too large, a **Reflector** pass consolidates them — merging related facts, removing superseded info, grouping by domain — while preserving every specific file path, error message, and technical decision.

## Commands

| Command | What it does |
|---------|--------------|
| `claude-memory init [path]` | Set up a project for memory |
| `claude-memory init --no-catchup` | Same, but skip existing conversations |
| `claude-memory start` | Start the daemon (background) |
| `claude-memory stop` | Stop the daemon |
| `claude-memory status` | Show daemon status and per-project stats |
| `claude-memory list` | List registered projects |
| `claude-memory remove [path]` | Unregister a project (keeps observations) |
| `claude-memory config` | Show project config |
| `claude-memory config set <key> <val>` | Change a setting |
| `claude-memory logs` | Tail daemon logs |
| `claude-memory install-service` | Auto-start on login (systemd, Linux only) |

### Config options

```bash
claude-memory config                                      # show settings
claude-memory config set reflector-threshold 30000         # when to consolidate (tokens)
claude-memory config set reflector-threshold 15000 --project ~/other  # target specific project
```

## What `init` Does

Running `claude-memory init` in a project directory:

1. Registers the project with the daemon (adds it to `~/.claude-memory/projects.json`)
2. Creates `.claude/hooks/session-start.sh` — the hook that injects observations into each session
3. Merges hook config into `.claude/settings.json` (won't overwrite your existing settings)
4. Adds an "Observational Memory" section to `CLAUDE.md` — tells Claude how to use observations
5. Creates empty `OBSERVATIONS.md` in project root — this is where memory accumulates

The daemon detects new projects automatically — no restart needed.

<details>
<summary>What gets added to CLAUDE.md</summary>

```markdown
## Observational Memory

This project uses observational memory. At the start of each session, you
receive an OBSERVATIONS.md file containing compressed knowledge from previous
sessions. These observations include:

- Architectural decisions and their reasoning
- File locations (especially non-obvious ones)
- Dead ends that were explored and didn't work
- Configuration facts and environment details
- Bug root causes and fixes
- Code conventions and patterns

**How to use observations**: Treat these as reliable institutional knowledge. If
observations say a file is at a specific path, go there directly — don't search.
If observations say an approach was tried and failed, don't retry it unless
explicitly asked. If observations mention a convention, follow it.

**If observations seem wrong or outdated**: Trust what you see in the actual code
over observations. The code is the source of truth. But mention the discrepancy
so the observation can be corrected in a future pass.
```

</details>

**Git tracking:** If `OBSERVATIONS.md` is not gitignored, the daemon auto-commits it on each update so you get a full history of how project knowledge evolved. If you'd rather not track it, add it to `.gitignore` and the daemon will skip commits automatically.

## Run as a System Service

For hands-off operation (Linux only):

```bash
claude-memory install-service
```

This creates a systemd user service that auto-starts the daemon on login and restarts it on crash. Recommended setup so you never think about whether the daemon is running.

## How Observations Look

```markdown
# Observations

## Authentication & Users

- Auth middleware is in app/Http/Middleware/AuthenticateApi.php, NOT in the default
  Laravel auth middleware location
- User preferences stored in JSON column on users table, accessed via
  UserPreferenceService (not direct model access)
- Session tokens use Redis with prefix "sess:" and 24h TTL

## Search

- Search uses Meilisearch (migrated from Elasticsearch), config in config/scout.php
- Tried Meilisearch prefix search for autocomplete, too slow over 50k records.
  Switched to PostgreSQL trigram index with pg_trgm

## Dead Ends

- Tried using Laravel queues for enrollment locking, had race condition with
  concurrent requests. Switched to pg_advisory_xact_lock
- Redis cache invalidation via events caused cascade bugs. Switched to simple
  TTL-based expiry
```

## How It Works (Technical)

```
Your Claude Code sessions
    | (JSONL conversation files)
    v
Claude Memory Daemon (single background process)
    | Observer pass (claude -p): extracts observations from new conversations
    | Reflector pass (claude -p): consolidates when observations grow too large
    v
OBSERVATIONS.md (per project, in project root)
    | (injected via SessionStart hook on startup/resume/clear/compact)
    v
Next Claude Code session starts with full context
```

**Per conversation file change (5-minute debounce):**
1. Parse the delta since last processed byte offset
2. Run Observer pass — extract structured observations
3. Append to `OBSERVATIONS.md`
4. Auto-commit if git repo (with `--no-verify`, no auto-push)
5. If observations exceed token threshold → Reflector consolidates
6. Update cursor state

### The Observer

The Observer reads a raw conversation chunk and extracts structured observations. It prioritizes things that save time in future sessions:

1. **Decisions made** and why (not just what was chosen, but what was rejected)
2. **File locations discovered**, especially when they weren't where expected
3. **Dead ends and failed approaches** so Claude doesn't retry them
4. **Configuration and environment facts** (database names, service URLs, credential locations)
5. **Bugs found and their root causes**
6. **Code conventions and patterns** specific to the project
7. **Your preferences and workflow habits**

If a conversation has no meaningful technical substance (just a greeting or a quick question), the Observer returns nothing and no observations are written.

A key design choice: the Observer **never sees the existing observations file**. It only sees the conversation delta. This keeps each pass independent, prevents the Observer from editorializing or restructuring what's already been recorded, and makes the output more predictable. The daemon handles appending.

### The Reflector

The Reflector runs infrequently, only when OBSERVATIONS.md crosses a token threshold (default 20k). Its job is to compress without losing information:

- **Merge related observations** from different sessions into single richer entries
- **Remove superseded info** (if search was migrated from Elasticsearch to Meilisearch, drop the Elasticsearch observation and keep only the current truth with a note about what changed)
- **Drop resolved dead ends** (if a dead end was explored and a solution found, keep the solution with a brief note about what didn't work)
- **Group by domain** using whatever grouping makes sense for the actual content
- **Preserve every specific file path, error message, and technical decision**. The Reflector is explicitly told never to summarize specifics into vague generalizations

The target is 30-50% size reduction while losing zero actionable information. The output is still a structured list of observations, not a narrative summary.

### Other details

**Hot reload:** The daemon watches its own config. Projects added via `claude-memory init` are picked up immediately without restart.

**File locking:** The Reflector acquires a lock before rewriting OBSERVATIONS.md. The Observer waits and retries if locked. This prevents corruption when both need to touch the same file.

**Concurrency:** One Observer pass runs at a time per project. If a new file change comes in while processing, it gets picked up on the next cycle.

## File Structure

```
~/.claude-memory/               Global daemon state
├── daemon.pid                  Process lock (prevents duplicate daemons)
├── daemon.log                  All daemon output
├── projects.json               Registered projects and their config
└── state/<hash>/
    └── observer-state.json     Per-file byte offsets and processing stats

your-project/                   Per-project (created by init)
├── .claude/
│   ├── settings.json           Hook config (merged, not overwritten)
│   └── hooks/session-start.sh  Injects observations + daemon health check
├── OBSERVATIONS.md             The memory file (auto-committed if not gitignored)
└── CLAUDE.md                   Observational Memory instructions added
```

## Troubleshooting

**`claude-memory start` says "claude CLI not found"**
The `claude` command isn't in your PATH. Make sure Claude Code is installed and you can run `claude --version`.

**Daemon is running but no observations appear**
- Check `claude-memory logs` for errors
- Make sure you've had a conversation in the project after running `init` — the daemon only processes new content (or catchup on init)
- The 5-minute debounce means observations won't appear immediately. Wait a few minutes after your conversation ends.

**SessionStart hook doesn't fire**
- Verify the hook exists: `cat .claude/hooks/session-start.sh`
- Verify settings.json has the hook config: `cat .claude/settings.json`
- Try `/clear` in your Claude Code session — the hook fires on clear/compact too, not just startup
- There's a known bug (#10373) where hooks may not fire on brand-new sessions. Workaround: `/clear` at the start.

**"CLAUDE MEMORY DAEMON IS NOT RUNNING" warning in sessions**
Run `claude-memory start`, or set up the systemd service with `claude-memory install-service` so it starts automatically.

**Observations seem stale or wrong**
The code is always the source of truth. If an observation contradicts what you see in the code, trust the code. The next Observer pass will eventually capture the correction. You can also manually edit `OBSERVATIONS.md`.

## Uninstalling

**Remove from a single project:**

```bash
cd ~/my-project
claude-memory remove
# Then optionally clean up the files init created:
rm .claude/hooks/session-start.sh
rm OBSERVATIONS.md
# Manually remove the SessionStart hook entry from .claude/settings.json
# Manually remove the "Observational Memory" section from CLAUDE.md
```

**Remove entirely:**

```bash
claude-memory stop

# Remove systemd service (if installed)
systemctl --user stop claude-memory
systemctl --user disable claude-memory
rm ~/.config/systemd/user/claude-memory.service
systemctl --user daemon-reload

# Remove global state
rm -rf ~/.claude-memory

# Remove the global command
npm unlink -g claude-memory-daemon

# Delete the repo
rm -rf /path/to/claude-memory-daemon
```

## Known Limitations

- **Claude Code auth required.** The Observer and Reflector passes use `claude -p`. Works with a Max plan (counts against usage) or an API key (billed per token). Passes are small (5-20k token inputs) and infrequent.
- **Large conversations.** 500KB+ conversations can take several minutes per Observer pass. Timeout is 10 minutes.
- **Token estimation.** Uses `chars / 4` approximation for the Reflector threshold. This is rough but sufficient.
- **No Windows support.** The systemd service is Linux-only. The daemon itself should work on macOS and Linux but hasn't been tested on Windows.
- **OBSERVATIONS.md grows until consolidated.** The Reflector only runs when the file exceeds the token threshold (default 20k tokens). Until then, observations append without deduplication.

## Background

Based on [Mastra's observational memory architecture](https://venturebeat.com/ai/observational-memory-cuts-ai-agent-costs-10x-and-outscores-rag-on-long-context-benchmarks/). Instead of RAG with vector databases, we compress conversation history into a dated observation log using two LLM passes (Observer + Reflector) and keep it in context. No retrieval needed.

## License

MIT
