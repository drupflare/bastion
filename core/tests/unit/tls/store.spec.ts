import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import {
	CertificateStore,
	EXPIRY_LADDER,
	expiryOf,
	expirySeverity,
	hostsOf,
	type StoredCertificate
} from '../../../src/tls/store';

const certificatePem = readFileSync(
	new URL('../../fixtures/tls/cert.pem', import.meta.url),
	'utf8'
);
const privateKeyPem = readFileSync(new URL('../../fixtures/tls/key.pem', import.meta.url), 'utf8');
const DAY = 86_400_000;

function store() {
	const files = memoryFiles();
	const ctx = { ...defaultContext(), files, io: memoryIo(), env: {}, now: () => 0 };
	return { store: new CertificateStore(ctx, '/certs'), files };
}

function stored(expiresAt: number): StoredCertificate {
	return {
		hosts: ['www.example.edu'],
		certificatePem,
		privateKeyPem,
		issuedAt: 0,
		expiresAt,
		source: 'acme'
	};
}

describe('expiryOf', () => {
	it('reads notAfter from the certificate rather than assuming ninety days', () => {
		expect(expiryOf(certificatePem)).toBeGreaterThan(Date.parse('2035-01-01'));
	});

	it('refuses something that is not a certificate', () => {
		expect(() => expiryOf('not a certificate')).toThrow(/does not parse/);
	});
});

describe('hostsOf', () => {
	it('reads every DNS name out of the SAN', () => {
		expect(hostsOf(certificatePem)).toEqual(['www.example.edu', 'lab.example.edu']);
	});
});

describe('expirySeverity', () => {
	it('climbs the ladder as the expiry approaches', () => {
		const now = 0;
		expect(expirySeverity(stored(30 * DAY), now)).toBe('ok');
		expect(expirySeverity(stored(EXPIRY_LADDER.warn * DAY), now)).toBe('warn');
		expect(expirySeverity(stored(EXPIRY_LADDER.error * DAY), now)).toBe('error');
		expect(expirySeverity(stored(EXPIRY_LADDER.critical * DAY), now)).toBe('critical');
		expect(expirySeverity(stored(-1), now)).toBe('expired');
	});
});

describe('CertificateStore', () => {
	it('round trips a certificate', () => {
		const { store: s } = store();
		s.save('www.example.edu', stored(DAY * 60));
		expect(s.load('www.example.edu')?.certificatePem).toBe(certificatePem);
		expect(s.load('www.example.edu')?.source).toBe('acme');
	});

	it('writes the key readable by nobody else', () => {
		const { store: s, files } = store();
		s.save('www.example.edu', stored(DAY));
		expect(files.mode('/certs/www.example.edu/key.pem')).toBe(0o600);
	});

	it('answers null for a host it does not hold', () => {
		expect(store().store.load('nope.example.edu')).toBe(null);
	});

	it('answers null for a half-written pair rather than handing out a mismatch', () => {
		const { store: s, files } = store();
		s.save('www.example.edu', stored(DAY));
		files.remove('/certs/www.example.edu/key.pem');
		expect(s.load('www.example.edu')).toBe(null);
	});

	it('leaves a host with no usable pair out of the SNI table', () => {
		const { store: s, files } = store();
		s.save('a.example.edu', stored(DAY));
		s.save('b.example.edu', stored(DAY));
		files.remove('/certs/b.example.edu/fullchain.pem');
		expect(s.material().map((m) => m.serverName)).toEqual(['a.example.edu']);
	});

	it('builds the SNI table the listener is bound with', () => {
		const { store: s } = store();
		s.save('www.example.edu', stored(DAY));
		expect(s.material()[0]).toEqual({
			serverName: 'www.example.edu',
			key: privateKeyPem,
			cert: certificatePem
		});
	});

	it('refuses a hostname that is a path', () => {
		expect(() => store().store.load('../../etc/passwd')).toThrow(/not a hostname/);
	});

	it('lists only the hosts at warn or worse as due', () => {
		const { store: s } = store();
		s.save('fine.example.edu', stored(DAY * 60));
		s.save('soon.example.edu', stored(DAY * 5));
		expect(s.due(0)).toEqual([{ host: 'soon.example.edu', severity: 'error' }]);
	});

	it('lists nothing before anything has been stored', () => {
		expect(store().store.list()).toEqual([]);
	});
});
