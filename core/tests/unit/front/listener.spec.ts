import { describe, expect, it } from 'vitest';
import {
	parseAddress,
	recordingListenerHost,
	swapListener,
	type ListenerSpec
} from '../../../src/front/listener';

const material = [{ serverName: 'www.example.edu', key: 'KEY', cert: 'CERT' }];
const handler = async () => new Response('ok');

describe('parseAddress', () => {
	it('splits host and port', () => {
		expect(parseAddress('127.0.0.1:8787')).toEqual({ hostname: '127.0.0.1', port: 8787 });
	});

	it('defaults a bare port to every interface', () => {
		expect(parseAddress('443')).toEqual({ hostname: '0.0.0.0', port: 443 });
	});

	it('takes the last colon so an ipv6 literal survives', () => {
		expect(parseAddress('[::1]:8443')).toEqual({ hostname: '::1', port: 8443 });
	});
});

describe('swapListener', () => {
	const spec: ListenerSpec = { address: '0.0.0.0:443', tls: material };

	it('binds the replacement BEFORE draining the old one, so nothing is unbound', async () => {
		const host = recordingListenerHost();
		const first = await swapListener(host, null, spec, handler);
		expect(host.stopped).toHaveLength(0);
		await swapListener(host, first, { ...spec, tls: material }, handler);
		expect(host.bound).toHaveLength(2);
		expect(host.stopped).toEqual([0]);
	});

	it('always asks for reusePort, which is what makes both listeners hold the port', async () => {
		const host = recordingListenerHost();
		await swapListener(host, null, spec, handler);
		expect(host.bound[0]?.reusePort).toBe(true);
	});

	it('carries the whole SNI table into the replacement', async () => {
		const host = recordingListenerHost();
		const grown = [...material, { serverName: 'lab.example.edu', key: 'K2', cert: 'C2' }];
		const first = await swapListener(host, null, spec, handler);
		await swapListener(host, first, { ...spec, tls: grown }, handler);
		expect(host.bound[1]?.tls).toHaveLength(2);
	});
});
