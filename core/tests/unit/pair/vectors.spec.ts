import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	CHALLENGE_CONTEXT,
	ENVELOPE_CONTEXT,
	fromBase64Url,
	LEAVES_THE_BOX,
	NEVER_LEAVES_THE_BOX,
	signCanonical,
	signChallengeResponse,
	signEnvelope,
	signingInput,
	signingKeyFromSeed,
	verifyChallengeResponse,
	verifyEnvelope,
	type Envelope
} from '../../../src/pair/wire';

/**
 * The control plane's signed vectors, copied from `contracts/vectors/fleet-link.json` in the
 * dashboard repo. Bastion carries its own implementation of the wire format, so this is what proves
 * the two agree, in both directions: every positive case verifies, every negative case is refused
 * with the listed code, and signing the same message here reproduces the vector's signature.
 */
const fixture = new URL('../../fixtures/pair/fleet-link.json', import.meta.url);
const checkout = new URL('../../../../../dashboard/contracts/', import.meta.url);

type Case = {
	name: string;
	kind: 'envelope' | 'challenge';
	input: Record<string, unknown> & { sig: string };
	context: Record<string, any>;
	signingInput?: string;
	expect: string;
};
type Vectors = {
	keys: Record<string, { seed: string; publicKey: string }>;
	positive: Case[];
	negative: Case[];
};

const vectors = JSON.parse(readFileSync(fixture, 'utf8')) as Vectors;

function verify(c: Case) {
	if (c.kind === 'challenge') {
		return verifyChallengeResponse(c.input, c.context as never);
	}
	return verifyEnvelope(c.input, {
		...c.context,
		seen: new Set<string>(c.context.seen ?? [])
	} as never);
}

describe('the contract vectors', () => {
	for (const c of vectors.positive) {
		it(`verifies ${c.name}`, () => {
			expect(verify(c).ok).toBe(true);
			if (c.signingInput !== undefined) {
				const { sig: _sig, ...unsigned } = c.input;
				const context = c.kind === 'challenge' ? CHALLENGE_CONTEXT : ENVELOPE_CONTEXT;
				expect(c.signingInput).toBe(signingInput(context, unsigned));
			}
		});
	}

	for (const c of vectors.negative) {
		it(`refuses ${c.name} with ${c.expect}`, () => {
			const result = verify(c);
			expect(result.ok).toBe(false);
			expect(result.ok ? null : result.code).toBe(c.expect);
		});
	}

	it('signs each positive envelope to the same signature the vector carries', () => {
		const nodeKey = signingKeyFromSeed(fromBase64Url(vectors.keys.node!.seed));
		const dashboardKey = signingKeyFromSeed(fromBase64Url(vectors.keys.dashboard!.seed));
		expect(nodeKey.publicKey).toBe(vectors.keys.node!.publicKey);
		expect(dashboardKey.publicKey).toBe(vectors.keys.dashboard!.publicKey);

		const envelopes = vectors.positive.filter(
			(c) => c.kind === 'envelope' && c.name !== 'reordered-fields-verify'
		);
		expect(envelopes.length).toBeGreaterThanOrEqual(7);
		for (const c of envelopes) {
			const { sig, ...unsigned } = c.input;
			const key = c.input.type === 'command' ? dashboardKey : nodeKey;
			const again = signEnvelope(unsigned as unknown as Omit<Envelope, 'sig'>, key);
			expect(again.sig, c.name).toBe(sig);
		}
	});

	it('signs the challenge response to the same signature the vector carries', () => {
		const nodeKey = signingKeyFromSeed(fromBase64Url(vectors.keys.node!.seed));
		const c = vectors.positive.find((entry) => entry.kind === 'challenge')!;
		const { sig, v: _v, ...fields } = c.input;
		const again = signChallengeResponse(fields as never, nodeKey);
		expect(again.sig).toBe(sig);
	});

	it('refuses a signature made for the other context', () => {
		const key = signingKeyFromSeed(fromBase64Url(vectors.keys.node!.seed));
		const c = vectors.positive.find((entry) => entry.name === 'node-audit')!;
		const { sig: _sig, ...unsigned } = c.input;
		const crossed = { ...unsigned, sig: signCanonical(CHALLENGE_CONTEXT, unsigned, key) };
		const result = verifyEnvelope(crossed, {
			publicKey: key.publicKey,
			direction: 'node',
			now: c.context.now
		});
		expect(result).toEqual({ ok: false, code: 'bad_signature' });
	});
});

describe('the dashboard checkout', () => {
	const present = existsSync(new URL('vectors/fleet-link.json', checkout));

	it.skipIf(!present)('holds the same vectors this copy was made from', () => {
		const live = readFileSync(new URL('vectors/fleet-link.json', checkout), 'utf8');
		expect(readFileSync(fixture, 'utf8')).toBe(live);
	});

	it.skipIf(!present)('lists the same fields as leaving the box', () => {
		const source = readFileSync(new URL('src/fleet-link.ts', checkout), 'utf8');
		const block = /export const LEAVES_THE_BOX = \[([\s\S]*?)\] as const;/.exec(source)![1]!;
		const live = [
			...block.matchAll(
				/type:\s*'([^']+)',\s*field:\s*'([^']+)',\s*description:\s*'([^']+)'/g
			)
		].map((match) => ({ type: match[1], field: match[2], description: match[3] }));
		expect(live.length).toBeGreaterThan(20);
		expect(LEAVES_THE_BOX).toEqual(live);
	});

	it.skipIf(!present)('names the same things as never leaving the box', () => {
		const source = readFileSync(new URL('src/fleet-link.ts', checkout), 'utf8');
		const block = /export const NEVER_LEAVES_THE_BOX = \[([\s\S]*?)\] as const;/.exec(
			source
		)![1]!;
		const live = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
		expect([...NEVER_LEAVES_THE_BOX]).toEqual(live);
	});
});
