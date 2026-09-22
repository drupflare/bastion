<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Shell from '../components/Shell.vue';
import { useSession } from '../composables/useSession';
import { call } from '../shared/api';

useHead({ title: 'Configuration' });

const { csrf } = useSession();
const text = ref('');
const problems = ref<{ path: string; message: string }[]>([]);
const saved = ref(false);
const saving = ref(false);

onMounted(async () => {
	const config = await call<Record<string, unknown>>('/api/config');
	text.value = JSON.stringify(config, null, 2);
});

/** writes through the same validator the CLI uses, so the two cannot disagree about validity */
async function save(): Promise<void> {
	saved.value = false;
	saving.value = true;
	problems.value = [];
	try {
		await call('/api/config', {
			method: 'PUT',
			body: JSON.parse(text.value),
			csrf: csrf.value
		});
		saved.value = true;
	} catch (error) {
		problems.value = [
			{ path: '', message: error instanceof Error ? error.message : String(error) }
		];
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<Shell
		title="Configuration"
		icon="i-lucide-settings"
		description="Written through the same validator the CLI uses, so the two cannot disagree."
	>
		<template #actions>
			<UButton
				color="neutral"
				icon="i-lucide-save"
				:loading="saving"
				@click="save"
				>Save</UButton
			>
		</template>

		<UAlert
			v-if="problems.length"
			color="error"
			variant="subtle"
			icon="i-lucide-circle-x"
			title="This configuration was refused"
		>
			<template #description>
				<ul class="space-y-1">
					<li
						v-for="problem in problems"
						:key="problem.path + problem.message"
					>
						{{ problem.path }} {{ problem.message }}
					</li>
				</ul>
			</template>
		</UAlert>

		<UAlert
			v-if="saved"
			color="success"
			variant="subtle"
			icon="i-lucide-circle-check"
			title="Saved"
			description="The running configuration now matches what is in this editor."
		/>

		<UCard>
			<template #header>
				<div class="flex items-center gap-2">
					<UIcon
						name="i-lucide-file-code"
						class="size-5 text-muted"
					/>
					<h2 class="font-semibold">bastion.yml</h2>
					<UBadge
						color="neutral"
						variant="subtle"
						size="sm"
						class="ml-auto"
						>{{ text.split('\n').length }} lines</UBadge
					>
				</div>
			</template>
			<UTextarea
				v-model="text"
				:rows="22"
				spellcheck="false"
				class="w-full"
				aria-label="bastion.yml"
				:ui="{ base: 'font-mono text-sm' }"
			/>
			<template #footer>
				<p class="text-sm text-muted">
					Secrets never appear here. `bastion secrets` holds them, and a read is audited.
				</p>
			</template>
		</UCard>
	</Shell>
</template>
