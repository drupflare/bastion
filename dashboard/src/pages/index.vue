<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import CapacityCard from '../components/CapacityCard.vue';
import HealthTree from '../components/HealthTree.vue';
import LimitsTable, { type LimitRow } from '../components/LimitsTable.vue';
import Shell from '../components/Shell.vue';
import StatCard from '../components/StatCard.vue';
import { call, type CapacityAnswer, type HealthNode, type Severity } from '../shared/api';

useHead({ title: 'Overview' });

const health = ref<HealthNode | null>(null);
const capacity = ref<CapacityAnswer | null>(null);
const limits = ref<LimitRow[]>([]);
const failure = ref<string | null>(null);
const loading = ref(true);

const ORDER: Severity[] = ['debug', 'info', 'warn', 'error', 'critical'];

/** the worst severity anywhere in the tree, which is what the header badge reports */
function worst(node: HealthNode): Severity {
	return node.children.reduce<Severity>((carried, child) => {
		const below = worst(child);
		return ORDER.indexOf(below) > ORDER.indexOf(carried) ? below : carried;
	}, node.severity);
}

function openFindings(node: HealthNode): number {
	const counts = ORDER.indexOf(node.severity) >= ORDER.indexOf('warn') ? 1 : 0;
	return counts + node.children.reduce((sum, child) => sum + openFindings(child), 0);
}

const posture = computed(() => {
	if (health.value === null) return null;
	const severity = worst(health.value);
	if (severity === 'critical' || severity === 'error') {
		return { color: 'error' as const, icon: 'i-lucide-circle-x', label: 'Needs Attention' };
	}
	if (severity === 'warn') {
		return { color: 'warning' as const, icon: 'i-lucide-triangle-alert', label: 'Degraded' };
	}
	return { color: 'success' as const, icon: 'i-lucide-circle-check', label: 'Healthy' };
});

const findings = computed(() => (health.value === null ? 0 : openFindings(health.value)));

const enforced = computed(
	() =>
		limits.value.filter(
			(row) => row.bastion.includes('enforced') && !/\bnot enforced\b/.test(row.bastion)
		).length
);

onMounted(async () => {
	try {
		const [tree, answer, doctor] = await Promise.all([
			call<{ tree: HealthNode }>('/api/health'),
			call<CapacityAnswer>('/api/capacity'),
			call<{ limits: LimitRow[] }>('/api/doctor')
		]);
		health.value = tree.tree;
		capacity.value = answer;
		limits.value = doctor.limits;
	} catch (error) {
		failure.value = error instanceof Error ? error.message : String(error);
	} finally {
		loading.value = false;
	}
});
</script>

<template>
	<Shell
		title="Overview"
		icon="i-lucide-layout-dashboard"
		description="What this host is, what it holds, and which limits it can actually enforce."
	>
		<template #actions>
			<UBadge
				v-if="posture"
				:color="posture.color"
				variant="subtle"
				:icon="posture.icon"
				size="lg"
				data-test="posture"
			>
				{{ posture.label }}
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

		<div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
			<StatCard
				label="Recommended"
				icon="i-lucide-gauge"
				:value="capacity && capacity.known ? capacity.recommended : null"
				:hint="
					capacity?.known ? 'sites this host should hold' : 'not measured on this host'
				"
				:loading="loading"
			/>
			<StatCard
				label="Maximum"
				icon="i-lucide-hard-drive"
				:value="capacity && capacity.known ? capacity.maximum : null"
				:hint="capacity?.bindingTerm"
				:loading="loading"
			/>
			<StatCard
				label="Open Findings"
				icon="i-lucide-siren"
				:value="findings"
				:tone="findings === 0 ? 'success' : 'warning'"
				hint="warn or worse in the health tree"
				to="/health"
				:loading="loading"
			/>
			<StatCard
				label="Limits Enforced"
				icon="i-lucide-shield-check"
				:value="limits.length === 0 ? null : `${enforced} of ${limits.length}`"
				:tone="enforced === limits.length && limits.length > 0 ? 'success' : 'neutral'"
				hint="the rest are declared only"
				:loading="loading"
			/>
		</div>

		<CapacityCard
			v-if="capacity"
			:answer="capacity"
		/>
		<USkeleton
			v-else-if="loading"
			class="h-44"
		/>

		<UCard v-if="health">
			<template #header>
				<div class="flex items-center gap-2">
					<UIcon
						name="i-lucide-activity"
						class="size-5 text-muted"
					/>
					<h2 class="font-semibold">Health</h2>
					<UButton
						to="/health"
						variant="link"
						color="neutral"
						size="xs"
						trailing-icon="i-lucide-arrow-right"
						class="ml-auto"
						>Open</UButton
					>
				</div>
			</template>
			<HealthTree :node="health" />
		</UCard>

		<UCard v-if="limits.length">
			<template #header>
				<div class="flex items-center gap-2">
					<UIcon
						name="i-lucide-ruler"
						class="size-5 text-muted"
					/>
					<h2 class="font-semibold">Platform Limits</h2>
				</div>
			</template>
			<LimitsTable :rows="limits" />
			<template #footer>
				<p class="text-sm text-muted">
					Standalone workerd enforces none of these. A limit bastion cannot enforce is
					never reported as enforced.
				</p>
			</template>
		</UCard>
	</Shell>
</template>
