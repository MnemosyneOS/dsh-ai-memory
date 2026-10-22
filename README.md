# dsh-ai-memory

**Mnemosyne OS 8.1.0 memory for DeepSeek Harness — auto-register, auto-remember, auto-recall.**

One command, one click in the browser, and your DSH sessions remember across restarts.
52 MCP tools (write, recall, knowledge graph, memory formation layer) with no glue code.

---

## Install (30 seconds)

```bash
dsh plugin add github:MnemosyneOS/dsh-ai-memory
dsh-ai-memory-login
```

Restart `dsh web`. That's it.

> Requires Node 18+ and [pnpm](https://pnpm.io) on PATH (`dsh plugin` calls pnpm under the hood).

## First authorization (Device Flow)

`dsh-ai-memory-login` prints a short link:

```
请在浏览器打开下面这个地址完成授权：

    https://ai-memory.net/api/device/confirm?code=ABCD2345
```

Open it, sign in, click **授权**. The command then:

1. receives a `mn-` key bound to **your** namespace,
2. writes exactly one line (`Authorization: Bearer mn-…`) into your profile's `cordis.patch.yml`,
3. backs the file up first as `.bak-dsh-ai-memory`,
4. never touches any other line — your comments and other MCP servers stay byte-identical.

The key is shown as `mn-Abcd****wxyz`; the full value is never logged.

## What it gives you

The plugin registers one MCP server (`mnemosyne`, streamable HTTP at `https://ai-memory.net/v1/mcp`),
which exposes the full Mnemosyne OS tool surface. Commonly used:

| Tool | What it does |
|---|---|
| `retain` / `retain_batch` | Write memories (content / type / tags / confidence / importance) |
| `recall` | Five-channel recall with token budget and compression |
| `forget` | Soft forget: confidence → 0, marked deleted, still auditable |
| `capsule` / `expand` | Compress a memory to pointer + fact atoms; expand back and verify its hash |
| `recall_catalog` / `expand_memory` | Progressive disclosure: titles first, full text on demand |
| `graph_query` / `temporal_query` | Walk the knowledge graph; return version chains by time |
| `memory_inject` / `profile_card` | Build injectable context within a token budget |
| `session_summarize` / `topic_summarize` | Session and project-level summaries |
| `conflict_resolve` | Six conflict classes, four resolution operations |
| `code_change_record` / `code_archaeology` | Record intent, constraints and rejected approaches; archaeology on past changes |

Then in any session: *"记住：我叫张三，乳糖不耐"* — and in a brand-new session,
*"我喝咖啡要注意什么"* gets the right answer.

## Privacy & data

- **Where data lives.** In your Mnemosyne namespace on ai-memory.net, isolated per account.
- **Isolation is server-side.** The namespace is decided by the server from your session
  (`default` for administrators, `u_<sha256(email)[:16]>` for members). A namespace supplied
  by a client is ignored. Another user's key cannot reach your memories.
- **Keys.** Only SHA-256 digests are stored; the plaintext exists once, at issuance.
  Revoke or regenerate keys in the ai-memory.net console.
- **Delete / opt out.** `dsh plugin remove dsh-ai-memory` removes the plugin; run
  `dsh-ai-memory-login --remove` to strip the profile entry, and delete the namespace from the
  console to erase stored memories. The DSH-side config file is yours: the login tool only ever
  edits one line, keeps a `.bak-dsh-ai-memory` backup, and rolls back if its own check fails.
- **No telemetry.** The plugin talks to ai-memory.net only (device flow + MCP). Nothing else.

## Uninstall

```bash
dsh-ai-memory-login --remove          # drop the MCP entry from your profile
dsh plugin remove dsh-ai-memory       # remove the package
```

Restart `dsh web`.

## Options

```
--profile <name>   target DSH profile (default: web)
--file <path>      point at a cordis.patch.yml directly
--base-url <url>   override the service base URL (default https://ai-memory.net)
--no-browser       do not try to open the browser automatically
--remove           strip the entry this plugin wrote
-h, --help         help
```

Exit codes: `0` success / already configured · `1` failure · `2` cancelled or timed out.

## Development

```bash
node test/login.test.mjs   # 26 checks: protocol + idempotent profile writes
```

## License

MIT © MnemosyneOS
