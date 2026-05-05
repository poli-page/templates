#!/usr/bin/env node
/**
 * Generates the CLI-import surface of the templates repo:
 *   - <repo>/index.json (root discovery)
 *   - <coll>/templates/<tpl>/manifest.json (per-template manifest)
 *   - <coll>/templates/<tpl>/tailwind-additions.css (per-template tailwind block)
 *
 * Run after editing CONFIG below or after adding/removing a template.
 *
 *   node tools/build-template-manifests.mjs
 *
 * The collection-level poli-page.json and tailwind.css remain the source
 * of truth; this script derives the per-template files from them.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const CONFIG = {
	collections: {
		showcase: {
			title: 'Showcase',
			description: 'Production-grade templates',
			templates: {
				invoice: 'Modern invoice with brand accent stripe',
				contract: 'Formal contract with signature block',
				report: 'Multi-page business report',
				certificate: 'A5 landscape achievement certificate',
				'delivery-note': 'Delivery note with itemized table',
				'pay-slip': 'French-style monthly pay slip',
				'cerfa-15776': 'Official French CERFA 15776 form',
			},
		},
		structures: {
			title: 'Layouts',
			description: 'Empty structural layouts ready to fill in',
			templates: {
				blank: 'Empty page — start from scratch',
				'header-main-footer': 'Classic 3-band layout',
				'header-main-footer-sidebar': 'Header, main, footer with sidebar below',
				'header-main-sidebar-footer': 'Header, main, sidebar, footer',
				'header-sidebar-main-footer': 'Header on top, sidebar + main, footer',
				'sidebar-header-main-footer': 'Side bar full height, header + main + footer',
			},
		},
		playground: {
			title: 'Playground',
			description: 'Quick demos for the online playground',
			templates: {
				empty: 'Minimal starting point',
				invoice: 'Invoice demo',
				report: 'Report demo',
				certificate: 'Certificate demo',
				'header-sidebar-main-footer': 'Layout demo with sidebar',
			},
		},
		'getting-started': {
			title: 'Getting Started',
			description: 'Tutorial sequence for newcomers',
			templates: {
				welcome: 'Welcome page — start here',
				'01-layout-essentials': 'Lesson 1 — layout essentials',
				'02-data-and-content': 'Lesson 2 — data binding and content',
				'03-multi-format-and-flow': 'Lesson 3 — multi-format and flow',
			},
		},
	},
};

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp)$/i;

const warnings = [];

async function main() {
	await writeIndex();
	for (const [collName, coll] of Object.entries(CONFIG.collections)) {
		await processCollection(collName, coll);
	}
	if (warnings.length > 0) {
		console.warn('\n⚠ Warnings:');
		for (const w of warnings) console.warn('  - ' + w);
	}
	console.log('\n✓ Manifests generated');
}

async function writeIndex() {
	const collections = {};
	for (const [name, coll] of Object.entries(CONFIG.collections)) {
		collections[name] = {
			title: coll.title,
			description: coll.description,
			templates: Object.entries(coll.templates).map(([tName, desc]) => ({
				name: tName,
				description: desc,
			})),
		};
	}
	const index = {
		$schema: 'poli-page/templates/v1',
		collections,
	};
	const target = path.join(REPO, 'index.json');
	await fs.writeFile(target, JSON.stringify(index, null, 2) + '\n', 'utf-8');
	console.log(`✓ ${path.relative(REPO, target)}`);
}

async function processCollection(collName, coll) {
	const collDir = path.join(REPO, collName);
	const collManifestPath = path.join(collDir, 'poli-page.json');
	const collTailwindPath = path.join(collDir, 'tailwind.css');

	const collManifest = JSON.parse(await fs.readFile(collManifestPath, 'utf-8'));
	const collTailwind = await readOrEmpty(collTailwindPath);
	const availableFonts = await listFontsInCollection(collDir);

	for (const tplName of Object.keys(coll.templates)) {
		const tplDir = path.join(collDir, 'templates', tplName);
		const htmlPath = path.join(tplDir, `${tplName}.html`);

		let html;
		try {
			html = await fs.readFile(htmlPath, 'utf-8');
		} catch {
			warnings.push(`${collName}/${tplName}: ${tplName}.html not found — skipping`);
			continue;
		}

		const entry = collManifest.templates?.find((t) => t.name === tplName);
		if (!entry) {
			warnings.push(`${collName}/${tplName}: not declared in <coll>/poli-page.json — skipping`);
			continue;
		}

		const fonts = (collManifest.fonts ?? []).filter((f) => {
			if (availableFonts.has(path.basename(f.src))) return true;
			warnings.push(
				`${collName}/${tplName}: declared font "${f.family}" (${f.src}) is missing on disk — excluded from manifest`
			);
			return false;
		});

		const images = extractImageBasenames(html);

		const manifest = {
			template: {
				name: entry.name,
				template: entry.template,
				mock: entry.mock,
				...(entry.format && { format: entry.format }),
				...(entry.orientation && { orientation: entry.orientation }),
			},
			images,
			fonts,
		};

		await fs.writeFile(
			path.join(tplDir, 'manifest.json'),
			JSON.stringify(manifest, null, 2) + '\n',
			'utf-8'
		);

		const tailwindAdditions =
			collTailwind ||
			'/* No collection-level tailwind tokens. Add template-specific @theme directives here if needed. */\n';
		await fs.writeFile(
			path.join(tplDir, 'tailwind-additions.css'),
			tailwindAdditions,
			'utf-8'
		);

		console.log(`✓ ${collName}/${tplName} (${images.length} image(s), ${fonts.length} font(s))`);
	}
}

async function listFontsInCollection(collDir) {
	const fontDir = path.join(collDir, 'assets', 'fonts');
	try {
		const entries = await fs.readdir(fontDir);
		return new Set(entries);
	} catch {
		return new Set();
	}
}

function extractImageBasenames(html) {
	const found = new Set();
	const patterns = [
		/poli-asset=["']([^"']+)["']/g,
		/<img[^>]+src=["']([^"']+)["']/g,
		/<image[^>]+(?:href|xlink:href)=["']([^"']+)["']/g,
		/url\(\s*["']?([^"')]+)["']?\s*\)/g,
		/<source[^>]+srcset=["']([^"']+)["']/g,
	];
	for (const re of patterns) {
		for (const m of html.matchAll(re)) {
			const src = m[1];
			if (!src || src.startsWith('data:') || /^https?:\/\//.test(src)) continue;
			const basename = path.basename(src);
			if (IMAGE_EXT.test(basename)) {
				found.add(basename);
			}
		}
	}
	return [...found].sort();
}

async function readOrEmpty(filepath) {
	try {
		return await fs.readFile(filepath, 'utf-8');
	} catch {
		return '';
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
