<script setup lang="ts">
import { onMounted, ref } from 'vue';
import HealthTree from '../components/HealthTree.vue';
import Shell from '../components/Shell.vue';
import { call, type HealthNode } from '../shared/api';

useHead({ title: 'Health' });

const tree = ref<HealthNode | null>(null);
const failure = ref<string | null>(null);
const loading = ref(true);

async function reload(): Promise<void> {
	loading.value = true;
	failure.value = null;
	try {
		tree.value = (await call<{ tree: HealthNode }>('/api/health')).tree;
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
		title="Health"
		icon="i-lucide-activity"
		description="Rendered from this node, so a partitioned box is still diagnosable from itself."
	>
		<template #actions>
			<UButton
				color="neutral"
				variant="subtle"
				icon="i-lucide-refresh-cw"
				:loading="loading"
				@click="reload"
				>Refresh</UButton
			>
		</template>

		<UAlert
			v-if="failure"
			color="error"
			variant="subtle"
			icon="i-lucide-circle-x"
			title="This view could not be loaded"
			:description="failure"
		/>

		<UCard v-if="tree">
			<HealthTree :node="tree" />
		</UCard>
		<USkeleton
			v-else-if="loading"
			class="h-64"
		/>
		<UEmpty
			v-else-if="!failure"
			icon="i-lucide-circle-check"
			title="Nothing to report"
			description="No tripwire has fired on this node."
		/>
	</Shell>
</template>
