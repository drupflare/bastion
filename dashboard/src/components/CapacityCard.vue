<script setup lang="ts">
import type { CapacityAnswer } from '../shared/api';

defineProps<{ answer: CapacityAnswer }>();

/**
 * How a number was arrived at, coloured by how much it can be trusted.
 *
 * The word itself is always rendered, so the colour is reinforcement rather than the only signal,
 * which is what 1.4.1 requires. A capacity figure presented as measured when an input was assumed
 * is the exact failure the provenance column exists to stop.
 */
const PROVENANCE_COLOR: Record<string, 'success' | 'warning' | 'error'> = {
	probed: 'success',
	stated: 'warning',
	assumed: 'error'
};
</script>

<template>
	<UCard>
		<template #header>
			<h2 class="text-lg font-semibold">Capacity</h2>
		</template>

		<dl class="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
			<div>
				<dt class="text-muted">Recommended</dt>
				<dd
					class="text-xl font-semibold"
					data-test="recommended"
				>
					{{ answer.known ? answer.recommended : 'not measured' }}
				</dd>
			</div>
			<div>
				<dt class="text-muted">Maximum</dt>
				<dd
					class="text-xl font-semibold"
					data-test="maximum"
				>
					{{ answer.known ? answer.maximum : 'not measured' }}
				</dd>
			</div>
			<div>
				<dt class="text-muted">Bound By</dt>
				<dd data-test="binding">{{ answer.bindingTerm }}</dd>
			</div>
			<div>
				<dt class="text-muted">Provenance</dt>
				<dd>
					<UBadge
						:color="PROVENANCE_COLOR[answer.provenance] ?? 'neutral'"
						variant="subtle"
						:data-provenance="answer.provenance"
						data-test="provenance"
					>
						{{ answer.provenance }}
					</UBadge>
				</dd>
			</div>
		</dl>

		<p
			v-if="answer.concurrencyCeiling !== null"
			class="mt-4 text-sm text-muted"
		>
			RAM allows {{ answer.concurrencyCeiling }} sites resident at once, which is a different
			number from how many may exist.
		</p>

		<ul class="mt-2 space-y-1 text-sm text-muted">
			<li
				v-for="note in answer.notes"
				:key="note"
			>
				{{ note }}
			</li>
		</ul>
	</UCard>
</template>
