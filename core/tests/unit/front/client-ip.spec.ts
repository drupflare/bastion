import { describe, expect, it } from 'vitest';
import {
	CLIENT_IP_HEADER,
	FORWARDED_FOR,
	inCidr,
	isTrusted,
	resolveClientIp,
	sanitiseInbound
} from '../../../src/front/client-ip';

const h = (init: Record<string, string> = {}): Headers => new Headers(init);
const NO_PROXIES = { trustedProxies: [] };

describe('inCidr', () => {
	it('matches a bare address as a /32', () => {
		expect(inCidr('10.0.0.1', '10.0.0.1')).toBe(true);
		expect(inCidr('10.0.0.2', '10.0.0.1')).toBe(false);
	});

	it('matches inside a prefix and not outside it', () => {
		expect(inCidr('10.0.1.5', '10.0.0.0/16')).toBe(true);
		expect(inCidr('10.1.1.5', '10.0.0.0/16')).toBe(false);
	});

	it('handles a non-byte-aligned prefix', () => {
		expect(inCidr('10.0.0.5', '10.0.0.0/30')).toBe(false);
		expect(inCidr('10.0.0.2', '10.0.0.0/30')).toBe(true);
	});

	it('refuses garbage rather than matching it', () => {
		expect(inCidr('nope', '10.0.0.0/8')).toBe(false);
		expect(inCidr('10.0.0.1', 'nope')).toBe(false);
		expect(inCidr('10.0.0.1', '10.0.0.0/99')).toBe(false);
	});
});

describe('resolveClientIp', () => {
	// with nobody trusted, a header cannot move the attributed address at all
	it('uses the peer address when no proxy is trusted', () => {
		expect(resolveClientIp('203.0.113.9', h({ [FORWARDED_FOR]: '1.2.3.4' }), NO_PROXIES)).toBe(
			'203.0.113.9'
		);
	});

	it('ignores the header when the peer is not itself trusted', () => {
		expect(
			resolveClientIp('203.0.113.9', h({ [FORWARDED_FOR]: '1.2.3.4' }), {
				trustedProxies: ['10.0.0.0/8']
			})
		).toBe('203.0.113.9');
	});

	it('takes the client from a trusted proxy chain', () => {
		expect(
			resolveClientIp('10.0.0.1', h({ [FORWARDED_FOR]: '203.0.113.9' }), {
				trustedProxies: ['10.0.0.0/8']
			})
		).toBe('203.0.113.9');
	});

	// a client can PREPEND entries but cannot remove what the trusted hops appended, so the
	// rightmost untrusted hop is the one it cannot forge
	it('walks from the right, so a prepended entry cannot win', () => {
		expect(
			resolveClientIp('10.0.0.1', h({ [FORWARDED_FOR]: '9.9.9.9, 203.0.113.9' }), {
				trustedProxies: ['10.0.0.0/8']
			})
		).toBe('203.0.113.9');
	});

	it('skips trailing trusted hops to find the client', () => {
		expect(
			resolveClientIp('10.0.0.1', h({ [FORWARDED_FOR]: '203.0.113.9, 10.0.0.7, 10.0.0.8' }), {
				trustedProxies: ['10.0.0.0/8']
			})
		).toBe('203.0.113.9');
	});

	it('falls back to the peer when every hop is trusted', () => {
		expect(
			resolveClientIp('10.0.0.1', h({ [FORWARDED_FOR]: '10.0.0.7' }), {
				trustedProxies: ['10.0.0.0/8']
			})
		).toBe('10.0.0.1');
	});
});

describe('sanitiseInbound', () => {
	// the whole point: a client-supplied value never reaches workerd
	it('overwrites a client-supplied CF-Connecting-IP with the peer address', () => {
		const out = sanitiseInbound(
			h({ [CLIENT_IP_HEADER]: '1.2.3.4' }),
			'203.0.113.9',
			NO_PROXIES
		);
		expect(out.get(CLIENT_IP_HEADER)).toBe('203.0.113.9');
	});

	it('sets it even when the client sent nothing', () => {
		expect(sanitiseInbound(h(), '203.0.113.9', NO_PROXIES).get(CLIENT_IP_HEADER)).toBe(
			'203.0.113.9'
		);
	});

	it('strips the other cf- headers a client could fake', () => {
		const out = sanitiseInbound(
			h({ 'cf-ipcountry': 'XX', 'cf-ray': 'fake', 'cf-visitor': '{}' }),
			'203.0.113.9',
			NO_PROXIES
		);
		expect(out.get('cf-ipcountry')).toBe(null);
		expect(out.get('cf-ray')).toBe(null);
		expect(out.get('cf-visitor')).toBe(null);
	});

	it('drops X-Forwarded-For entirely when nobody is trusted', () => {
		expect(
			sanitiseInbound(h({ [FORWARDED_FOR]: '1.2.3.4' }), '203.0.113.9', NO_PROXIES).get(
				FORWARDED_FOR
			)
		).toBe(null);
	});

	it('keeps it when a proxy is trusted, since the chain is then meaningful', () => {
		const out = sanitiseInbound(h({ [FORWARDED_FOR]: '203.0.113.9' }), '10.0.0.1', {
			trustedProxies: ['10.0.0.0/8']
		});
		expect(out.get(FORWARDED_FOR)).toBe('203.0.113.9');
		expect(out.get(CLIENT_IP_HEADER)).toBe('203.0.113.9');
	});

	it('leaves every other header alone', () => {
		const out = sanitiseInbound(
			h({ host: 'a.edu', accept: 'text/html' }),
			'1.1.1.1',
			NO_PROXIES
		);
		expect(out.get('host')).toBe('a.edu');
		expect(out.get('accept')).toBe('text/html');
	});

	it('does not mutate the headers it was given', () => {
		const original = h({ [CLIENT_IP_HEADER]: '1.2.3.4' });
		sanitiseInbound(original, '203.0.113.9', NO_PROXIES);
		expect(original.get(CLIENT_IP_HEADER)).toBe('1.2.3.4');
	});

	// two peers must produce two different affinity inputs; a constant there collapsed 100% of
	// anonymous traffic onto one replica lane in the sibling's recorded defect
	it('gives different peers different attributed addresses', () => {
		const a = sanitiseInbound(h(), '203.0.113.1', NO_PROXIES).get(CLIENT_IP_HEADER);
		const b = sanitiseInbound(h(), '203.0.113.2', NO_PROXIES).get(CLIENT_IP_HEADER);
		expect(a).not.toBe(b);
	});
});

describe('isTrusted', () => {
	it('is false with no policy', () => {
		expect(isTrusted('10.0.0.1', NO_PROXIES)).toBe(false);
	});

	it('is true inside any listed range', () => {
		expect(isTrusted('10.0.0.1', { trustedProxies: ['192.168.0.0/16', '10.0.0.0/8'] })).toBe(
			true
		);
	});
});
