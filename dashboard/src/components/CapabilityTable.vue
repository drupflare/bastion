<script setup lang="ts">
export interface CapabilityRow {
	slot: string;
	command: string;
	state: 'present' | 'absent';
	version: string | null;
	approxMb: number;
	why: string;
	install: string;
}

defineProps<{ rows: CapabilityRow[]; busy?: string | null }>();
const emit = defineEmits<{ install: [slot: string] }>();

/**
 * The size is shown beside the button rather than after the install.
 *
 * A headless browser is about 450 MB. An operator clicking a button on a box they are sizing
 * should know that before the disk fills, not from the failure that follows.
 */
function size(mb: number): string {
	return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}
</script>

<template>
	<div class="overflow-x-auto">
		<table class="w-full text-left text-sm">
			<caption class="sr-only">
				Optional bindings, whether their software is installed, and what installs it
			</caption>
			<thead>
				<tr class="border-b border-default">
					<th
						scope="col"
						class="py-2 pr-4 font-semibold"
					>
						Binding
					</th>
					<th
						scope="col"
						class="py-2 pr-4 font-semibold"
					>
						What it Needs
					</th>
					<th
						scope="col"
						class="py-2 pr-4 font-semibold"
					>
						State
					</th>
					<th
						scope="col"
						class="py-2 pr-4 font-semibold"
					>
						Size
					</th>
					<th
						scope="col"
						class="py-2 font-semibold"
					>
						Action
					</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="row in rows"
					:key="row.slot"
					class="border-b border-default/50 last:border-0"
				>
					<th
						scope="row"
						class="py-3 pr-4 text-left font-medium"
					>
						<span class="font-mono">{{ row.slot }}</span>
						<span class="mt-0.5 block text-xs font-normal text-muted">{{
							row.why
						}}</span>
					</th>
					<td class="py-3 pr-4 font-mono text-xs">{{ row.command }}</td>
					<td class="py-3 pr-4">
						<UBadge
							:color="row.state === 'present' ? 'success' : 'neutral'"
							variant="subtle"
							size="sm"
						>
							{{ row.state === 'present' ? 'Installed' : 'Not Installed' }}
						</UBadge>
						<span
							v-if="row.version"
							class="mt-0.5 block text-xs text-muted"
						>
							{{ row.version }}
						</span>
					</td>
					<td class="py-3 pr-4 tabular-nums">{{ size(row.approxMb) }}</td>
					<td class="py-3">
						<span
							v-if="row.state === 'present'"
							class="text-xs text-muted"
						>
							Nothing to do
						</span>
						<UButton
							v-else
							:loading="busy === row.slot"
							:disabled="busy !== null && busy !== row.slot"
							size="sm"
							icon="i-lucide-download"
							@click="emit('install', row.slot)"
						>
							Install
						</UButton>
						<code
							v-if="row.state === 'absent'"
							class="mt-1 block text-xs text-muted"
							>{{ row.install }}</code
						>
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
