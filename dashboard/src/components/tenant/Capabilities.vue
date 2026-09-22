<script setup lang="ts">
export interface CapabilityRow {
	name: string;
	value: string;
	enforcement: string;
}

defineProps<{ rows: CapabilityRow[] }>();

/** a capability whose only mechanism is a site variable is declared, and must not read as enforced */
function isEnforced(row: CapabilityRow): boolean {
	return row.enforcement.includes('enforced') && !row.enforcement.includes('not enforced');
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
						Capability
					</th>
					<th
						scope="col"
						class="py-2 pr-4 font-semibold"
					>
						Value
					</th>
					<th
						scope="col"
						class="py-2 font-semibold"
					>
						Enforcement Point
					</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="row in rows"
					:key="row.name"
					class="border-b border-default last:border-0"
				>
					<td class="py-2 pr-4">{{ row.name }}</td>
					<td class="py-2 pr-4">{{ row.value }}</td>
					<td
						class="py-2"
						:class="isEnforced(row) ? 'text-ok' : 'text-warn'"
						:data-test="`enforcement-${row.name}`"
					>
						{{ row.enforcement }}
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
