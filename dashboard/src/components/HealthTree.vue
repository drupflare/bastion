<script setup lang="ts">
import { SEVERITY_LABEL, type HealthNode, type Severity } from '../shared/api';

defineProps<{ node: HealthNode; depth?: number }>();

const SEVERITY_COLOR: Record<Severity, 'neutral' | 'success' | 'warning' | 'error'> = {
	debug: 'neutral',
	info: 'success',
	warn: 'warning',
	error: 'error',
	critical: 'error'
};
</script>

<template>
	<div :style="{ paddingLeft: `${(depth ?? 0) * 16}px` }">
		<div class="flex flex-wrap items-baseline gap-x-2 py-1">
			<UBadge
				:color="SEVERITY_COLOR[node.severity] ?? 'neutral'"
				:variant="node.severity === 'critical' ? 'solid' : 'subtle'"
				size="sm"
				data-test="severity"
			>
				{{ SEVERITY_LABEL[node.severity] ?? node.severity }}
			</UBadge>
			<span class="font-medium">{{ node.name }}</span>
			<span
				v-if="node.detail"
				class="min-w-0 text-sm text-muted wrap-break-word"
				>{{ node.detail }}</span
			>
		</div>
		<HealthTree
			v-for="child in node.children"
			:key="child.name"
			:node="child"
			:depth="(depth ?? 0) + 1"
		/>
	</div>
</template>
