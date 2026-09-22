<script setup lang="ts">
export interface LimitRow {
	limit: string;
	cloudflare: string;
	workerd: string;
	bastion: string;
}

defineProps<{ rows: LimitRow[] }>();

/**
 * Whether bastion actually enforces this limit.
 *
 * The negative check is the whole function: `declared, not enforced` contains the word `enforced`,
 * so a substring test alone renders a limit bastion cannot enforce as one it does. That is the
 * exact claim this table exists to keep honest.
 */
function enforced(row: LimitRow): boolean {
	return row.bastion.includes('enforced') && !/\bnot enforced\b/.test(row.bastion);
}
</script>

<template>
	<div class="overflow-x-auto">
		<table class="w-full text-left text-sm">
			<thead>
				<tr class="border-b border-default">
					<th
						scope="col"
						class="py-2 pr-4 font-semibold"
					>
						Limit
					</th>
					<th
						scope="col"
						class="py-2 pr-4 font-semibold"
					>
						Cloudflare
					</th>
					<th
						scope="col"
						class="py-2 pr-4 font-semibold"
					>
						Standalone workerd
					</th>
					<th
						scope="col"
						class="py-2 font-semibold"
					>
						bastion
					</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="row in rows"
					:key="row.limit"
					class="border-b border-default last:border-0"
				>
					<th
						scope="row"
						class="py-2 pr-4 font-normal"
					>
						{{ row.limit }}
					</th>
					<td class="py-2 pr-4 text-muted">{{ row.cloudflare }}</td>
					<td class="py-2 pr-4 text-muted">{{ row.workerd }}</td>
					<td
						class="py-2"
						:data-state="enforced(row) ? 'enforced' : 'declared'"
						data-test="bastion"
					>
						<UBadge
							:color="enforced(row) ? 'success' : 'warning'"
							variant="subtle"
						>
							{{ row.bastion }}
						</UBadge>
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
