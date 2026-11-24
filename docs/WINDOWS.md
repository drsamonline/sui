# Windows, from nothing

**`npx sui` will not work** — the package is published as `@drsamonline/cli`, so the bare name `sui` resolves to nothing (or to somebody else's package). Either run it from this folder with the wrapper script that ships with the code, or use `npx @drsamonline/cli`.

Follow this once. After it, everything is one command.

---

## 1. Install Node.js

1. Open https://nodejs.org
2. Click the big **LTS** button, download the **Windows Installer (.msi)**, 64-bit
3. Run it, click Next through everything
4. On "Tools for Native Modules", **leave the checkbox unticked** — Sui has no native dependencies

**Close any PowerShell window you had open.** The new `node` command only appears in new windows.

Check it:

```powershell
node -v
```

You want `v20` or higher. If you see *"node is not recognised"*, the installer did not finish, or this window predates it.

## 2. Get the code

**Without Git:** https://github.com/drsamonline/sui → green **Code** button → **Download ZIP** → right-click the zip → **Extract All** → `C:\Users\YourName\Documents\sui`.

Watch for `sui\sui-main\` — a folder inside a folder. You want the one that directly contains `package.json`.

**With Git:** `git clone https://github.com/drsamonline/sui.git` in `Documents`.

## 3. Open PowerShell in that folder

Open the folder in File Explorer, click the **address bar**, type `powershell`, press Enter.

Check you are in the right place:

```powershell
ls
```

You should see `package.json`, `apps`, `packages`, `docs`, and `sui.cmd`.

## 4. Run the setup script

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

It checks Node, links the workspace packages, and proves the CLI runs. There is nothing to download — the project has zero third-party dependencies — so this takes a few seconds.

You should end with:

```
  Ready.

  From now on, run Sui with the wrapper in this folder:

    .\sui.cmd doctor
```

---

## 5. Use it

From that folder, always with `.\`:

| Command | What it does |
|---|---|
| `.\sui.cmd` | first run: find keys, find tools, prove the route, start |
| `.\sui.cmd doctor` | one real turn per combo |
| `.\sui.cmd start` | run the gateway on http://127.0.0.1:8787 |
| `.\sui.cmd catalog` | the provider catalogue |
| `.\sui.cmd probe --write` | verify endpoints and promote what answers |
| `.\sui.cmd local` | find Ollama or LM Studio on this machine |
| `.\sui.cmd cost` | what you have spent |
| `.\sui.cmd tenants` | what each API key spent |
| `.\sui.cmd recipe list` | named config patches |

In **PowerShell** use `.\sui.ps1` instead of `.\sui.cmd` — both work. If PowerShell blocks scripts, use `.\sui.cmd`, which is a batch file.

**In CMD** (not PowerShell), `.\sui.cmd` works too.

---

## Why not `npx sui`?

`npx` downloads a package from npm by its exact name, and this one is scoped: `@drsamonline/cli`. The bare `sui` is a different name, so `npx sui` downloads something else or nothing.

| Want | Do this |
|---|---|
| run it from this folder | `.\sui.cmd <command>` — no npm account needed |
| a global `sui` command | `npm link` in the folder, then `sui <command>` anywhere |
| the published copy, no checkout | `npx @drsamonline/cli <command>` |

`npm link` is the middle option and takes one command:

```powershell
npm link
sui init      # writes a config and proves the route
sui doctor    # then tests every combo against your key
```

`init` first, always: `doctor` needs a config to test, and a config is what `init` writes.

---

## Troubleshooting

| Message | Meaning | Fix |
|---|---|---|
| `'node' is not recognised` | Node missing, or this window is older than the install | install Node, **reopen** PowerShell |
| `running scripts is disabled on this system` | PowerShell script policy | use `.\sui.cmd`, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `Cannot find package '@drsamonline/gateway'` | the workspace links are missing | run `npm install` in the folder |
| `package.json is not here` | you are one folder too high | `cd` into the folder that has `package.json` |
| `.\sui.cmd : cannot be found` | you are not in the Sui folder | `cd` to it, or use the full path |
| port 8787 already in use | something else is on it | `.\sui.cmd start --port 8788` |
| `npx sui` returns 404 or installs something odd | the package is `@drsamonline/cli` | use `npx @drsamonline/cli`, or `.\sui.cmd` |
| `sui eval` says "not meaningful" (exit 2) | no route answered | `sui doctor`, then `sui probe --write` |

---

## What it needs from you

| Step | Command |
|---|---|
| one provider key (free) | from https://console.groq.com, then `$env:GROQ_API_KEY="…"` |
| verify the endpoints | `.\sui.cmd probe --write` |
| record an eval baseline | `.\sui.cmd eval --update-baseline` |
| see it | `.\sui.cmd start`, then http://127.0.0.1:8787/ |
