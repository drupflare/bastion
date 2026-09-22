<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AnalyticsSummary, { type SiteRow } from '../components/analytics/Summary.vue';
import Shell from '../components/Shell.vue';
import StatCard from '../components/StatCard.vue';
import { useSession } from '../composables/useSession';
import { call } from '../shared/api';

useHead({ title: 'Analytics' });

const WINDOWS = [
	{ label: 'Last Hour', value: 1 },
	{ label: 'Last Day', value: 24 },
	{ label: 'Last Week', value: 168 }
];

/** the buckets get a colour, because a 5xx count and a 200 count are not the same news */
const STATUS_TONE = (bucket: string): 'success' | 'warning' | 'error' | 'neutral' => {
	if (bucket.startsWith('2') || bucket.startsWith('3')) return 'success';
	if (bucket.startsWith('4')) return 'warning';
	if (bucket.startsWith('5')) return 'error';
	return 'neutral';
};

const { isOperator } = useSession();
const rows = ref<SiteRow[]>([]);
const statuses = ref<Record<string, number>>({});
const hours = ref(24);
const failure = ref<string | null>(null);
const loading = ref(true);

const window = computed(() => ({ from: Date.now() - hours.value * 3_600_000, to: Date.now() }));

const requests = computed(() => rows.value.reduce((sum, row) => sum + row.requests, 0));
const errors = computed(() => rows.value.reduce((sum, row) => sum + row.errors, 0));

/** weighted by request count, because averaging per-site fractions over-weights a quiet site */
const cached = computed(() => {
	if (requests.value === 0) return null;
	const hits = rows.value.reduce((sum, row) => sum + row.requests * row.cachedFraction, 0);
	return `${Math.round((hits / requests.value) * 100)}%`;
});

async function reload(): Promise<void> {
	loading.value = true;
	failure.value = null;
	try {
		const answer = await call<{ sites: SiteRow[]; statuses: Record<string, number> }>(
			`/api/metrics?from=${window.value.from}&to=${window.value.to}`
		);
		rows.value = answer.sites;
		statuses.value = answer.statuses;
	} catch (error) {
		failure.value = error instanceof Error ? error.message : String(error);
	} finally {
		loading.value = false;
	}
}

onMounted(reload);
</script>

<template>
	<Shell
		title="Analytics"
		icon="i-lucide-chart-line"
		description="Per site and per tenant, which are the billing inputs a control plane would need."
	>
		<template #actions>
			<USelect
				v-model="hours"
				:items="WINDOWS"
				aria-label="Time Window"
				icon="i-lucide-clock"
				class="w-40"
				@update:model-value="reload"
			/>
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
				label="Requests"
				icon="i-lucide-arrow-down-up"
				:value="requests"
				:loading="loading"
			/>
			<StatCard
				label="Cached"
				icon="i-lucide-zap"
				:value="cached"
				hint="the tier that absorbs most anonymous traffic"
				tone="success"
				:loading="loading"
			/>
			<StatCard
				label="Errors"
				icon="i-lucide-circle-x"
				:value="errors"
				:tone="errors === 0 ? 'success' : 'error'"
				:loading="loading"
			/>
			<StatCard
				label="Sites"
				icon="i-lucide-globe"
				:value="rows.length"
				:loading="loading"
			/>
		</div>

		<UCard v-if="Object.keys(statuses).length">
			<template #header>
				<div class="flex items-center gap-2">
					<UIcon
						name="i-lucide-list-checks"
						class="size-5 text-muted"
					/>
					<h2 class="font-semibold">Status Codes</h2>
				</div>
			</template>
			<div class="flex flex-wrap gap-2">
				<UBadge
					v-for="(count, bucket) in statuses"
					:key="bucket"
					:color="STATUS_TONE(String(bucket))"
					variant="subtle"
					size="lg"
				>
					{{ bucket }} &middot; {{ count.toLocaleString() }}
				</UBadge>
			</div>
		</UCard>

		<UCard v-if="rows.length">
			<template #header>
				<div class="flex items-center gap-2">
					<UIcon
						name="i-lucide-table"
						class="size-5 text-muted"
					/>
					<h2 class="font-semibold">Per Site</h2>
				</div>
			</template>
			<AnalyticsSummary
				:rows="rows"
				:host-metrics="isOperator"
			/>
		</UCard>
		<USkeleton
			v-else-if="loading"
			class="h-52"
		/>
		<UEmpty
			v-else-if="!failure"
			icon="i-lucide-chart-line"
			title="No traffic in this window"
			description="Widen the window, or send a request to a site on this node."
		/>
	</Shell>
</template>
