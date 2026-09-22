<script setup lang="ts">
export interface NodeRow {
	id: string;
	address: string;
	state: 'joining' | 'ready' | 'draining' | 'unreachable' | 'left';
	lastSeenAt: number;
}

defineProps<{ nodes: NodeRow[]; reachable: boolean }>();

const STATE_COLOR: Record<NodeRow['state'], 'neutral' | 'success' | 'warning' | 'error'> = {
	joining: 'warning',
	ready: 'success',
	draining: 'warning',
	unreachable: 'error',
	left: 'neutral'
};
</script>

<template>
	<section>
		<UAlert
			v-if="!reachable"
			color="warning"
			variant="subtle"
			icon="i-lucide-unplug"
			class="mb-3"
			title="Control node unreachable"
			description="This is showing this node only."
			data-test="degraded"
		/>
		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead>
					<tr class="border-b border-default">
						<th
							scope="col"
							class="py-2 pr-4 font-semibold"
						>
							Node
						</th>
						<th
							scope="col"
							class="py-2 pr-4 font-semibold"
						>
							Address
						</th>
						<th
							scope="col"
							class="py-2 pr-4 font-semibold"
						>
							State
						</th>
						<th
							scope="col"
							class="py-2 font-semibold"
						>
							Last Seen
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="node in nodes"
						:key="node.id"
						class="border-b border-default last:border-0"
					>
						<th
							scope="row"
							class="py-2 pr-4 font-medium"
						>
							{{ node.id }}
						</th>
						<td class="py-2 pr-4 text-muted">{{ node.address }}</td>
						<td
							class="py-2 pr-4"
							data-test="state"
						>
							<UBadge
								:color="STATE_COLOR[node.state]"
								variant="subtle"
							>
								{{ node.state }}
							</UBadge>
						</td>
						<td class="py-2 text-muted">
							{{ new Date(node.lastSeenAt).toISOString() }}
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	</section>
</template>
