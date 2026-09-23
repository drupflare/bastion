import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../../src/version';

/**
 * The version the code reports and the version the manifests publish.
 *
 * Three files carry it and nothing held them together, so a bump could land in the manifests and
 * not in the source. The release job does compare them, but only after a cross compile, which is
 * an expensive way to find out; this fails in the gate instead.
 */
const repo = join(import.meta.dirname, '..', '..', '..');
const manifest = (name: string): string =>
	(JSON.parse(readFileSync(join(repo, name, 'package.json'), 'utf8')) as { version: string })
		.version;

/** read rather than imported, so a core spec does not depend on the package above it */
function sourceVersion(workspace: string): string {
	const source = readFileSync(join(repo, workspace, 'src', 'version.ts'), 'utf8');
	return /VERSION = '([^']+)'/.exec(source)?.[1] ?? '';
}

describe('the released version', () => {
	it('is the same in the core manifest as in the source', () => {
		expect(VERSION).toBe(manifest('core'));
	});

	/** `bastion --version` reports warden's copy, and the release job compares it to core's */
	it('is the same in the warden manifest as in warden s source', () => {
		expect(sourceVersion('warden')).toBe(manifest('warden'));
	});

	/** one release cannot publish two versions, and the release job refuses when they differ */
	it('is the same in both manifests', () => {
		expect(manifest('warden')).toBe(manifest('core'));
	});

	it('is a plain semver, because it becomes a tag and an npm version', () => {
		expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
