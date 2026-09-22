import tailwindcss from '@tailwindcss/vite';
import { defineNuxtConfig } from 'nuxt/config';

export default defineNuxtConfig({
	srcDir: 'src',
	ssr: false,
	// the SEO, image, font-CDN and Cloudflare modules the sibling apps carry are deliberately
	// absent: this console is served from 127.0.0.1 on a box that may have no route to the
	// internet, so a module whose job is to fetch from one is a module that makes it hang
	modules: [
		'@nuxt/ui',
		'@nuxt/icon',
		'@nuxtjs/color-mode',
		'nuxt-viewport',
		'@vueuse/nuxt',
		'@nuxt/hints'
	],
	icon: {
		mode: 'css',
		cssLayer: 'base',
		// bundled at build time rather than fetched from the iconify API, because the dashboard
		// ships inside the binary and an icon that needs the network is an icon that never renders
		clientBundle: { scan: true, includeCustomCollections: true },
		provider: 'none'
	},
	colorMode: { classSuffix: '', storageKey: 'bastion-color-mode' },
	viewport: {
		breakpoints: { xs: 320, sm: 640, md: 768, lg: 1024, xl: 1280 },
		defaultBreakpoints: { desktop: 'lg', mobile: 'xs', tablet: 'md' },
		fallbackBreakpoint: 'lg'
	},
	hints: { features: { lazyLoad: false } },
	devtools: { enabled: false },
	telemetry: false,
	css: ['~/assets/main.css'],
	vite: { plugins: [tailwindcss()] },
	nitro: {
		preset: 'static',
		prerender: { crawlLinks: false, routes: ['/'] },
		devProxy: {
			'/api': {
				target: process.env.BASTION_API ?? 'https://127.0.0.1:8788/api',
				changeOrigin: true,
				secure: false
			},
			'/rig': {
				target:
					process.env.BASTION_API?.replace(/\/api$/, '/rig') ??
					'https://127.0.0.1:8788/rig',
				changeOrigin: true,
				secure: false
			}
		}
	},
	app: {
		baseURL: '/',
		head: {
			title: 'bastion',
			htmlAttrs: { lang: 'en' },
			meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }]
		}
	},
	runtimeConfig: {
		public: {
			apiBase: process.env.NUXT_PUBLIC_API_BASE || ''
		}
	},
	compatibilityDate: '2026-09-01'
});
