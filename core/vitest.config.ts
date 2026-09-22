import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					environment: 'node',
					include: ['tests/unit/**/*.spec.ts']
				}
			},
			{
				test: {
					name: 'e2e',
					environment: 'node',
					include: ['tests/e2e/**/*.spec.ts'],
					// a workerd boot, an image pull and a pack replay; nothing here is fast
					testTimeout: 600_000,
					hookTimeout: 900_000,
					// one workerd and one compose stack, shared; parallel files would race them
					fileParallelism: false,
					maxWorkers: 1
				}
			}
		],
		coverage: {
			// v8, NOT istanbul: bastion runs OUTSIDE workerd, so the inspector reads it correctly
			provider: 'v8',
			reporter: ['text', 'json', 'lcov', 'clover'],
			reportsDirectory: './coverage',
			include: ['src/**'],
			exclude: ['tests/**', '**/*.d.ts']
		}
	}
});
