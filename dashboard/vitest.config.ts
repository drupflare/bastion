import { defineVitestProject } from '@nuxt/test-utils/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			await defineVitestProject({
				test: {
					name: 'unit',
					environment: 'nuxt',
					include: ['tests/unit/**/*.spec.ts'],
					environmentOptions: { nuxt: { domEnvironment: 'happy-dom' } }
				}
			})
		]
	}
});
