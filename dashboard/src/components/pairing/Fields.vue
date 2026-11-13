<script setup lang="ts">
import type { PairingFields } from '../../shared/api';

defineProps<{ fields: PairingFields }>();
</script>

<template>
	<section class="space-y-4">
		<div
			v-for="group in fields.leaves"
			:key="group.type"
		>
			<h3
				class="mb-1 font-mono text-sm font-semibold"
				data-test="group"
			>
				{{ group.type }}
			</h3>
			<ul class="space-y-1 text-sm">
				<li
					v-for="entry in group.fields"
					:key="entry.field"
					data-test="field"
				>
					<span class="font-mono">{{ entry.field }}</span>
					<span class="text-muted"> {{ entry.description }}</span>
				</li>
			</ul>
		</div>
		<div>
			<h3 class="mb-1 text-sm font-semibold">Never Sent</h3>
			<ul class="list-disc space-y-1 pl-5 text-sm text-muted">
				<li
					v-for="entry in fields.never"
					:key="entry"
					data-test="never"
				>
					{{ entry }}
				</li>
			</ul>
		</div>
	</section>
</template>
