<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
	defineProps<{
		label: string;
		value?: string | number | null;
		icon: string;
		hint?: string;
		to?: string;
		loading?: boolean;
		/** tints the icon when the number carries a verdict rather than just a count */
		tone?: 'neutral' | 'success' | 'warning' | 'error';
	}>(),
	{ loading: false, tone: 'neutral' }
);

const TONE: Record<string, string> = {
	neutral: 'bg-elevated text-toned',
	success: 'bg-success/10 text-success',
	warning: 'bg-warning/10 text-warning',
	error: 'bg-error/10 text-error'
};

const shown = computed(() => {
	if (props.value === null || props.value === undefined) return '-';
	return typeof props.value === 'number' ? props.value.toLocaleString() : props.value;
});
</script>

<template>
	<component
		:is="to ? 'NuxtLink' : 'div'"
		:to="to || undefined"
		class="block rounded-lg border border-default bg-default p-4"
		:class="to ? 'transition-colors hover:border-inverted/20' : ''"
	>
		<div class="flex items-center gap-2">
			<span
				class="flex size-8 shrink-0 items-center justify-center rounded-md"
				:class="TONE[tone]"
			>
				<UIcon
					:name="icon"
					class="size-4"
				/>
			</span>
			<span class="truncate text-xs font-medium tracking-wide text-muted uppercase">
				{{ label }}
			</span>
		</div>

		<USkeleton
			v-if="loading"
			class="mt-3 h-7 w-14"
		/>
		<p
			v-else
			class="mt-3 text-2xl font-semibold tabular-nums"
			data-test="value"
		>
			{{ shown }}
		</p>

		<p
			v-if="hint && !loading"
			class="mt-1 truncate text-xs text-muted"
		>
			{{ hint }}
		</p>
	</component>
</template>
