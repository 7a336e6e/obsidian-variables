/*
 * Variables — local build.
 *
 * Every property of a note is a variable. Write {{name}} anywhere in the note (prose, inline code, code blocks)
 * and the note shows the value; the copy button of a code block copies it with the values filled in.
 *
 *   IP: 10.129.2.15         →  nmap -sC -sV {{IP}}       shows and copies   nmap -sC -sV 10.129.2.15
 *   dc: "[[DANTE-DC01]]"    →  {{dc}} is a link to that note;  {{dc.IP}} is that note's IP property
 *   vars_from: "[[Dante]]"  →  names this note doesn't define are also looked up in the Dante note
 *   Resources/Variables.md  →  global variables (e.g. my_ip), used when nothing closer defines the name
 *
 * The kind of value is detected from the value itself: link (note, heading, block or embed), URL, e-mail, IP/CIDR,
 * number, list or text. A note marks its own secrets, which are blurred until hovered and copied in full:
 *
 *   vars_secret: [admin_hash, password]     (wildcards work: "*_hash")
 *
 * A value is secret when the note you're reading lists it, or when the note that defines it does (so a box note
 * that lists its password keeps {{dc.password}} blurred in every note that uses it).
 * Showing values never changes the note: the file keeps {{name}}.
 *
 * Plain JavaScript, no dependencies, no network access. The only system call is listing this machine's network
 * interfaces, for the "Set a variable from a network interface" command.
 */
'use strict';

const {
	Plugin, PluginSettingTab, Setting, SuggestModal, EditorSuggest, Modal, Notice, TFile, Platform,
	MarkdownRenderer, editorLivePreviewField, editorInfoField, setTooltip, prepareFuzzySearch, debounce,
	parseLinktext, Keymap, moment,
} = require('obsidian');
const { ViewPlugin, Decoration, WidgetType, EditorView } = require('@codemirror/view');
const { StateEffect, RangeSetBuilder } = require('@codemirror/state');
const { syntaxTree } = require('@codemirror/language');

const DEFAULTS = {
	globalNote: 'Resources/Variables.md',
	inheritKey: 'vars_from',
	secretKey: 'vars_secret',
	exclude: '**/_templates/',
	maskSecrets: true,
	guessSecrets: false,
	secretNames: 'pass, passwd, password, pwd, secret, token, hash, ntlm, apikey, api_key, private_key, cookie, key',
	listSeparator: ',',
	resolveOnCopy: true,
	vpnVariable: 'my_ip',
};

/* Properties that describe a note itself. They only resolve in their own note, never inherited or global. */
const RESERVED = new Set(['tags', 'tag', 'aliases', 'alias', 'cssclasses', 'title', 'status', 'note_type', 'topic',
	'source', 'author', 'created', 'updated', 'related', 'publish', 'permalink', 'description']);

const VAR_RE = /\{\{\s*([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)\s*\}\}/g;
const hasVar = (s) => /\{\{\s*[A-Za-z_][\w.-]*\s*\}\}/.test(s);
const LINK_RE = /^(!?)\[\[([^\]]+)\]\]$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/\d{1,2})?(:\d{1,5})?$/;
const IPV6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}(\/\d{1,3})?$/i;
const MAX_DEPTH = 4;
const MOD = Platform.isMacOS ? '⌘' : 'Ctrl';
const refreshEffect = StateEffect.define();

const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && !v.trim()) ||
	(Array.isArray(v) && v.every(isBlank));
const asList = (v) => (Array.isArray(v) ? v : isBlank(v) ? [] : [v]);
// own keys only: {{constructor}} must not find Object.prototype.constructor
const findKey = (fm, name) => (Object.prototype.hasOwnProperty.call(fm, name) ? name
	: Object.keys(fm).find((k) => k.toLowerCase() === name.toLowerCase()));

function kindOf(value) {
	if (Array.isArray(value)) return 'list';
	if (typeof value === 'number') return 'number';
	if (typeof value === 'boolean') return 'boolean';
	const s = String(value).trim();
	const link = LINK_RE.exec(s);
	if (link) return link[1] ? 'embed' : 'link';
	if (/^https?:\/\/\S+$/i.test(s)) return 'url';
	if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'email';
	if (IPV4.test(s) || IPV6.test(s)) return 'ip';
	return 'text';
}

/* "[[Note#Heading|Alias]]" → { linktext: "Note#Heading", path: "Note", subpath: "#Heading", alias, embed } */
function parseWikilink(s) {
	const m = LINK_RE.exec(String(s).trim());
	if (!m) return null;
	const [target, alias] = m[2].split('|');
	const { path, subpath } = parseLinktext(target.trim());
	return { linktext: target.trim(), path, subpath, alias: alias && alias.trim(), embed: !!m[1] };
}

/* A YAML scalar that reads back as the same string. */
function yamlScalar(v) {
	const s = String(v);
	const plain = /^[A-Za-z0-9_./:@-][A-Za-z0-9_./:@ -]*$/.test(s) && !/\s$/.test(s) &&
		!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s);
	return plain ? s : JSON.stringify(s);
}

function frontmatterEnd(doc) {
	if (doc.lines < 2 || doc.line(1).text.trimEnd() !== '---') return 0;
	for (let n = 2; n <= doc.lines; n++) {
		const t = doc.line(n).text.trimEnd();
		if (t === '---' || t === '...') return doc.line(n).to;
	}
	return 0;
}

module.exports = class VariablesPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULTS, await this.loadData());
		this.deps = new Map(); // note path → paths of the notes its variables were looked up in
		this.codeSource = new WeakMap(); // rendered <pre> → its original text
		this.liveChips = []; // WeakRefs to values drawn by the post-processor
		this.hoverParent = { hoverPopover: null };
		this.changed = new Set();
		this.refreshSoon = debounce(() => this.refreshViews(), 250, true);
		this.secretStyle = document.head.createEl('style', { attr: { id: 'local-variables-secrets' } });
		this.register(() => {
			this.secretStyle.remove();
			for (const leaf of this.app.workspace.getLeavesOfType('markdown')) leaf.view.containerEl.removeAttribute('data-lv-secrets');
		});
		const secretsSoon = debounce(() => this.updateSecretProperties(), 100, true);
		this.registerEvent(this.app.workspace.on('file-open', secretsSoon));
		this.registerEvent(this.app.workspace.on('layout-change', secretsSoon));
		this.app.workspace.onLayoutReady(() => this.updateSecretProperties());

		this.addSettingTab(new VariablesSettingTab(this.app, this));
		this.registerHoverLinkSource('local-variables', { display: 'Variables', defaultMod: true });
		this.registerMarkdownPostProcessor((el, ctx) => this.renderReading(el, ctx.sourcePath));
		this.registerEditorExtension([this.livePreviewExtension(), this.copyExtension()]);
		this.registerEditorSuggest(new VariableSuggest(this));
		this.registerDomEvent(document, 'click', (evt) => this.onFlairClick(evt), { capture: true });

		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			this.changed.add(file.path);
			this.refreshSoon();
		}));

		this.addCommand({
			id: 'insert-variable',
			name: 'Insert a variable…',
			editorCheckCallback: (checking, editor, ctx) => {
				if (!ctx.file) return false;
				if (!checking) this.openPicker(ctx.file, 'insert', editor);
				return true;
			},
		});
		this.addCommand({
			id: 'copy-variable',
			name: "Copy a variable's value…",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.openPicker(file, 'copy');
				return true;
			},
		});
		this.addCommand({
			id: 'set-variable',
			name: 'Set a variable…',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.openPicker(file, 'set');
				return true;
			},
		});
		this.addCommand({
			id: 'toggle-secret',
			name: 'Mark a variable as secret / not secret…',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.openPicker(file, 'secret');
				return true;
			},
		});
		this.addCommand({
			id: 'selection-to-variable',
			name: 'Turn the selection into a variable',
			editorCheckCallback: (checking, editor, ctx) => {
				const text = editor.getSelection();
				if (!ctx.file || !text.trim() || text.includes('\n')) return false;
				if (!checking) this.selectionToVariable(editor, ctx.file, text.trim());
				return true;
			},
		});
		this.addCommand({
			id: 'copy-code-block',
			name: 'Copy the code block at the cursor (variables filled in)',
			editorCheckCallback: (checking, editor, ctx) => {
				const cm = editor.cm;
				const block = cm && ctx.file && this.codeBlockAt(cm.state, cm.state.selection.main.head);
				if (!block) return false;
				if (!checking) {
					navigator.clipboard.writeText(this.fill(block.text, ctx.file.path))
						.then(() => new Notice('Copied the code block with the variables filled in.'));
				}
				return true;
			},
		});
		this.addCommand({
			id: 'set-from-interface',
			name: 'Set a variable from a network interface (VPN IP)…',
			callback: () => this.fromInterface(),
		});
		this.addCommand({
			id: 'open-global-note',
			name: 'Open the global variables note',
			callback: async () => this.app.workspace.getLeaf(false).openFile(await this.ensureGlobalNote()),
		});
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.changed.add('*');
		this.refreshViews();
	}

	/* ---- looking values up --------------------------------------------------------------------------------- */

	excluded(path) {
		const name = path.split('/').pop();
		return this.settings.exclude.split('\n').map((s) => s.trim()).filter(Boolean).some((r) => {
			if (r.startsWith('**/')) return ('/' + path + '/').includes('/' + r.slice(3));
			return r.endsWith('/') ? (path + '/').startsWith(r) : r === path || r === name;
		});
	}

	fm(file) {
		return this.app.metadataCache.getFileCache(file)?.frontmatter || {};
	}

	globalFile() {
		const f = this.app.vault.getAbstractFileByPath(this.settings.globalNote);
		return f instanceof TFile ? f : null;
	}

	linkTarget(value, fromPath) {
		const w = parseWikilink(value);
		return w ? this.app.metadataCache.getFirstLinkpathDest(w.path, fromPath) : null;
	}

	depsOf(path) {
		if (!this.deps.has(path)) this.deps.set(path, new Set());
		return this.deps.get(path);
	}

	/* The notes a note's variables come from, nearest first: itself, its vars_from notes (and theirs), the global note. */
	scopes(path, withGlobal = true) {
		const out = [];
		const seen = new Set();
		const visit = (file, depth) => {
			if (!(file instanceof TFile) || seen.has(file.path) || depth > MAX_DEPTH) return;
			seen.add(file.path);
			out.push({ file, own: depth === 0 });
			const fm = this.fm(file);
			const key = findKey(fm, this.settings.inheritKey);
			if (key) for (const v of asList(fm[key])) visit(this.linkTarget(v, file.path), depth + 1);
		};
		visit(this.app.vault.getAbstractFileByPath(path), 0);
		const global = withGlobal && this.globalFile();
		if (global && !seen.has(global.path)) out.push({ file: global, own: false });
		return out;
	}

	/* The plugin's own control properties (vars_from, vars_secret) are settings, not variables. */
	isControlKey(key) {
		const k = key.toLowerCase();
		return k === this.settings.inheritKey.toLowerCase() || k === this.settings.secretKey.toLowerCase();
	}

	lookup(path, name, deps, withGlobal) {
		if (this.isControlKey(name)) return null;
		for (const { file, own } of this.scopes(path, withGlobal)) {
			deps.add(file.path);
			if (!own && RESERVED.has(name.toLowerCase())) continue;
			const fm = this.fm(file);
			const key = findKey(fm, name);
			if (key && !isBlank(fm[key])) return { value: fm[key], origin: file, key };
		}
		return null;
	}

	/* {{a.b.c}} → { name, value, kind, secret, origin, key } or null when it can't be resolved. */
	resolve(path, name) {
		const deps = this.depsOf(path);
		const parts = name.split('.');
		let hit = this.lookup(path, parts[0], deps, true);
		for (const part of parts.slice(1)) {
			if (!hit) return null;
			const values = [];
			let next = null;
			for (const v of asList(hit.value)) {
				const target = this.linkTarget(v, hit.origin.path);
				const found = target && this.lookup(target.path, part, deps, false);
				if (found) { values.push(found.value); next = next || found; }
			}
			if (!values.length) return null;
			hit = Object.assign({}, next, { value: values.length === 1 ? values[0] : values.flat() });
		}
		if (!hit) return null;
		return Object.assign(hit, { name, kind: kindOf(hit.value), secret: this.isSecret(hit.origin, hit.key, path, name) });
	}

	/* Patterns a note lists under vars_secret ("password", "*_hash"). */
	secretPatterns(file) {
		const fm = this.fm(file);
		const key = findKey(fm, this.settings.secretKey);
		return key ? asList(fm[key]).map((p) => String(p).trim()).filter(Boolean) : [];
	}

	/*
	 * Secret when the note you're reading lists it (by the name used there, e.g. "dc.password", or the property
	 * name) OR the note that defines the value lists it — so a box note can keep its password blurred everywhere.
	 * If turned on in settings, names that read like credentials are secret too.
	 */
	isSecret(origin, key, viewerPath, name) {
		const listed = (file, ...names) => this.secretPatterns(file).some((p) => {
			const re = new RegExp('^' + p.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
			return names.some((n) => re.test(n.toLowerCase()));
		});
		if (listed(origin, key)) return true;
		const viewer = viewerPath && viewerPath !== origin.path && this.app.vault.getAbstractFileByPath(viewerPath);
		if (viewer instanceof TFile && listed(viewer, name || key, key)) return true;
		if (!this.settings.guessSecrets) return false;
		const words = new Set(this.settings.secretNames.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
		const tokens = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-.\s]+/);
		return words.has(key.toLowerCase()) || tokens.some((t) => words.has(t));
	}

	/* Marking writes to the note you're in; unmarking removes the entry wherever it is listed by name. */
	async toggleSecret(item, file) {
		const names = [item.name, item.key].map((n) => n.toLowerCase());
		const drop = (fm) => {
			const key = findKey(fm, this.settings.secretKey) || this.settings.secretKey;
			const list = asList(fm[key]).map(String).filter((p) => !names.includes(p.toLowerCase()));
			if (list.length) fm[key] = list;
			else delete fm[key];
		};
		if (!item.secret) {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				const key = findKey(fm, this.settings.secretKey) || this.settings.secretKey;
				fm[key] = [...asList(fm[key]).map(String), item.name];
			});
			return new Notice(`{{${item.name}}} is now secret (listed in this note's ${this.settings.secretKey}).`);
		}
		for (const f of new Set([file, item.origin])) await this.app.fileManager.processFrontMatter(f, drop);
		const still = this.resolve(file.path, item.name);
		if (still && still.secret) {
			return new Notice(`{{${item.name}}} is still secret through a wildcard in ${this.settings.secretKey} (or a guessed name) — edit that entry.`);
		}
		new Notice(`{{${item.name}}} is no longer secret.`);
	}

	/*
	 * Blur secret values in the Properties panel too. Each open note's container lists its secret keys in an
	 * attribute, and one generated stylesheet blurs those keys' values inside containers that list them.
	 */
	updateSecretProperties() {
		const all = new Set();
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const file = leaf.view.file;
			const keys = [];
			if (file && this.settings.maskSecrets && !this.excluded(file.path)) {
				for (const k of Object.keys(this.fm(file))) if (!this.isControlKey(k) && this.isSecret(file, k)) keys.push(k.toLowerCase());
			}
			keys.forEach((k) => all.add(k));
			leaf.view.containerEl.setAttr('data-lv-secrets', keys.join(' ') || null);
		}
		const css = [...all].filter((k) => !/\s/.test(k)).map((k) => {
			const v = CSS.escape(k);
			const sel = `[data-lv-secrets~="${v}"] .metadata-property[data-property-key="${v}"] .metadata-property-value`;
			return `${sel}{filter:blur(4px);transition:filter 120ms ease}${sel}:hover,${sel}:focus-within{filter:none}`;
		}).join('\n');
		if (this.secretStyle.textContent !== css) this.secretStyle.textContent = css;
	}

	/* The value as plain text, the way it goes into a command. */
	valueText(value, sep = this.settings.listSeparator) {
		if (Array.isArray(value)) return value.map((v) => this.valueText(v, sep)).join(sep);
		if (value === null || value === undefined) return '';
		if (typeof value === 'object') return JSON.stringify(value);
		const w = parseWikilink(value);
		if (w) return w.alias || w.path.split('/').pop() || w.subpath.replace(/^#\^?/, '');
		return String(value);
	}

	fill(text, path) {
		return text.replace(VAR_RE, (all, name) => {
			const res = this.resolve(path, name);
			return res ? this.valueText(res.value) : all;
		});
	}

	/* Every variable a note can use, nearest definition first, plus one level of link.property. */
	available(path) {
		const items = [];
		const seen = new Set();
		const deps = this.depsOf(path);
		for (const { file, own } of this.scopes(path)) {
			const fm = this.fm(file);
			for (const key of Object.keys(fm)) {
				if (this.isControlKey(key) || (!own && RESERVED.has(key.toLowerCase()))) continue;
				if (seen.has(key.toLowerCase()) || isBlank(fm[key])) continue;
				seen.add(key.toLowerCase());
				const res = this.resolve(path, key);
				if (!res) continue;
				items.push(res);
				if (res.kind !== 'link' && !(res.kind === 'list' && res.value.every((v) => kindOf(v) === 'link'))) continue;
				const targets = asList(res.value).map((v) => this.linkTarget(v, file.path)).filter(Boolean);
				const props = new Set();
				for (const t of targets) {
					deps.add(t.path);
					for (const k of Object.keys(this.fm(t))) if (!RESERVED.has(k.toLowerCase()) && !this.isControlKey(k)) props.add(k);
				}
				for (const k of props) {
					const sub = this.resolve(path, `${key}.${k}`);
					if (sub) items.push(sub);
				}
			}
		}
		return items;
	}

	/* ---- showing values -------------------------------------------------------------------------------------- */

	chip(res, path, inCode) {
		const el = createSpan({ cls: ['lv-var', 'lv-kind-' + res.kind] });
		if (inCode) el.addClass('lv-in-code');
		if (inCode === 'inline') el.addClass('lv-in-inline-code');
		if (res.secret && this.settings.maskSecrets) el.addClass('is-secret');
		if (inCode || !['link', 'embed', 'url', 'list'].includes(res.kind)) el.setText(this.valueText(res.value));
		else this.renderRich(el, res.value, path);
		const from = res.origin.path === path ? 'this note' : res.origin.path === this.settings.globalNote ? 'global' : res.origin.basename;
		setTooltip(el, `{{${res.name}}} · ${res.kind}${res.secret ? ' · secret' : ''} · from ${from}`, { placement: 'top' });
		return el;
	}

	renderRich(el, value, path) {
		asList(value).forEach((v, i) => {
			if (i) el.appendText(', ');
			const w = parseWikilink(v);
			if (w && w.embed) {
				const span = el.createSpan({ cls: 'lv-embed' });
				MarkdownRenderer.render(this.app, String(v).trim(), span, path, this).then(() => {
					const p = span.querySelector(':scope > p');
					if (p) p.replaceWith(...p.childNodes);
				});
			} else if (w) {
				const label = w.alias || (w.subpath ? `${w.path} › ${w.subpath.replace(/^#\^?/, '')}` : w.path);
				const a = el.createEl('a', { cls: 'internal-link', text: label, attr: { href: w.linktext, 'data-href': w.linktext } });
				if (!this.app.metadataCache.getFirstLinkpathDest(w.path, path)) a.addClass('is-unresolved');
				this.wireLink(a, w.linktext, path);
			} else if (kindOf(v) === 'url') {
				el.createEl('a', { cls: 'external-link', text: String(v), attr: { href: String(v), target: '_blank', rel: 'noopener nofollow' } });
			} else {
				el.appendText(this.valueText(v, ', '));
			}
		});
	}

	wireLink(a, linktext, path) {
		a.addEventListener('click', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.app.workspace.openLinkText(linktext, path, Keymap.isModEvent(evt));
		});
		a.addEventListener('mouseover', (evt) => {
			this.app.workspace.trigger('hover-link', {
				event: evt, source: 'local-variables', hoverParent: this.hoverParent, targetEl: a, linktext, sourcePath: path,
			});
		});
	}

	/* Reading view (and blocks Live Preview renders the same way: callouts, tables). */
	renderReading(el, path) {
		if (!path || this.excluded(path) || !el.textContent.includes('{{')) return;
		for (const code of el.querySelectorAll('pre > code')) {
			const pre = code.parentElement;
			if (pre.hasClass('frontmatter')) continue;
			const source = code.textContent.replace(/\n$/, '');
			if (!hasVar(source) || this.fill(source, path) === source) continue;
			this.codeSource.set(pre, source);
			pre.addEventListener('click', (evt) => this.onCopyButton(evt, pre, path), { capture: true });
			this.afterHighlight(code, () => this.replaceAcrossNodes(code, path));
		}
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const nodes = [];
		while (walker.nextNode()) {
			const n = walker.currentNode;
			if (n.nodeValue.includes('{{') && !n.parentElement.closest('pre, a, .lv-var, .frontmatter, .metadata-container, .math')) nodes.push(n);
		}
		for (const node of nodes) this.replaceAcrossNodes(node, path);
	}

	/*
	 * Obsidian highlights code blocks after post-processors run and rebuilds the block's HTML when it does, which
	 * would throw our values away. So wait for the highlighter (it marks the block "is-loaded"), or give up waiting
	 * after a moment for languages it has no grammar for.
	 */
	afterHighlight(code, fn) {
		if (code.hasClass('is-loaded')) return fn();
		let done = false;
		const run = () => {
			if (done) return;
			done = true;
			observer.disconnect();
			fn();
		};
		const observer = new MutationObserver(() => code.hasClass('is-loaded') && run());
		observer.observe(code, { attributes: true, attributeFilter: ['class'] });
		setTimeout(run, 1000);
	}

	/*
	 * Replace {{name}} inside `root`, even when syntax highlighting has split it over several text nodes
	 * ("{", "{", "IP", "}", "}" each in its own span). Returns how many were replaced.
	 */
	replaceAcrossNodes(root, path) {
		const texts = [];
		if (root.nodeType === Node.TEXT_NODE) texts.push(root);
		else {
			const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			while (w.nextNode()) texts.push(w.currentNode);
		}
		const starts = [];
		const lens = [];
		let full = '';
		for (const t of texts) { starts.push(full.length); lens.push(t.nodeValue.length); full += t.nodeValue; }
		const inCode = root.nodeType === Node.TEXT_NODE ? !!root.parentElement.closest('code') : true;
		const at = (off, end) => texts.findIndex((_, i) => (end ? starts[i] < off && off <= starts[i] + lens[i] : starts[i] <= off && off < starts[i] + lens[i]));
		let count = 0;
		// right to left, so the offsets of earlier matches stay valid
		for (const m of [...full.matchAll(VAR_RE)].reverse()) {
			const res = this.resolve(path, m[1]);
			if (!res) continue;
			const a = m.index;
			const b = a + m[0].length;
			const i = at(a, false);
			const j = at(b, true);
			if (i < 0 || j < 0) continue;
			const chip = this.chip(res, path, inCode);
			this.track(chip, path, m[1], inCode);
			if (i === j) {
				const mid = texts[i].splitText(a - starts[i]);
				mid.splitText(b - a);
				mid.replaceWith(chip);
			} else {
				texts[i].splitText(a - starts[i]).replaceWith(chip);
				for (let k = i + 1; k < j; k++) texts[k].nodeValue = '';
				texts[j].nodeValue = texts[j].nodeValue.slice(b - starts[j]);
			}
			count++;
		}
		return count;
	}

	onCopyButton(evt, pre, path) {
		const btn = evt.target instanceof Element && evt.target.closest('.copy-code-button');
		if (!btn || !pre.contains(btn)) return;
		evt.preventDefault();
		evt.stopPropagation();
		navigator.clipboard.writeText(this.fill(this.codeSource.get(pre), path)).then(() => this.flash(btn));
	}

	/* Live Preview: the language label on a code block is its copy button. */
	onFlairClick(evt) {
		const flair = evt.target instanceof Element && evt.target.closest('.markdown-source-view .code-block-flair');
		if (!flair) return;
		const view = EditorView.findFromDOM(flair);
		const path = view && view.state.field(editorInfoField, false)?.file?.path;
		if (!path || this.excluded(path)) return;
		const block = this.codeBlockAt(view.state, view.posAtDOM(flair));
		if (!block || !hasVar(block.text)) return; // nothing to fill in: let Obsidian copy it as usual
		evt.preventDefault();
		evt.stopPropagation();
		navigator.clipboard.writeText(this.fill(block.text, path)).then(() => this.flash(flair));
	}

	flash(el) {
		const kids = [...el.childNodes];
		el.setText('Copied!');
		setTimeout(() => el.replaceChildren(...kids), 1200);
	}

	/* The fenced code block containing `pos` → { text, from, to } (line numbers), or null. */
	codeBlockAt(state, pos) {
		const doc = state.doc;
		const target = doc.lineAt(pos).number;
		let open = null;
		for (let n = 1; n <= doc.lines; n++) {
			const text = doc.line(n).text;
			if (!open) {
				const m = /^(\s*(?:>\s?)*)(`{3,}|~{3,})/.exec(text);
				if (m) open = { n, prefix: m[1], close: new RegExp(`^\\s*\\${m[2][0]}{${m[2].length},}\\s*$`) };
				else if (n >= target) return null;
				continue;
			}
			const strip = (t) => (t.startsWith(open.prefix) ? t.slice(open.prefix.length) : t.replace(/^\s*(?:>\s?)*/, ''));
			if (open.close.test(strip(text))) {
				if (target >= open.n && target <= n) {
					const lines = [];
					for (let k = open.n + 1; k < n; k++) lines.push(strip(doc.line(k).text));
					return { text: lines.join('\n'), from: open.n, to: n };
				}
				if (n >= target) return null;
				open = null;
			}
		}
		return null;
	}

	/* 'block' inside a fenced code block, 'inline' inside `inline code`, otherwise false. */
	isCodeAt(state, pos) {
		for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
			if (/codeblock/i.test(node.name)) return 'block';
			if (/inline-code/i.test(node.name)) return 'inline';
		}
		return false;
	}

	livePreviewExtension() {
		const plugin = this;

		class VarWidget extends WidgetType {
			constructor(res, path, inCode) {
				super();
				this.res = res;
				this.path = path;
				this.inCode = inCode;
				this.key = `${res.name}|${JSON.stringify(res.value)}|${res.origin.path}|${inCode}|${res.secret && plugin.settings.maskSecrets}`;
			}
			eq(other) { return other.key === this.key; }
			toDOM() { return plugin.chip(this.res, this.path, this.inCode); }
			// clicks on a link inside the value open the link; anything else puts the cursor there to edit
			ignoreEvent(evt) { return evt.target instanceof Element && !!evt.target.closest('a'); }
		}

		const build = (view) => {
			const state = view.state;
			if (!state.field(editorLivePreviewField, false)) return Decoration.none;
			const path = state.field(editorInfoField, false)?.file?.path;
			if (!path || plugin.excluded(path)) return Decoration.none;
			const builder = new RangeSetBuilder();
			const fmEnd = frontmatterEnd(state.doc);
			const ranges = state.selection.ranges;
			for (const { from, to } of view.visibleRanges) {
				for (const m of state.sliceDoc(from, to).matchAll(VAR_RE)) {
					const a = from + m.index;
					const b = a + m[0].length;
					if (a < fmEnd) continue;
					// show the source while the cursor (or a selection edge) is inside it, like links do
					if (ranges.some((r) => (r.empty ? r.from >= a && r.from <= b : (r.from > a && r.from < b) || (r.to > a && r.to < b)))) continue;
					const res = plugin.resolve(path, m[1]);
					if (res) builder.add(a, b, Decoration.replace({ widget: new VarWidget(res, path, plugin.isCodeAt(state, a)) }));
				}
			}
			return builder.finish();
		};

		return ViewPlugin.fromClass(class {
			constructor(view) { this.decorations = build(view); }
			update(u) {
				const modeChanged = u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false);
				const forced = u.transactions.some((t) => t.effects.some((e) => e.is(refreshEffect)));
				if (u.docChanged || u.viewportChanged || u.selectionSet || modeChanged || forced) this.decorations = build(u.view);
			}
		}, { decorations: (v) => v.decorations });
	}

	/* ⌘C on a selection inside a code block copies the values, like the copy button does. */
	copyExtension() {
		const plugin = this;
		return EditorView.domEventHandlers({
			copy(event, view) {
				if (!plugin.settings.resolveOnCopy) return false;
				const sel = view.state.selection.main;
				if (sel.empty) return false;
				const text = view.state.sliceDoc(sel.from, sel.to);
				const path = view.state.field(editorInfoField, false)?.file?.path;
				if (!path || !hasVar(text) || plugin.excluded(path)) return false;
				if (!plugin.isCodeAt(view.state, sel.from) || !plugin.isCodeAt(view.state, sel.to - 1)) return false;
				event.clipboardData.setData('text/plain', plugin.fill(text, path));
				event.preventDefault();
				return true;
			},
		});
	}

	/*
	 * Values drawn by the post-processor. Live Preview keeps rendered callouts and tables as long as their text is
	 * unchanged, so after a property changes these are updated in place. Weak references: a value that's gone from
	 * the page is simply forgotten.
	 */
	track(chip, path, name, inCode) {
		chip.lvMeta = { path, name, inCode };
		this.liveChips.push(new WeakRef(chip));
	}

	refreshChips(relevant) {
		const keep = [];
		for (const ref of this.liveChips) {
			const el = ref.deref();
			if (!el || !el.parentNode) continue;
			const { path, name, inCode } = el.lvMeta;
			if (!relevant(path)) { keep.push(ref); continue; }
			const res = this.resolve(path, name);
			if (!res) { el.replaceWith(document.createTextNode(`{{${name}}}`)); continue; }
			const next = this.chip(res, path, inCode);
			next.lvMeta = el.lvMeta;
			el.replaceWith(next);
			keep.push(new WeakRef(next));
		}
		this.liveChips = keep;
	}

	refreshViews() {
		const all = this.changed.has('*');
		const changed = this.changed;
		this.changed = new Set();
		const relevant = (path) => {
			const deps = this.deps.get(path);
			return all || changed.has(path) || !!(deps && [...changed].some((c) => deps.has(c)));
		};
		this.refreshChips(relevant);
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			const path = view.file?.path;
			if (!path || !relevant(path)) continue;
			if (view.getMode() === 'preview') view.previewMode.rerender(true);
			else view.editor?.cm?.dispatch({ effects: refreshEffect.of(null) });
		}
		this.updateSecretProperties();
	}

	/* ---- commands ---------------------------------------------------------------------------------------------- */

	openPicker(file, action, editor) {
		const items = this.available(file.path);
		if (action === 'set') {
			items.unshift({ create: 'local', name: '＋ new variable in this note' }, { create: 'global', name: '＋ new global variable' });
		}
		if (!items.length) return new Notice('This note has no variables yet: add a property, or use "Set a variable…".');
		new VariablePicker(this, file, items, action, editor).open();
	}

	async setFlow(file, item) {
		let target = item.origin;
		let key = item.key;
		if (item.create) {
			const name = await prompt(this.app, item.create === 'global' ? 'New global variable — name' : 'New variable — name', '');
			if (!name) return;
			if (!/^[A-Za-z_][\w-]*$/.test(name)) return new Notice('Use letters, digits, "_" or "-" (starting with a letter).');
			target = item.create === 'global' ? await this.ensureGlobalNote() : file;
			key = name;
		}
		const where = target.path === file.path ? 'this note' : target.path === this.settings.globalNote ? 'global' : target.basename;
		const value = await prompt(this.app, `${key} (${where}) =`, item.create ? '' : this.valueText(item.value, ', '));
		if (value === null) return;
		await this.setVar(target, key, value);
		new Notice(`${key} = ${value || '(empty)'} — ${where}`);
	}

	async setVar(file, key, value) {
		await this.app.fileManager.processFrontMatter(file, (fm) => { fm[findKey(fm, key) || key] = value; });
	}

	async selectionToVariable(editor, file, text) {
		// Never run without text: searching for "" matches at every position, and the loop below would never end.
		text = String(text || '').trim();
		if (!text || text.includes('\n')) return new Notice('Select the text to turn into a variable first (a single line).');
		const fm = this.fm(file);
		const kind = kindOf(text);
		const suggestion = kind === 'ip' ? (findKey(fm, 'IP') ? '' : 'IP') : kind === 'url' ? 'url' : kind === 'email' ? 'email' : '';
		const name = await prompt(this.app, `Variable name for “${text}” (every “${text}” in this note becomes {{name}})`, suggestion);
		if (!name) return;
		if (!/^[A-Za-z_][\w-]*$/.test(name)) return new Notice('Use letters, digits, "_" or "-" (starting with a letter).');
		const existing = findKey(fm, name);
		if (existing && this.valueText(fm[existing], ', ') !== text) {
			return new Notice(`${existing} is already set to “${this.valueText(fm[existing], ', ')}” in this note.`);
		}
		const doc = editor.getValue();
		if (editor.getSelection().trim() !== text) return new Notice('The selection changed while the name was being typed — select the text and run the command again.');
		const m = /^---\r?\n([\s\S]*?\r?\n)?---[ \t]*(\r?\n|$)/.exec(doc);
		const bodyStart = m ? m[0].length : 0;
		const changes = [];
		if (!existing) {
			const line = `${name}: ${yamlScalar(text)}\n`;
			if (m) {
				const at = m[0].length - m[0].replace(/^---\r?\n([\s\S]*?\r?\n)?/, '').length; // start of the closing ---
				changes.push({ from: editor.offsetToPos(at), to: editor.offsetToPos(at), text: line });
			} else {
				changes.push({ from: editor.offsetToPos(0), to: editor.offsetToPos(0), text: `---\n${line}---\n` });
			}
		}
		let count = 0;
		for (let i = doc.indexOf(text, bodyStart); i >= 0; i = doc.indexOf(text, i + Math.max(text.length, 1))) {
			const before = doc.lastIndexOf('{{', i);
			if (before >= 0 && doc.indexOf('}}', before) > i && !doc.slice(before, i).includes('\n')) continue; // already inside {{…}}
			changes.push({ from: editor.offsetToPos(i), to: editor.offsetToPos(i + text.length), text: `{{${name}}}` });
			count++;
		}
		editor.transaction({ changes });
		new Notice(`${count} × “${text}” → {{${name}}}${existing ? '' : `, and ${name} added to the properties`}. ${MOD}Z undoes it.`);
	}

	async fromInterface() {
		let os;
		try { os = require('os'); } catch (e) { return new Notice('Network interfaces can only be read on desktop.'); }
		const list = [];
		for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
			for (const a of addrs || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) list.push({ name, address: a.address });
		}
		if (!list.length) return new Notice('No network interface has an IPv4 address.');
		const rank = (i) => (/^(u?tun|tap|ppp|wg|ipsec)/.test(i.name) ? 0 : 1) + (/^10\.1[0-5]\./.test(i.address) ? 0 : 0.5);
		list.sort((a, b) => rank(a) - rank(b));
		const key = this.settings.vpnVariable;
		const choice = await pick(this.app, list.map((i) => ({ label: i.address, desc: i.name, search: `${i.address} ${i.name}` })),
			`Set {{${key}}} (global) to the address of…`);
		if (!choice) return;
		await this.setVar(await this.ensureGlobalNote(), key, choice.label);
		new Notice(`${key} = ${choice.label} (${choice.desc}) — global`);
	}

	async ensureGlobalNote() {
		const existing = this.globalFile();
		if (existing) return existing;
		const path = this.settings.globalNote;
		const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
		const index = this.app.vault.getAbstractFileByPath((folder ? folder + '/' : '') + 'README.md');
		const aliases = index instanceof TFile ? this.app.metadataCache.getFileCache(index)?.frontmatter?.aliases : null;
		const up = index instanceof TFile
			? `[[${this.app.metadataCache.fileToLinktext(index, path, true)}${aliases && aliases[0] ? '|' + aliases[0] : ''}]]` : null;
		const body = [
			'---',
			'tags:',
			'  - vault',
			'  - productivity',
			'status: active',
			'note_type: conventions',
			'topic: vault-variables',
			`created: ${moment().format('YYYY-MM-DD')}`,
			'related:',
			'  - "[[Vault Note Standard]]"',
			'---',
			'',
			up ? `**Up:** ${up}\n` : '',
			'# Variables',
			'',
			'Global variables. Every property of this note (except the standard ones above) can be used as `{{name}}` in',
			'any note that does not define the name itself. Change them from the command palette: "Variables: Set a',
			'variable…", or "Variables: Set a variable from a network interface" for your VPN address.',
			'',
			'## Related',
			'',
			'- [[Vault Note Standard]]',
			up ? `- ${up}` : '',
			'',
		].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
		return this.app.vault.create(path, body);
	}
};

/* ---- pickers ---------------------------------------------------------------------------------------------- */

function pick(app, items, placeholder) {
	return new Promise((resolve) => {
		const modal = new (class extends SuggestModal {
			getSuggestions(q) {
				const f = prepareFuzzySearch(q.trim());
				return q.trim() ? items.filter((i) => f(i.search || i.label)) : items;
			}
			renderSuggestion(item, el) {
				el.createDiv({ text: item.label });
				if (item.desc) el.createDiv({ cls: 'lv-row-meta', text: item.desc });
			}
			onChooseSuggestion(item) { this.done = true; resolve(item); }
			onClose() { setTimeout(() => this.done || resolve(null), 0); }
		})(app);
		modal.setPlaceholder(placeholder);
		modal.open();
	});
}

function prompt(app, title, value) {
	return new Promise((resolve) => {
		const m = new Modal(app);
		m.titleEl.setText(title);
		const input = m.contentEl.createEl('input', { type: 'text', cls: 'lv-prompt-input', value: value || '' });
		m.contentEl.createDiv({ cls: 'lv-row-meta', text: '↵ save · esc cancel' });
		let done = false;
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.isComposing) { done = true; resolve(input.value.trim()); m.close(); }
		});
		m.onClose = () => setTimeout(() => done || resolve(null), 0);
		m.open();
		input.select();
	});
}

function renderVarRow(plugin, item, el, path) {
	el.addClass('lv-row');
	const top = el.createDiv({ cls: 'lv-row-top' });
	top.createSpan({ cls: 'lv-row-name', text: item.create ? item.name : `{{${item.name}}}` });
	if (item.create) return;
	const shown = item.secret && plugin.settings.maskSecrets ? '••••••••' : plugin.valueText(item.value, ', ');
	top.createSpan({ cls: 'lv-row-value', text: shown });
	const from = item.origin.path === path ? 'this note' : item.origin.path === plugin.settings.globalNote ? 'global' : item.origin.basename;
	el.createDiv({ cls: 'lv-row-meta', text: `${item.kind}${item.secret ? ' · secret' : ''} · from ${from}` });
}

class VariablePicker extends SuggestModal {
	constructor(plugin, file, items, action, editor) {
		super(plugin.app);
		this.plugin = plugin;
		this.file = file;
		this.items = items;
		this.action = action;
		this.editor = editor;
		this.limit = 500;
		const verb = { insert: 'insert', copy: 'copy the value', set: 'change the value', secret: 'mark as secret / not secret' }[action];
		this.setPlaceholder(`Pick a variable to ${verb}…`);
		const help = [{ command: '↵', purpose: verb }];
		if (action === 'insert') {
			help.push({ command: `${MOD} ↵`, purpose: 'copy the value' });
			this.scope.register(['Mod'], 'Enter', (evt) => {
				const item = this.chooser?.values?.[this.chooser.selectedItem];
				if (item) { this.close(); this.copy(item); }
				return false;
			});
		}
		help.push({ command: 'esc', purpose: 'close' });
		this.setInstructions(help);
	}

	getSuggestions(query) {
		const q = query.trim();
		if (!q) return this.items;
		const f = prepareFuzzySearch(q);
		return this.items.map((i) => ({ i, m: f(i.name) })).filter((r) => r.m).sort((a, b) => b.m.score - a.m.score).map((r) => r.i);
	}

	renderSuggestion(item, el) {
		renderVarRow(this.plugin, item, el, this.file.path);
	}

	copy(item) {
		navigator.clipboard.writeText(this.plugin.valueText(item.value)).then(() => new Notice(`Copied {{${item.name}}}.`));
	}

	onChooseSuggestion(item) {
		if (this.action === 'insert') this.editor.replaceSelection(`{{${item.name}}}`);
		else if (this.action === 'copy') this.copy(item);
		else if (this.action === 'secret') this.plugin.toggleSecret(item, this.file);
		else this.plugin.setFlow(this.file, item);
	}
}

/* Typing "{{" suggests the variables this note can use. */
class VariableSuggest extends EditorSuggest {
	constructor(plugin) {
		super(plugin.app);
		this.plugin = plugin;
		this.limit = 100;
	}

	onTrigger(cursor, editor, file) {
		if (!file || this.plugin.excluded(file.path)) return null;
		const m = /\{\{\s*([\w.-]*)$/.exec(editor.getLine(cursor.line).slice(0, cursor.ch));
		if (!m) return null;
		const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatterPosition;
		if (fm && cursor.line <= fm.end.line) return null;
		return { start: { line: cursor.line, ch: m.index }, end: cursor, query: m[1] };
	}

	getSuggestions(ctx) {
		const items = this.plugin.available(ctx.file.path);
		const q = ctx.query;
		if (!q) return items;
		const f = prepareFuzzySearch(q);
		return items.map((i) => ({ i, m: f(i.name) })).filter((r) => r.m).sort((a, b) => b.m.score - a.m.score).map((r) => r.i);
	}

	renderSuggestion(item, el) {
		renderVarRow(this.plugin, item, el, this.context.file.path);
	}

	selectSuggestion(item) {
		const { editor, start, end } = this.context;
		const close = /^\s*\}\}/.exec(editor.getLine(end.line).slice(end.ch)); // swallow a "}}" that's already there
		editor.replaceRange(`{{${item.name}}}`, start, close ? { line: end.line, ch: end.ch + close[0].length } : end);
		editor.setCursor({ line: start.line, ch: start.ch + item.name.length + 4 });
	}
}

/* ---- settings --------------------------------------------------------------------------------------------- */

class VariablesSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		const p = this.plugin;
		const s = p.settings;
		containerEl.empty();
		const text = (name, desc, key, area) => new Setting(containerEl).setName(name).setDesc(desc)[area ? 'addTextArea' : 'addText']((t) =>
			t.setValue(s[key]).onChange(async (v) => { s[key] = area ? v : v.trim(); await p.saveSettings(); }));
		const toggle = (name, desc, key) => new Setting(containerEl).setName(name).setDesc(desc)
			.addToggle((t) => t.setValue(s[key]).onChange(async (v) => { s[key] = v; await p.saveSettings(); }));

		text('Global variables note', 'Its properties are available in every note. Created the first time you set a global variable.', 'globalNote');
		text('Inherit property', 'A note with this property (a link or a list of links) also uses those notes’ variables.', 'inheritKey');
		text('List separator', 'Joins list values in code and when copying, e.g. ports [22, 80] → 22,80.', 'listSeparator');
		text('VPN variable', 'The global variable "Set a variable from a network interface" writes to.', 'vpnVariable');
		text('Secrets property', 'A note lists its secret variables here, e.g. vars_secret: [password, "*_hash"]. They are blurred until hovered.', 'secretKey');
		toggle('Blur secrets', 'Blurs secret values in notes and in the Properties panel. Copying still gives the real value.', 'maskSecrets');
		toggle('Also guess secrets from names', 'Off: only what notes list as secret. On: names containing one of the words below are secret too.', 'guessSecrets');
		text('Words for guessing', 'Comma-separated. Only used when guessing is on.', 'secretNames');
		toggle(`Fill in values on ${MOD}C in code blocks`, 'Copying a selection inside a code block in Live Preview copies the values, like the copy button.', 'resolveOnCopy');
		text('Skip', 'One per line: a folder ending in "/", "**/name/" for a folder at any depth, a path, or a filename. Templates are skipped so their {{placeholders}} stay visible.', 'exclude', true);
	}
}
