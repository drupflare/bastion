<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import CapabilityTable, { type CapabilityRow } from '../components/CapabilityTable.vue';
import CapacityCard from '../components/CapacityCard.vue';
import HealthTree from '../components/HealthTree.vue';
import LimitsTable, { type LimitRow } from '../components/LimitsTable.vue';
import Shell from '../components/Shell.vue';
import StatCard from '../components/StatCard.vue';
import { useSession } from '../composables/useSession';
import { call, type CapacityAnswer, type HealthNode, type Severity } from '../shared/api';

const { csrf, isOperator } = useSession();

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

const capabilities = ref<CapabilityRow[]>([]);
const installing = ref<string | null>(null);
const installFailure = ref<string | null>(null);

const missing = computed(() => capabilities.value.filter((row) => row.state === 'absent').length);

async function loadCapabilities(): Promise<void> {
	const answer = await call<{ capabilities: CapabilityRow[] }>('/api/capabilities');
	capabilities.value = answer.capabilities;
}

/**
 * Installs one binding's software, then re-reads rather than assuming it worked.
 *
 * A package manager can exit zero having installed something that still does not answer its
 * probe, so the row's state comes from a fresh probe rather than from the button's own optimism.
 */
async function install(slot: string): Promise<void> {
	installing.value = slot;
	installFailure.value = null;
	try {
		await call(`/api/capabilities/${slot}/install`, { method: 'POST', csrf: csrf.value });
		await loadCapabilities();
	} catch (error) {
		installFailure.value = error instanceof Error ? error.message : String(error);
	} finally {
		installing.value = null;
	}
}

onMounted(async () => {
	try {
		const [tree, answer, doctor] = await Promise.all([
			call<{ tree: HealthNode }>('/api/health'),
			call<CapacityAnswer>('/api/capacity'),
			call<{ limits: LimitRow[] }>('/api/doctor'),
			loadCapabilities()
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

		<UCard v-if="isOperator && capabilities.length">
			<template #header>
				<div class="flex items-center justify-between gap-2">
					<div class="flex items-center gap-2">
						<UIcon
							name="i-lucide-puzzle"
							class="size-5 text-muted"
						/>
						<h2 class="font-semibold">Optional Bindings</h2>
					</div>
					<UBadge
						:color="missing === 0 ? 'success' : 'neutral'"
						variant="subtle"
						size="sm"
						data-test="capabilities-missing"
					>
						{{ missing === 0 ? 'All Installed' : `${missing} Not Installed` }}
					</UBadge>
				</div>
			</template>
			<p class="mb-3 text-sm text-muted">
				These bindings need software this host does not ship. A site that binds one is
				refused until it is installed.
			</p>
			<UAlert
				v-if="installFailure"
				color="error"
				variant="subtle"
				icon="i-lucide-circle-x"
				class="mb-3"
				:description="installFailure"
			/>
			<CapabilityTable
				:rows="capabilities"
				:busy="installing"
				@install="install"
			/>
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
