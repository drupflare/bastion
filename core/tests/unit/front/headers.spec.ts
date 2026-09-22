import { describe, expect, it } from 'vitest';
import { CLIENT_IP_HEADER } from '../../../src/front/client-ip';
import {
	applyHeaders,
	checkHeaderPolicy,
	defaultResponseHeaders,
	RESERVED_REQUEST_HEADERS,
	RESERVED_RESPONSE_HEADERS
} from '../../../src/front/headers';
import { redirectFor, redirectResponse } from '../../../src/front/redirect';

describe('checkHeaderPolicy', () => {
	it('accepts an ordinary custom header', () => {
		expect(
			checkHeaderPolicy({
				response: [{ path: '/', set: { 'x-frame-options': 'SAMEORIGIN' } }]
			})
		).toEqual([]);
	});

	it('refuses a site setting the connecting address, which is the whole spoofing defence', () => {
		const problems = checkHeaderPolicy({
			request: [{ path: '/', set: { [CLIENT_IP_HEADER]: '1.2.3.4' } }]
		});
		expect(problems[0]?.reason).toContain('set by the front door from the connection');
		expect(RESERVED_REQUEST_HEADERS.has(CLIENT_IP_HEADER)).toBe(true);
	});

	it('refuses a site overriding the transport security policy', () => {
		const problems = checkHeaderPolicy({
			response: [{ path: '/', set: { 'strict-transport-security': 'max-age=0' } }]
		});
		expect(problems).toHaveLength(1);
		expect(RESERVED_RESPONSE_HEADERS.has('strict-transport-security')).toBe(true);
	});

	it('refuses a value carrying a newline, which would inject a second header', () => {
		const problems = checkHeaderPolicy({
			response: [{ path: '/', set: { 'x-thing': 'a\r\nset-cookie: stolen=1' } }]
		});
		expect(problems[0]?.reason).toContain('newline');
	});

	it('refuses removing a header the front door owns', () => {
		expect(
			checkHeaderPolicy({ response: [{ path: '/', remove: ['x-content-type-options'] }] })
		).toHaveLength(1);
	});

	it('ignores case, so an uppercase spelling is not a bypass', () => {
		expect(
			checkHeaderPolicy({ request: [{ path: '/', set: { 'CF-Connecting-IP': '1.2.3.4' } }] })
		).toHaveLength(1);
	});
});

describe('applyHeaders', () => {
	it('sets and removes on a matching path', () => {
		const out = applyHeaders(
			new Headers({ 'x-old': 'gone' }),
			[{ path: '/', set: { 'x-new': 'here' }, remove: ['x-old'] }],
			'/anything',
			'response'
		);
		expect(out.get('x-new')).toBe('here');
		expect(out.get('x-old')).toBe(null);
	});

	it('applies a prefix rule only under that prefix', () => {
		const rules = [{ path: '/admin', set: { 'x-admin': '1' } }];
		expect(applyHeaders(new Headers(), rules, '/admin/users', 'response').get('x-admin')).toBe(
			'1'
		);
		expect(applyHeaders(new Headers(), rules, '/adminish', 'response').get('x-admin')).toBe(
			null
		);
		expect(applyHeaders(new Headers(), rules, '/', 'response').get('x-admin')).toBe(null);
	});

	it('enforces the reserved set again at serve time, not only at configuration time', () => {
		const out = applyHeaders(
			new Headers({ [CLIENT_IP_HEADER]: '203.0.113.7' }),
			[{ path: '/', set: { [CLIENT_IP_HEADER]: '1.2.3.4' } }],
			'/',
			'request'
		);
		expect(out.get(CLIENT_IP_HEADER)).toBe('203.0.113.7');
	});

	it('leaves everything alone with no policy', () => {
		const out = applyHeaders(new Headers({ a: '1' }), undefined, '/', 'response');
		expect(out.get('a')).toBe('1');
	});
});

describe('defaultResponseHeaders', () => {
	it('adds nosniff when the site did not', () => {
		expect(defaultResponseHeaders(new Headers()).get('x-content-type-options')).toBe('nosniff');
	});

	it('does not overwrite what is already there', () => {
		const out = defaultResponseHeaders(new Headers({ 'x-content-type-options': 'nosniff' }));
		expect(out.get('x-content-type-options')).toBe('nosniff');
	});
});

describe('redirectFor', () => {
	const url = new URL('https://www.example.edu/node/1?a=1');

	it('sends an alias to the canonical name', () => {
		const outcome = redirectFor(url, 'www.example.edu', {
			canonical: 'example.edu',
			aliases: ['example.edu', 'www.example.edu']
		});
		expect(outcome?.location).toBe('https://example.edu/node/1?a=1');
	});

	it('uses 308 so a POST is not silently turned into a GET', () => {
		const outcome = redirectFor(url, 'www.example.edu', {
			canonical: 'example.edu',
			aliases: []
		});
		expect(outcome?.status).toBe(308);
	});

	it('does not redirect the canonical name to itself', () => {
		expect(redirectFor(url, 'example.edu', { canonical: 'example.edu', aliases: [] })).toBe(
			null
		);
	});

	it('serves every alias as itself when no canonical name is chosen', () => {
		expect(redirectFor(url, 'www.example.edu', { canonical: null, aliases: [] })).toBe(null);
	});

	it('sends http to https when the site asks for it', () => {
		const plain = new URL('http://example.edu/');
		const outcome = redirectFor(plain, 'example.edu', {
			canonical: null,
			aliases: [],
			forceHttps: true
		});
		expect(outcome?.location).toBe('https://example.edu/');
	});

	it('does not redirect https to https', () => {
		expect(
			redirectFor(url, 'www.example.edu', { canonical: null, aliases: [], forceHttps: true })
		).toBe(null);
	});

	it('ignores a port and case in the arriving host, because DNS does', () => {
		expect(
			redirectFor(url, 'Example.EDU:8443', { canonical: 'example.edu', aliases: [] })
		).toBe(null);
	});

	it('builds a cacheable response carrying the location', () => {
		const outcome = redirectFor(url, 'www.example.edu', {
			canonical: 'example.edu',
			aliases: []
		});
		const response = redirectResponse(outcome!);
		expect(response.status).toBe(308);
		expect(response.headers.get('location')).toContain('example.edu');
		expect(response.headers.get('cache-control')).toContain('max-age');
	});
});
