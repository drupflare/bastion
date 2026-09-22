<script setup lang="ts">
import type { TenantSummary } from '../../shared/api';

defineProps<{ tenant: TenantSummary; canWrite: boolean }>();
defineEmits<{ (event: 'open', name: string): void }>();

/** binary units, because a cgroup limit is set in them and `4294967296` is not a readable number */
function bytes(value: number | undefined): string {
	if (value === undefined) return 'max';
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	let at = 0;
	let size = value;
	while (size >= 1024 && at < units.length - 1) {
		size /= 1024;
		at++;
	}
	return `${Number.isInteger(size) ? size : size.toFixed(1)} ${units[at]}`;
}
</script>

<template>
	<UCard as="article">
		<template #header>
			<div class="flex items-baseline justify-between gap-2">
				<h3 class="font-semibold">{{ tenant.name }}</h3>
				<span class="text-sm text-muted">{{ tenant.sites.length }} sites</span>
			</div>
		</template>

		<dl class="grid grid-cols-3 gap-2 text-sm">
			<div>
				<dt class="text-muted">CPU</dt>
				<dd>{{ tenant.limits?.cpu ?? 'max' }}</dd>
			</div>
			<div>
				<dt class="text-muted">Memory</dt>
				<dd data-test="memory">{{ bytes(tenant.limits?.memory) }}</dd>
			</div>
			<div>
				<dt class="text-muted">Max Sites</dt>
				<dd data-test="quota">{{ tenant.limits?.maxSites ?? 'unset' }}</dd>
			</div>
		</dl>

		<p
			v-if="(tenant.egress?.allow.length ?? 0) === 0"
			class="mt-3 text-sm text-success"
		>
			No egress allow list, so everything outbound is denied.
		</p>

		<template
			v-if="canWrite"
			#footer
		>
			<UButton
				color="neutral"
				size="sm"
				icon="i-lucide-sliders-horizontal"
				data-test="open"
				@click="$emit('open', tenant.name)"
			>
				Manage
			</UButton>
		</template>
	</UCard>
</template>
