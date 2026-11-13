<script setup lang="ts">
import { computed } from 'vue';
import type { PairingCommand } from '../../shared/api';

const props = defineProps<{ commands: PairingCommand[]; busy: string | null }>();
defineEmits<{
	(event: 'approve', id: string): void;
	(event: 'reject', id: string): void;
}>();

const waiting = computed(() => props.commands.filter((command) => command.state === 'queued'));
const history = computed(() => props.commands.filter((command) => command.state !== 'queued'));
</script>

<template>
	<section class="space-y-6">
		<div>
			<h3 class="mb-2 text-sm font-semibold">Waiting for Approval</h3>
			<p
				v-if="waiting.length === 0"
				class="text-sm text-muted"
				data-test="none-waiting"
			>
				Nothing is waiting.
			</p>
			<ul
				v-else
				class="space-y-2"
			>
				<li
					v-for="command in waiting"
					:key="command.id"
					class="flex flex-wrap items-center gap-3 rounded border border-default p-3 text-sm"
					data-test="waiting"
				>
					<span class="font-mono">{{ command.id }}</span>
					<span class="font-medium">{{ command.action }}</span>
					<UBadge
						color="neutral"
						variant="subtle"
					>
						{{ command.class }}
					</UBadge>
					<span class="text-muted">Expires {{ command.expiresAt }}</span>
					<span class="ml-auto flex gap-2">
						<UButton
							size="sm"
							:disabled="busy === command.id"
							data-test="approve"
							@click="$emit('approve', command.id)"
						>
							Approve
						</UButton>
						<UButton
							size="sm"
							color="neutral"
							variant="outline"
							:disabled="busy === command.id"
							data-test="reject"
							@click="$emit('reject', command.id)"
						>
							Reject
						</UButton>
					</span>
				</li>
			</ul>
		</div>

		<div v-if="history.length">
			<h3 class="mb-2 text-sm font-semibold">Recent</h3>
			<table class="w-full text-left text-sm">
				<thead>
					<tr class="border-b border-default">
						<th
							scope="col"
							class="py-2 pr-4 font-semibold"
						>
							Command
						</th>
						<th
							scope="col"
							class="py-2 pr-4 font-semibold"
						>
							Action
						</th>
						<th
							scope="col"
							class="py-2 font-semibold"
						>
							Result
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="command in history"
						:key="command.id"
						class="border-b border-default last:border-0"
						data-test="recent"
					>
						<th
							scope="row"
							class="py-2 pr-4 font-mono font-normal"
						>
							{{ command.id }}
						</th>
						<td class="py-2 pr-4">{{ command.action }}</td>
						<td class="py-2 text-muted">
							{{ command.outcome ?? command.state
							}}<template v-if="command.code"> ({{ command.code }})</template>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	</section>
</template>
