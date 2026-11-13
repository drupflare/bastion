<script setup lang="ts">
import { computed } from 'vue';
import type { PairingStatus } from '../../shared/api';

const props = defineProps<{ status: PairingStatus }>();

const state = computed(() => {
	if (!props.status.paired) return { label: 'Not Paired', color: 'neutral' as const };
	if (props.status.link?.stopped) return { label: 'Stopped', color: 'error' as const };
	if (props.status.link?.connected) return { label: 'Connected', color: 'success' as const };
	return { label: 'Not Connected', color: 'warning' as const };
});
</script>

<template>
	<section>
		<div class="mb-3 flex items-center gap-2">
			<UBadge
				:color="state.color"
				variant="subtle"
				data-test="state"
			>
				{{ state.label }}
			</UBadge>
			<p
				v-if="!status.paired"
				class="text-sm text-muted"
				data-test="standalone"
			>
				This box runs on its own and sends nothing. `bastion pair &lt;url&gt;#&lt;claim
				token&gt;` pairs it.
			</p>
		</div>

		<dl
			v-if="status.paired"
			class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm"
		>
			<dt class="text-muted">Node</dt>
			<dd
				class="font-mono"
				data-test="node-id"
			>
				{{ status.nodeId }}
			</dd>
			<dt class="text-muted">Control Plane</dt>
			<dd
				class="font-mono"
				data-test="link-url"
			>
				{{ status.linkUrl }}
			</dd>
			<dt class="text-muted">Last Message</dt>
			<dd data-test="last-message">{{ status.link?.lastMessageAt ?? 'Never' }}</dd>
			<template v-if="status.link?.stopped">
				<dt class="text-muted">Stopped</dt>
				<dd data-test="stopped">
					{{ status.link.stopped.reason }}. `bastion unpair` clears it.
				</dd>
			</template>
			<template v-if="status.link?.lastRefusal">
				<dt class="text-muted">Last Refusal</dt>
				<dd data-test="refusal">{{ status.link.lastRefusal.code }}</dd>
			</template>
		</dl>
	</section>
</template>
