import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		name: 'unit',
		environment: 'node',
		include: ['tests/**/*.spec.ts'],
		coverage: {
			// v8, matching core: warden runs as an ordinary bun process, not inside workerd
			provider: 'v8',
			reporter: ['text', 'json', 'lcov', 'clover'],
			reportsDirectory: './coverage',
			include: ['src/**'],
			exclude: ['tests/**', '**/*.d.ts']
		}
	}
});
