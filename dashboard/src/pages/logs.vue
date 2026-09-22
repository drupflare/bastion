<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Shell from '../components/Shell.vue';
import { call } from '../shared/api';

useHead({ title: 'Logs' });

interface LogLine {
	at: number;
	level: string;
	message: string;
	tenant?: string;
}

const LEVELS = [
	{ label: 'Debug', value: 'debug' },
	{ label: 'Info', value: 'info' },
	{ label: 'Warn', value: 'warn' },
	{ label: 'Error', value: 'error' }
];

const LEVEL_COLOR: Record<string, 'neutral' | 'success' | 'warning' | 'error'> = {
	debug: 'neutral',
	info: 'success',
	warn: 'warning',
	error: 'error'
};

const lines = ref<LogLine[]>([]);
const level = ref('info');
const loading = ref(true);

const rendered = computed(() =>
	lines.value
		.map((line) => `${new Date(line.at).toISOString()} ${line.level} ${line.message}`)
		.join('\n')
);

async function reload(): Promise<void> {
	loading.value = true;
	try {
		lines.value = (await call<{ lines: LogLine[] }>(`/api/logs?level=${level.value}`)).lines;
	} finally {
		loading.value = false;
	}
}

onMounted(reload);
</script>

<template>
	<Shell
		title="Logs"
		icon="i-lucide-scroll-text"
		description="Node-local on disk, and readable as files with bastion stopped."
	>
		<template #actions>
			<USelect
				v-model="level"
				:items="LEVELS"
				aria-label="Log Level"
				icon="i-lucide-filter"
				class="w-36"
				@update:model-value="reload"
			/>
			<UButton
				color="neutral"
				variant="subtle"
				icon="i-lucide-refresh-cw"
				:loading="loading"
				aria-label="Refresh"
				@click="reload"
			/>
		</template>

		<UAlert
			v-if="level === 'debug'"
			color="warning"
			variant="subtle"
			icon="i-lucide-triangle-alert"
			title="Debug logging fills a disk quickly"
			description="It is off by default, switchable per tenant and per site, and its retention is tighter than the rest."
		/>

		<UCard v-if="lines.length">
			<template #header>
				<div class="flex flex-wrap items-center gap-2">
					<UIcon
						name="i-lucide-terminal"
						class="size-5 text-muted"
					/>
					<h2 class="font-semibold">{{ lines.length }} lines</h2>
					<div class="ml-auto flex gap-1">
						<UBadge
							v-for="entry in LEVELS"
							:key="entry.value"
							:color="LEVEL_COLOR[entry.value]"
							:variant="entry.value === level ? 'solid' : 'subtle'"
							size="sm"
						>
							{{ lines.filter((line) => line.level === entry.value).length }}
							{{ entry.label }}
						</UBadge>
					</div>
				</div>
			</template>
			<pre class="overflow-x-auto rounded-md bg-elevated p-3 font-mono text-xs">{{
				rendered
			}}</pre>
		</UCard>
		<USkeleton
			v-else-if="loading"
			class="h-64"
		/>
		<UEmpty
			v-else
			icon="i-lucide-scroll-text"
			title="Nothing at this level"
			description="Lower the level, or send a request to a site on this node."
		/>
	</Shell>
</template>
