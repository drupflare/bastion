<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ThemeToggle from '../components/ThemeToggle.vue';
import { useSession } from '../composables/useSession';

const { principal, isOperator, ensure } = useSession();
const route = useRoute();
void ensure();

const SECTIONS = [
	{ to: '/', label: 'Overview', icon: 'i-lucide-layout-dashboard' },
	{ to: '/tenants', label: 'Tenants', icon: 'i-lucide-users' },
	{ to: '/health', label: 'Health', icon: 'i-lucide-activity' },
	{ to: '/analytics', label: 'Analytics', icon: 'i-lucide-chart-line' },
	{ to: '/cluster', label: 'Cluster', icon: 'i-lucide-server' },
	{ to: '/operations', label: 'Operations', icon: 'i-lucide-wrench' },
	{ to: '/config', label: 'Configuration', icon: 'i-lucide-settings' },
	{ to: '/logs', label: 'Logs', icon: 'i-lucide-scroll-text' },
	{ to: '/manual', label: 'Manual', icon: 'i-lucide-book-open' }
];

const TENANT_PATHS = ['/', '/tenants', '/analytics', '/logs', '/manual'];

// `active` drives `aria-current` inside UNavigationMenu, so the current section is announced as
// well as painted; 1.4.1 refuses colour as the only signal
const items = computed<NavigationMenuItem[][]>(() => {
	const visible = isOperator.value
		? SECTIONS
		: SECTIONS.filter((section) => TENANT_PATHS.includes(section.to)).map((section) =>
				section.to === '/tenants' ? { ...section, label: 'My Sites' } : section
			);
	return [
		visible.map((section) => ({
			label: section.label,
			icon: section.icon,
			to: section.to,
			active: route.path === section.to
		}))
	];
});

const ROLE_LABEL: Record<string, string> = {
	operator: 'Operator',
	'tenant-admin': 'Tenant Admin',
	'tenant-viewer': 'Tenant Viewer'
};
</script>

<template>
	<UDashboardGroup unit="rem">
		<!-- off-screen rather than sr-only, whose `padding: 0` fights the padding that gives this a
		real target size once it is focused -->
		<ULink
			to="#main"
			class="absolute -top-16 left-2 z-50 rounded-md bg-inverted px-3 py-2 text-sm text-inverted focus:top-2"
			>Skip to Content</ULink
		>

		<UDashboardSidebar
			id="sections"
			collapsible
			resizable
			:min-size="12"
			:default-size="15"
			:ui="{ footer: 'border-t border-default' }"
		>
			<template #header="{ collapsed }">
				<div class="flex items-center gap-2 overflow-hidden">
					<span
						class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated"
					>
						<UIcon
							name="i-lucide-shield"
							class="size-5 text-primary"
						/>
					</span>
					<span
						v-if="!collapsed"
						class="truncate"
					>
						<span class="block leading-tight font-semibold">bastion</span>
						<span class="block text-xs leading-tight text-muted"
							>workerd, hardened</span
						>
					</span>
				</div>
			</template>

			<template #default="{ collapsed }">
				<UNavigationMenu
					:items="items"
					:collapsed="collapsed"
					orientation="vertical"
					tooltip
					popover
					aria-label="Sections"
				/>
			</template>

			<template #footer="{ collapsed }">
				<div
					class="flex w-full items-center gap-2"
					:class="collapsed ? 'flex-col' : ''"
				>
					<UBadge
						v-if="!collapsed"
						color="neutral"
						variant="subtle"
						icon="i-lucide-user-round"
						data-test="principal"
						class="min-w-0"
					>
						<span class="truncate">
							{{ ROLE_LABEL[principal?.role ?? ''] ?? 'Signed Out'
							}}<template v-if="principal?.tenant">
								&middot; {{ principal.tenant }}</template
							>
						</span>
					</UBadge>
					<ThemeToggle :class="collapsed ? '' : 'ml-auto'" />
				</div>
			</template>
		</UDashboardSidebar>

		<slot />
	</UDashboardGroup>
</template>
