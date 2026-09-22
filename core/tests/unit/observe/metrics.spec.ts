import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/defaults';
import { defaultContext } from '../../../src/context';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import { LogWriter, formatLine, parseAge } from '../../../src/observe/logs';
import { Registry } from '../../../src/observe/metrics';

describe('Registry', () => {
	it('labels every series with the node it came from', () => {
		const registry = new Registry('node-a');
		registry.counter('bastion_requests_total', 'requests', { tenant: 'acme' });
		expect(registry.render()).toContain('node="node-a"');
	});

	it('carries the tenant and site labels a billing rollup needs', () => {
		const registry = new Registry('node-a');
		registry.counter('bastion_requests_total', 'requests', {
			tenant: 'acme',
			site: 'www.example.edu'
		});
		const text = registry.render();
		expect(text).toContain('tenant="acme"');
		expect(text).toContain('site="www.example.edu"');
	});

	it('keeps one series per label set rather than summing them together', () => {
		const registry = new Registry();
		registry.counter('x', 'h', { tenant: 'a' });
		registry.counter('x', 'h', { tenant: 'b' });
		expect(registry.size).toBe(2);
	});

	it('adds to a counter and replaces a gauge', () => {
		const registry = new Registry();
		registry.counter('c', 'h', {}, 2);
		registry.counter('c', 'h', {}, 3);
		registry.gauge('g', 'h', 1);
		registry.gauge('g', 'h', 9);
		const text = registry.render();
		expect(text).toContain('c{node="local"} 5');
		expect(text).toContain('g{node="local"} 9');
	});

	it('renders a histogram with cumulative buckets, a sum and a count', () => {
		const registry = new Registry();
		registry.observe('d', 'durations', 7);
		registry.observe('d', 'durations', 300);
		const text = registry.render();
		expect(text).toContain('d_count{node="local"} 2');
		expect(text).toContain('d_sum{node="local"} 307');
		expect(text).toContain('le="+Inf"} 2');
		expect(text).toContain('d_bucket{node="local",le="10"} 1');
	});

	it('emits HELP and TYPE once per metric name', () => {
		const registry = new Registry();
		registry.counter('x', 'the help', { tenant: 'a' });
		registry.counter('x', 'the help', { tenant: 'b' });
		expect(registry.render().match(/# HELP x /g)).toHaveLength(1);
	});

	it('strips characters that would break the exposition format', () => {
		const registry = new Registry();
		registry.counter('x', 'h', { tenant: 'a"b\nc' });
		expect(registry.render()).toContain('tenant="abc"');
	});

	it('federates several nodes without repeating the headers', () => {
		const a = new Registry('node-a');
		a.counter('x', 'h', { tenant: 't' });
		const b = new Registry('node-b');
		b.counter('x', 'h', { tenant: 't' });
		const merged = Registry.federate([a.render(), b.render()]);
		expect(merged.match(/# TYPE x /g)).toHaveLength(1);
		expect(merged).toContain('node="node-a"');
		expect(merged).toContain('node="node-b"');
	});
});

describe('parseAge', () => {
	it('reads hours, days, weeks and months', () => {
		expect(parseAge('2h')).toBe(7_200_000);
		expect(parseAge('14d')).toBe(14 * 86_400_000);
		expect(parseAge('1w')).toBe(7 * 86_400_000);
		expect(parseAge('6m')).toBe(6 * 30 * 86_400_000);
	});

	it('answers null for nonsense rather than a default that would silently prune', () => {
		expect(parseAge('soon')).toBe(null);
		expect(parseAge(undefined)).toBe(null);
	});
});

describe('LogWriter', () => {
	function harness(level: 'debug' | 'info' = 'info') {
		const files = memoryFiles();
		const ctx = { ...defaultContext(), files, io: memoryIo(), env: {} };
		const config = { ...defaultConfig().logs, level };
		return { files, writer: new LogWriter(ctx, '/logs', config) };
	}

	it('drops a debug line at the default level', () => {
		const { writer, files } = harness();
		expect(writer.write({ at: 0, level: 'debug', message: 'served' })).toBe(false);
		expect(files.exists('/logs/debug.ndjson')).toBe(false);
	});

	it('writes debug lines to their own file once the level allows it', () => {
		const { writer, files } = harness('debug');
		writer.write({ at: 0, level: 'debug', message: 'served' });
		writer.write({ at: 0, level: 'info', message: 'up' });
		expect(files.exists('/logs/debug.ndjson')).toBe(true);
		expect(files.readText('/logs/bastion.ndjson')).toContain('up');
		expect(files.readText('/logs/debug.ndjson')).not.toContain('up');
	});

	it('formats a line as JSON with an ISO timestamp', () => {
		const line = formatLine({ at: 0, level: 'info', message: 'up', tenant: 'acme' });
		expect(JSON.parse(line)).toMatchObject({ level: 'info', message: 'up', tenant: 'acme' });
		expect(JSON.parse(line).at).toBe('1970-01-01T00:00:00.000Z');
	});

	it('reads the most recent lines back', () => {
		const { writer } = harness();
		for (let i = 0; i < 5; i++) writer.write({ at: i, level: 'info', message: `m${i}` });
		expect(writer.read('info', 2).map((l) => l.message)).toEqual(['m3', 'm4']);
	});

	it('prunes by age', () => {
		const { writer } = harness();
		const now = 30 * 86_400_000;
		writer.write({ at: 0, level: 'info', message: 'ancient' });
		writer.write({ at: now, level: 'info', message: 'fresh' });
		expect(writer.prune('info', now).dropped).toBe(1);
		expect(writer.read('info').map((l) => l.message)).toEqual(['fresh']);
	});

	it('prunes debug harder than the rest, which is what keeps a disk from filling', () => {
		const { writer } = harness('debug');
		const now = 5 * 86_400_000;
		writer.write({ at: 0, level: 'debug', message: 'old' });
		writer.write({ at: 0, level: 'info', message: 'old' });
		expect(writer.prune('debug', now).dropped).toBe(1);
		expect(writer.prune('info', now).dropped).toBe(0);
	});

	it('pruning a file that is not there is not an error', () => {
		expect(harness().writer.prune('info', 0)).toEqual({ dropped: 0 });
	});
});
