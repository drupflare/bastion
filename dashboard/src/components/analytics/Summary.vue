<script setup lang="ts">
export interface SiteRow {
	site: string;
	tenant: string;
	requests: number;
	errors: number;
	refusals: number;
	cachedFraction: number;
	bytes: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
}

defineProps<{ rows: SiteRow[]; hostMetrics: boolean }>();

function percent(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}

/**
 * A cached fraction below this is the usual explanation for a site that got slow, because the
 * edge tier absorbs most anonymous traffic before it reaches the object.
 */
const CACHE_FLOOR = 0.5;
</script>

<template>
	<section>
		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead>
					<tr class="border-b border-default">
						<th
							scope="col"
							class="py-2 pr-4 font-semibold"
						>
							Site
						</th>
						<th
							scope="col"
							class="py-2 pr-4 font-semibold"
						>
							Requests
						</th>
						<th
							scope="col"
							class="py-2 pr-4 font-semibold"
						>
							Cached
						</th>
						<th
							scope="col"
							class="py-2 pr-4 font-semibold"
						>
							Errors
						</th>
						<th
							scope="col"
							class="py-2 pr-4 font-semibold"
						>
							Refused
						</th>
						<th
							scope="col"
							class="py-2 pr-4 font-semibold"
						>
							p50
						</th>
						<th
							scope="col"
							class="py-2 font-semibold"
						>
							p95
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="row in rows"
						:key="row.site"
						class="border-b border-default last:border-0"
					>
						<th
							scope="row"
							class="py-2 pr-4 font-medium"
						>
							{{ row.site }}
						</th>
						<td class="py-2 pr-4 tabular-nums">{{ row.requests.toLocaleString() }}</td>
						<td
							class="py-2 pr-4"
							:class="row.cachedFraction < CACHE_FLOOR ? 'text-warn' : 'text-ok'"
							data-test="cached"
						>
							{{ percent(row.cachedFraction) }}
						</td>
						<td
							class="py-2 pr-4"
							:class="row.errors > 0 ? 'text-bad' : ''"
							data-test="errors"
						>
							{{ row.errors }}
						</td>
						<td
							class="py-2 pr-4"
							data-test="refusals"
						>
							{{ row.refusals }}
						</td>
						<td class="py-2 pr-4">{{ row.p50Ms }}ms</td>
						<td class="py-2">{{ row.p95Ms }}ms</td>
					</tr>
				</tbody>
			</table>
		</div>

		<p
			v-if="rows.length === 0"
			class="mt-3 text-sm opacity-70"
		>
			No requests in this window.
		</p>

		<p
			v-if="!hostMetrics"
			class="mt-3 text-sm opacity-70"
			data-test="scope"
		>
			These are your sites. Host figures belong to the operator, because they describe every
			tenant on the box.
		</p>
	</section>
</template>
