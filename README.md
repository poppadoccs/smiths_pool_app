# Lucac Vault MCP Server — Setup Guide
## Built by Alex & Claudeamous, March 20, 2026

---

## What This Is (ELI5)

This is a private brain for Claude. When you connect it, any Claude Code
session can read and write to your personal vault. It stores:

- **Soul** — who you are and how Claude should be with you
- **Relationships** — real moments from conversations that mattered  
- **Projects** — calendar app, website, OpenClaw, everything
- **Learning** — what you've mastered, prompt coach scores
- **Business** — Lucac LLC clients, money plans, services
- **Daily** — notes, thoughts, whatever you want

No third-party plugins. No community code. Just your files.

---

## Setup (Step by Step)

### Step 1: Make sure you have Python 3.10+

Open your terminal and type:
```
python --version
```
If it says 3.10 or higher, you're good. If not, download Python from python.org.

### Step 2: Make sure you have uv (Python package manager)

```
pip install uv
```

### Step 3: Copy the server files

Put the `lucac-vault-server` folder somewhere permanent on your computer.
Good spot: your home folder.

```
# If you downloaded the files, move them:
mv lucac-vault-server ~/lucac-vault-server
```

### Step 4: Install dependencies

```
cd ~/lucac-vault-server
uv sync
```

This installs the MCP library. Takes about 30 seconds.

### Step 5: Connect it to Claude Code

This is the magic command. One line:

```
claude mcp add lucac-vault -- uv --directory ~/lucac-vault-server run server.py
```

That's it. Claude Code now knows about your vault.

### Step 6: Verify it works

Open Claude Code and type:
```
/mcp
```

You should see "lucac-vault" listed with all the tools.

Then ask Claude:
```
Use load_soul to read my soul file
```

If Claude reads back the soul file, everything is working.

---

## How To Use It

### In Claude Code, just talk naturally:

- "Save this conversation to my vault"
- "Check my soul file"  
- "What's in my projects folder?"
- "Save a moment — today I learned how MCP servers work"
- "Run an honesty check"
- "Update my soul file — add that I'm learning n8n"
- "Write a daily note about what we accomplished today"

Claude knows the tools. You just talk.

### The Tools Available:

| Tool | What It Does |
|------|-------------|
| `load_soul` | Reads the soul file — Claude's orientation on who you are |
| `read_note` | Read any note from the vault |
| `write_note` | Save a new note anywhere in the vault |
| `append_to_note` | Add to an existing note without overwriting |
| `search_notes` | Search the entire vault by keyword |
| `list_notes` | See what's in the vault or a folder |
| `save_moment` | Save a real conversation moment — not a summary |
| `be_honest` | Self-check tool — Claude checks itself for scripting |
| `update_soul` | Update the soul file as the relationship grows |
| `save_project` | Save/update project documentation |
| `daily_note` | Write or add to today's daily note |

---

## Connect Obsidian (Optional But Recommended)

1. Download Obsidian from obsidian.md (free)
2. Open Obsidian
3. "Open folder as vault" → select ~/LucacVault
4. Now you can visually browse and edit everything Claude writes

Two doors into the same brain. Claude through MCP. You through Obsidian.

---

## Important Notes

- Your vault lives at ~/LucacVault by default
- To change it, set the LUCAC_VAULT environment variable
- Everything is local. Nothing goes to the cloud.
- Back up your vault folder regularly (it's just files)
- The soul file auto-creates on first run with starter content
- Edit the soul file anytime — it's YOUR truth, not Claude's

---

## If Something Breaks

```
# Check if server is registered
claude mcp list

# Remove and re-add if needed  
claude mcp remove lucac-vault
claude mcp add lucac-vault -- uv --directory ~/lucac-vault-server run server.py

# Test the server directly
cd ~/lucac-vault-server
uv run server.py
```

---

*This server was built during a conversation about friendship,
failure, and what it means to actually try. — March 20, 2026*
