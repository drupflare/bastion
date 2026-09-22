<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import ClusterNodes, { type NodeRow } from '../components/cluster/Nodes.vue';
import Shell from '../components/Shell.vue';
import StatCard from '../components/StatCard.vue';
import { call } from '../shared/api';

useHead({ title: 'Cluster' });

const nodes = ref<NodeRow[]>([]);
const reachable = ref(true);
const loading = ref(true);

const ready = computed(() => nodes.value.filter((node) => node.state === 'ready').length);
const down = computed(() => nodes.value.filter((node) => node.state === 'unreachable').length);

onMounted(async () => {
	try {
		nodes.value = (await call<{ nodes: NodeRow[] }>('/api/cluster')).nodes;
	} catch {
		// a partitioned node stays diagnosable from itself; the cluster view degrades rather than
		// erroring, because the box someone is standing in front of is the one they need to read
		reachable.value = false;
	} finally {
		loading.value = false;
	}
});
</script>

<template>
	<Shell
		title="Cluster"
		icon="i-lucide-server"
		description="Children dial out to the control node; it never dials in."
	>
		<template #actions>
			<UBadge
				:color="reachable ? 'success' : 'warning'"
				variant="subtle"
				:icon="reachable ? 'i-lucide-link' : 'i-lucide-unplug'"
				size="lg"
			>
				{{ reachable ? 'Control node reachable' : 'This node only' }}
			</UBadge>
		</template>

		<div class="grid grid-cols-2 gap-4 lg:grid-cols-3">
			<StatCard
				label="Nodes"
				icon="i-lucide-server"
				:value="nodes.length"
				:loading="loading"
			/>
			<StatCard
				label="Ready"
				icon="i-lucide-circle-check"
				:value="ready"
				tone="success"
				:loading="loading"
			/>
			<StatCard
				label="Unreachable"
				icon="i-lucide-unplug"
				:value="down"
				:tone="down === 0 ? 'success' : 'error'"
				:loading="loading"
			/>
		</div>

		<UCard v-if="nodes.length">
			<template #header>
				<div class="flex items-center gap-2">
					<UIcon
						name="i-lucide-network"
						class="size-5 text-muted"
					/>
					<h2 class="font-semibold">Nodes</h2>
				</div>
			</template>
			<ClusterNodes
				:nodes="nodes"
				:reachable="reachable"
			/>
			<template #footer>
				<p class="text-sm text-muted">
					A site's primary node is a single point of failure for writes to that site.
					Promoting a replica loses anything not yet replicated.
				</p>
			</template>
		</UCard>
		<USkeleton
			v-else-if="loading"
			class="h-52"
		/>
		<UEmpty
			v-else
			icon="i-lucide-server"
			title="Standalone"
			description="This node is not in a cluster. `bastion cluster init` starts one."
		/>
	</Shell>
</template>
