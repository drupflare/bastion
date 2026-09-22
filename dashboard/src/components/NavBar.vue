<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useSession } from '../composables/useSession';
import ThemeToggle from './ThemeToggle.vue';

const { principal, isOperator } = useSession();
const route = useRoute();

const OPERATOR_TABS = [
	{ to: '/', label: 'Overview', icon: 'i-lucide-layout-dashboard' },
	{ to: '/tenants', label: 'Tenants', icon: 'i-lucide-users' },
	{ to: '/health', label: 'Health', icon: 'i-lucide-activity' },
	{ to: '/analytics', label: 'Analytics', icon: 'i-lucide-chart-line' },
	{ to: '/cluster', label: 'Cluster', icon: 'i-lucide-server' },
	{ to: '/config', label: 'Configuration', icon: 'i-lucide-settings' },
	{ to: '/logs', label: 'Logs', icon: 'i-lucide-scroll-text' },
	{ to: '/operations', label: 'Operations', icon: 'i-lucide-wrench' },
	{ to: '/manual', label: 'Manual', icon: 'i-lucide-book-open' }
];

const TENANT_TABS = OPERATOR_TABS.filter((tab) =>
	['/', '/tenants', '/analytics', '/logs', '/manual'].includes(tab.to)
).map((tab) => (tab.to === '/tenants' ? { ...tab, label: 'My Sites' } : tab));

// `aria-current` rather than colour alone, which 1.4.1 refuses as the only signal; the weight and
// underline carry the same state for anyone not using assistive technology
const tabs = computed(() =>
	(isOperator.value ? OPERATOR_TABS : TENANT_TABS).map((tab) => ({
		...tab,
		current: route.path === tab.to
	}))
);
</script>

<template>
	<nav
		aria-label="Sections"
		class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-default px-4 py-2"
	>
		<span class="py-1 text-lg font-semibold">bastion</span>
		<ULink
			v-for="tab in tabs"
			:key="tab.to"
			:to="tab.to"
			:aria-current="tab.current ? 'page' : undefined"
			class="inline-flex min-h-6 items-center gap-1 rounded px-1 text-sm text-muted hover:text-default aria-[current]:font-semibold aria-[current]:text-default aria-[current]:underline aria-[current]:decoration-2 aria-[current]:underline-offset-4"
			data-test="tab"
		>
			<UIcon
				:name="tab.icon"
				class="size-4"
			/>
			{{ tab.label }}
		</ULink>
		<!-- `ml-auto` only once the row fits: on a wrapped row it pushes this past the viewport
		edge, which is a horizontal scroll at 200% text size -->
		<div class="flex items-center gap-2 sm:ml-auto">
			<UBadge
				color="neutral"
				variant="subtle"
				data-test="principal"
			>
				{{ principal?.role ?? 'signed out'
				}}<template v-if="principal?.tenant"> / {{ principal.tenant }}</template>
			</UBadge>
			<ThemeToggle />
		</div>
	</nav>
</template>
