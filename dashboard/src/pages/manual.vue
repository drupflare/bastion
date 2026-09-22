<script setup lang="ts">
import { computed, ref } from 'vue';
import Shell from '../components/Shell.vue';
import { MANUAL } from '../shared/manual';

useHead({ title: 'Manual' });

const active = ref(MANUAL[0]?.id ?? '');
const query = ref('');

const matching = computed(() => {
	const needle = query.value.trim().toLowerCase();
	if (needle === '') return MANUAL;
	return MANUAL.filter(
		(entry) =>
			entry.title.toLowerCase().includes(needle) || entry.body.toLowerCase().includes(needle)
	);
});

const section = computed(() => MANUAL.find((entry) => entry.id === active.value) ?? null);
</script>

<template>
	<Shell
		title="Manual"
		icon="i-lucide-book-open"
		description="Shipped inside the binary, so a box with no network still has its documentation."
	>
		<template #actions>
			<UBadge
				color="neutral"
				variant="subtle"
				icon="i-lucide-hash"
			>
				{{ MANUAL.length }} topics
			</UBadge>
		</template>

		<div class="flex flex-col gap-6 lg:flex-row">
			<div class="shrink-0 space-y-2 lg:w-56">
				<UInput
					v-model="query"
					icon="i-lucide-search"
					placeholder="Search topics"
					aria-label="Search the manual"
					class="w-full"
				/>
				<nav
					aria-label="Manual topics"
					class="space-y-1"
				>
					<UButton
						v-for="entry in matching"
						:key="entry.id"
						:color="entry.id === active ? 'primary' : 'neutral'"
						:variant="entry.id === active ? 'soft' : 'ghost'"
						block
						class="justify-start"
						:aria-current="entry.id === active ? 'true' : undefined"
						@click="active = entry.id"
					>
						{{ entry.title }}
					</UButton>
					<p
						v-if="matching.length === 0"
						class="px-2 py-1 text-sm text-muted"
					>
						No topic matches that.
					</p>
				</nav>
			</div>

			<UCard
				v-if="section"
				class="min-w-0 flex-1"
				as="article"
			>
				<template #header>
					<h2 class="text-lg font-semibold">{{ section.title }}</h2>
				</template>
				<pre class="overflow-x-auto text-sm leading-relaxed whitespace-pre-wrap">{{
					section.body
				}}</pre>
			</UCard>
		</div>
	</Shell>
</template>
