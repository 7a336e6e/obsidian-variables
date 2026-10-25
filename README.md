# Variables

An [Obsidian](https://obsidian.md) plugin that turns note properties into variables. Write `{{IP}}` in a command and the note shows the value; the copy button copies the command with the value filled in.

```yaml
IP: 10.129.2.15
domain: corp.local
user: svc_backup
password: Backup2024!
vars_secret: [password]
```

```bash
nxc smb {{IP}} -u {{user}} -p '{{password}}' -d {{domain}}
```

Showing values never changes the note: the file keeps `{{name}}`, so changing the property once updates every place it's used.

Plain JavaScript, no dependencies, no build step, no network access. The only system call is listing the machine's network interfaces, for one command.

## Features

- **Any property is a variable**, in text, inline code, code blocks, callouts and tables, in Reading view and Live Preview
- **Kinds detected from the value**: text, number, IP / CIDR, URL, e-mail, list, and links to notes, headings, blocks or embeds
- **Inheritance**: `vars_from` borrows another note's variables; a global note holds the ones every note needs
- **Chaining**: `{{dc.IP}}` follows the link in `dc` and reads that note's `IP`
- **Secrets declared in the note**: `vars_secret` blurs values until hovered, including in the Properties panel
- **Copying fills in values**: code block copy buttons, ⌘C inside code blocks, and a command
- **`{{` autocomplete** with each variable's value
- **VPN IP in one step**: pick a network interface and its address becomes `{{my_ip}}`

## Requirements

- **Obsidian** ≥ 1.6.0. Works on mobile, except the network interface command, which needs desktop

## Installation

```bash
git clone https://github.com/7a336e6e/obsidian-variables.git
VAULT="/path/to/your/vault"
mkdir -p "$VAULT/.obsidian/plugins/local-variables"
cp obsidian-variables/{main.js,manifest.json,styles.css} "$VAULT/.obsidian/plugins/local-variables/"
```

Then enable **Variables** in **Settings → Community plugins** (click **Reload plugins** if it isn't listed).

The plugin id is `local-variables`. Ids starting with `local-` aren't used in the community store, so Obsidian's updater never replaces this plugin with something else.

## Usage

### Basics

Write `{{name}}` anywhere in a note. Names use letters, digits, `_` and `-`, and case doesn't matter (`{{ip}}` finds `IP`). A name that can't be found is left as written.

In Live Preview, putting the cursor on a value shows `{{name}}` again so you can edit it. Typing `{{` suggests the variables the note can use, with their values.

### Where values come from

1. The note's own properties.
2. Notes listed in `vars_from` (a link, or a list of links), and theirs in turn, up to four levels deep.
3. The global note (`Resources/Variables.md` by default), created the first time you set a global variable.

The first one that defines the name wins. Properties that describe a note itself (`tags`, `aliases`, `status`, `note_type`, `topic`, `source`, `author`, `created`, `updated`, `related`, `title`, `description`, …) only count in their own note: a note never borrows another note's `status`.

A box note can set `vars_from: "[[Dante]]"` to pick up a lab-wide `domain` and `user` from the Dante note, while `{{my_ip}}` comes from the global note in every note.

### Kinds of values

The kind is worked out from the value; there is nothing to declare.

| Kind | Property example | In the note | In code and when copied |
|---|---|---|---|
| Text | `user: administrator` | as written | as written |
| Number | `port: 445` | as written | as written |
| IP / CIDR | `IP: 10.129.2.15` | monospace | as written |
| URL | `site: https://intranet.corp.local` | clickable link | as written |
| Link to a note | `dc: "[[DANTE-DC01]]"` | clickable link with hover preview | the note's name, or the link's alias |
| Link to a heading or block | `exploit: "[[DANTE-DC01#Exploit]]"` | opens right at that heading / block | the note's name, or the link's alias |
| Embed | `diagram: "![[network.png]]"` | shows the image | the file name |
| List | `ports: [22, 80, 445]` | `22, 80, 445` | `22,80,445` (separator in settings) |

Links in properties need quotes: `dc: "[[DANTE-DC01]]"`. To control what a link turns into inside a command, give it an alias: `dc: "[[DANTE-DC01|dc01.corp.local]]"` shows as a link in text and as `dc01.corp.local` in code.

### Reading another note's properties

`{{dc.IP}}` follows the link in `dc` and reads `IP` from that note. It works for heading links too (the property is read from the note the heading is in), and a list of links gives a list of values. "Insert a variable…" and the `{{` suggestions list these as well.

### Secrets

```yaml
vars_secret: [password, "*_hash"]
```

Values listed in `vars_secret` (`*` matches anything) are blurred until you hover them: in text, in code blocks, in callouts and in the Properties panel. Copying always gives the real value.

A value is secret when **the note you're reading lists it, or the note that defines it does**. A box note that lists its `password` keeps `{{dc.password}}` blurred in every note that uses it; any note can also blur something just for itself.

Guessing secrets from names (`password`, `hash`, `token`…) can be turned on in settings. It is off by default.

The blur keeps values off a shared screen. It is not encryption: the value is plain text in the note's file.

### Copying commands

- **Reading view:** the copy button on a code block copies it with the values filled in.
- **Live Preview:** clicking the language label on a code block (e.g. `shell`) copies it filled in.
- **⌘C** on a selection inside a code block copies the values too. Outside code blocks ⌘C copies `{{name}}` as written, so text moved between notes keeps its placeholders.
- **"Copy the code block at the cursor"** does the same from the keyboard.

### Commands

| Command | What it does |
|---|---|
| `Variables: Insert a variable…` | Pick one of the note's variables; ↵ inserts `{{name}}`, ⌘↵ copies its value |
| `Variables: Copy a variable's value…` | Pick a variable, copy its value |
| `Variables: Set a variable…` | Change a value where it's defined (this note, a `vars_from` note or the global note), or create a new variable here or globally |
| `Variables: Mark a variable as secret / not secret…` | Adds the name to the open note's `vars_secret`; unmarking removes it from both the reading and the defining note |
| `Variables: Turn the selection into a variable` | Select e.g. an IP, name it: it becomes a property and every copy in the note becomes `{{name}}`. One ⌘Z undoes it |
| `Variables: Copy the code block at the cursor (variables filled in)` | Copies the code block you're in, with values |
| `Variables: Set a variable from a network interface (VPN IP)…` | Lists this machine's addresses, VPN tunnels first, and writes the chosen one to the global `my_ip` |
| `Variables: Open the global variables note` | Opens (or creates) the global note |

## Settings

- **Global variables note**: default `Resources/Variables.md`
- **Inherit property**: default `vars_from`
- **List separator**: joins list values in code and when copying (default `,`)
- **VPN variable**: the global variable the network interface command writes to (default `my_ip`)
- **Secrets property**: default `vars_secret`
- **Blur secrets**: default on
- **Also guess secrets from names** and **Words for guessing**: default off
- **Fill in values on ⌘C in code blocks**: default on
- **Skip**: notes shown as written. A folder ending in `/`, `**/name/` for a folder at any depth, a path, or a filename. Default `**/_templates/`, so templates keep their placeholders

## How it works

- **Reading view**: a Markdown post-processor replaces placeholders. Code blocks are highlighted after post-processors run, which rebuilds their HTML, so the plugin waits for the code element's `is-loaded` class and replaces placeholders even when highlighting has split them across several text nodes.
- **Live Preview**: a CodeMirror 6 view plugin replaces each placeholder with a widget, except while the cursor is inside it.
- **Secrets in the Properties panel**: a generated stylesheet blurs the listed property rows of each open note.
- **Copying**: the copy button and the Live Preview language label copy the raw source in Obsidian, so the plugin intercepts those clicks and copies the filled-in text instead.

## License

[MIT](LICENSE)
