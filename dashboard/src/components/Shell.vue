<script setup lang="ts">
defineProps<{
	title: string;
	icon: string;
	/** one line under the title saying what this page is for */
	description?: string;
}>();

defineSlots<{
	default(): unknown;
	actions?(): unknown;
	toolbar?(): unknown;
}>();
</script>

<template>
	<UDashboardPanel>
		<template #header>
			<UDashboardNavbar
				:title="title"
				:icon="icon"
			>
				<template #right>
					<slot name="actions" />
				</template>
			</UDashboardNavbar>
			<UDashboardToolbar v-if="$slots.toolbar || description">
				<template #left>
					<p
						v-if="description"
						class="text-sm text-muted"
					>
						{{ description }}
					</p>
				</template>
				<template #right>
					<slot name="toolbar" />
				</template>
			</UDashboardToolbar>
		</template>

		<!-- UDashboardNavbar renders the title as the page's h1, so this must not add a second one -->
		<template #body>
			<main
				id="main"
				tabindex="-1"
				class="space-y-6 focus:outline-none"
			>
				<slot />
			</main>
		</template>
	</UDashboardPanel>
</template>
