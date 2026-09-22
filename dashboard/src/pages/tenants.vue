<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Shell from '../components/Shell.vue';
import StatCard from '../components/StatCard.vue';
import TenantCard from '../components/tenant/Card.vue';
import { useSession } from '../composables/useSession';

useHead({ title: 'Tenants' });

const { visibleTenants, canWrite, isOperator, load } = useSession();
const failure = ref<string | null>(null);
const loading = ref(true);

const sites = computed(() =>
	visibleTenants.value.reduce((sum, tenant) => sum + tenant.sites.length, 0)
);
const quota = computed(() =>
	visibleTenants.value.reduce((sum, tenant) => sum + (tenant.limits?.maxSites ?? 0), 0)
);

onMounted(async () => {
	try {
		await load();
	} catch (error) {
		failure.value = error instanceof Error ? error.message : String(error);
	} finally {
		loading.value = false;
	}
});
</script>

<template>
	<Shell
		title="Tenants"
		icon="i-lucide-users"
		:description="
			isOperator
				? 'One workerd process per tenant, in every mode. The quota is what makes delegation safe.'
				: 'The sites this credential reaches, and nothing else on the box.'
		"
	>
		<template #actions>
			<UBadge
				color="neutral"
				variant="subtle"
				icon="i-lucide-box"
			>
				{{ visibleTenants.length }} {{ visibleTenants.length === 1 ? 'tenant' : 'tenants' }}
			</UBadge>
		</template>

		<UAlert
			v-if="failure"
			color="error"
			variant="subtle"
			icon="i-lucide-circle-x"
			title="This view could not be loaded"
			:description="failure"
		/>

		<div class="grid grid-cols-2 gap-4 lg:grid-cols-3">
			<StatCard
				label="Tenants"
				icon="i-lucide-users"
				:value="visibleTenants.length"
				hint="each one an isolation boundary"
				:loading="loading"
			/>
			<StatCard
				label="Sites"
				icon="i-lucide-globe"
				:value="sites"
				hint="one hostname each"
				:loading="loading"
			/>
			<StatCard
				label="Quota"
				icon="i-lucide-shield"
				:value="quota === 0 ? 'unset' : quota"
				hint="sites a tenant-admin may provision"
				:loading="loading"
			/>
		</div>

		<div
			v-if="loading"
			class="grid gap-4 sm:grid-cols-2"
		>
			<USkeleton class="h-44" />
			<USkeleton class="h-44" />
		</div>

		<div
			v-else-if="visibleTenants.length"
			class="grid gap-4 sm:grid-cols-2"
		>
			<TenantCard
				v-for="tenant in visibleTenants"
				:key="tenant.name"
				:tenant="tenant"
				:can-write="canWrite"
			/>
		</div>

		<UEmpty
			v-else-if="!failure"
			icon="i-lucide-users"
			title="No tenants yet"
			description="`bastion tenant add` creates one. Every site belongs to exactly one."
		/>
	</Shell>
</template>
