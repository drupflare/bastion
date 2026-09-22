<script setup lang="ts">
export interface DeploymentRow {
	current: string;
	split: { version: string; percent: number } | null;
	at: number;
	by: string;
}

defineProps<{ deployments: DeploymentRow[]; canWrite: boolean }>();
defineEmits<{ (event: 'rollback', to: string): void }>();
</script>

<template>
	<ol class="space-y-2">
		<li
			v-for="(deployment, index) in deployments"
			:key="`${deployment.at}-${index}`"
			class="flex items-baseline gap-3 rounded border border-default p-3 text-sm"
		>
			<span class="font-mono">{{ deployment.current.slice(0, 12) }}</span>
			<span
				v-if="deployment.split"
				class="text-warn"
				data-test="split"
			>
				{{ deployment.split.percent }}% to {{ deployment.split.version.slice(0, 12) }}
			</span>
			<span class="opacity-70">{{ new Date(deployment.at).toISOString() }}</span>
			<span class="opacity-70">by {{ deployment.by }}</span>
			<button
				v-if="canWrite && index > 0"
				class="ml-auto rounded border border-default px-2 py-0.5"
				data-test="rollback"
				@click="$emit('rollback', deployment.current)"
			>
				Roll Back to This
			</button>
		</li>
	</ol>
</template>
