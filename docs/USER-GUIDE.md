# Evolv 0.6.5 User Guide

Evolv is a chat app that runs on your own computer. Conversations, files and
everything it remembers stay in a local database. Nothing is sent anywhere
unless you connect a cloud provider and allow it.

## Getting started

Open `Evolv.exe` (or the AppImage on Linux). On first launch you create a local
account with a password of at least 12 characters, and Evolv shows you a
one-time recovery code. Save that code somewhere outside Evolv — it is the only
way back in if you forget the password, and Evolv only keeps a hash of it.

Each account has its own conversations, projects, memory, settings and backups.

You also need at least one model. If Ollama is running but empty, Evolv offers
to install **Evolv Local** for you and picks the size that fits your computer's
memory and free disk space. See [EVOLV-LOCAL.md](EVOLV-LOCAL.md).

## Chatting

Type and press Enter. Shift+Enter starts a new line.

Pick a provider and model at the top, or leave it on **Auto** and Evolv chooses.
Auto always tells you what it picked and why. Cloud providers are never
considered until you allow them under **Settings → Answers**.

The star beside the model list adds a model to your favourites, which group at
the top. Favourites are per provider, so starring `llama3` under Ollama does not
star a similarly named model somewhere else.

Models are labelled with what they can do — 🔧 tools, 👁 images, 🧠 reasoning —
and local models are labelled with whether they fit in this computer's memory.
**⚠ too big for this computer** means it needs more memory than you have and may
fail to load. **⚠ tight fit** means it will load but leave little room, which
shows up as slowness in long conversations. Neither is a block; both are shown
when you select the model rather than after a reply has already failed.

Evolv also remembers how each model behaved last time. A model that fails twice
in a row for its own reason — not installed, out of memory, no tool support, out
of context — is labelled with that reason, and Auto routes around it. One
failure is treated as a bad moment, and any successful reply clears the record.
Failures that are not the model's fault, like Ollama being shut down or a
rejected API key, are never counted against it.

### When a question is really a job

Some questions take more than one answer. If you ask Evolv to check something
across a whole project, or to establish a fact rather than recall one, it works
through it in several steps instead of replying off the top of its head: it
looks things up, reasons over what it found, and checks the result against what
you asked for before answering.

You do not turn this on and there is no form to fill in. It happens in the
conversation, and the steps appear under the reply as they finish. If the answer
does not meet one of its own checks, it says so rather than burying it.

Evolv is deliberately reluctant about this — an ordinary question gets an
ordinary answer, because a two-minute plan-and-verify cycle is not what you
wanted when you asked what a mutex is. It also needs something to work over, so
it only happens when a project folder or an Obsidian vault is connected.

Anything that would **change** a file always stops and asks first.

You can switch it off entirely under **Settings → Answers**.

### Commands

Type `/` in the message box to see them. They are handled inside Evolv and never
sent to a model:

- `/sandbox` — review changes tried in a private copy of your project
- `/physics` — a small world with gravity that Evolv can build in
- `/lab` — time, weather and open work at a glance
- `/demo` — watch Evolv run a real experiment on itself

## Projects

A project keeps a folder, its sources, its tasks and its conversations together.
Evolv can only reach the folder you explicitly connect to a project, and it
still needs your approval before changing anything inside it.

**Load verified demo** creates a real local project with tasks and indexed
evidence, so you can see how it works before pointing Evolv at your own files.
Remove it like any other project.

## Settings

Everything else lives in one place, in four sections.

**Answers** — which model replies, whether Evolv picks for you, which cloud
providers are allowed to see your notes and your files (both off to start with),
a monthly cloud spending limit, and whether Evolv breaks bigger questions into
steps.

**Memory** — everything Evolv has read or noticed, and everything it wants to
remember. Nothing enters its memory until you approve it, and you can edit any
proposal before you do. Connect an Obsidian vault here if you keep one.

**Tools** — what Evolv can do besides answer: read files, search your notes,
look things up. Every use is recorded, and you can see exactly what it ran and
when. You can also describe something you do often and have Evolv bundle
existing tools into one shortcut. It cannot write code, run commands, install
anything, or grant itself new permissions.

**Learning** — why each model was picked, how your rated answers actually went,
problems that keep coming back, and a way to test a change to Evolv's behaviour
against its current behaviour before keeping it. Every number here comes from
work Evolv already did; no second model is asked to judge the first.

## Backups and recovery

Open Settings and create a backup before any major change. Evolv also backs up
daily and keeps the ten most recent. Portable exports leave out passwords,
recovery hashes, API keys, vault paths and folder grants.

See [RECOVERY.md](RECOVERY.md) for account recovery, interrupted work, database
checks and rollback.

## Installing on Windows

Extract the whole ZIP before launching `Evolv.exe` — do not run it from inside
the ZIP. Personal builds are unsigned, so Windows SmartScreen will warn you;
choose **More info → Run anyway**. When replacing the program folder, keep
`%APPDATA%\Evolv`, which is where your data lives.

## Installing on Linux

The AppImage is self-contained. Make it executable and run it:

```bash
chmod +x Evolv-0.6.5-x86_64.AppImage
./Evolv-0.6.5-x86_64.AppImage
```

To build it yourself, do so on Linux so the native SQLite module and the
executable bit are genuine:

```bash
npm install
npm test
npm run dist:linux
npm run linux:validate
```
