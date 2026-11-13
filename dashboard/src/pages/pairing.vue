<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Fields from '../components/pairing/Fields.vue';
import Link from '../components/pairing/Link.vue';
import Queue from '../components/pairing/Queue.vue';
import Shell from '../components/Shell.vue';
import { useSession } from '../composables/useSession';
import { ApiError, call, type PairingStatus } from '../shared/api';

useHead({ title: 'Pairing' });

const { csrf } = useSession();

const status = ref<PairingStatus | null>(null);
const failure = ref<string | null>(null);
const busy = ref<string | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

async function load(): Promise<void> {
	try {
		status.value = await call<PairingStatus>('/api/pairing');
		failure.value = null;
	} catch (error) {
		failure.value = error instanceof ApiError ? error.message : 'The request failed';
	}
}

async function decide(id: string, decision: 'approve' | 'reject'): Promise<void> {
	busy.value = id;
	try {
		await call(`/api/pairing/commands/${encodeURIComponent(id)}/${decision}`, {
			method: 'POST',
			csrf: csrf.value
		});
		await load();
	} catch (error) {
		failure.value = error instanceof ApiError ? error.message : 'The request failed';
	} finally {
		busy.value = null;
	}
}

onMounted(() => {
	void load();
	timer = setInterval(() => void load(), 5000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
	<Shell
		title="Pairing"
		icon="i-lucide-link"
		description="This box dials out to the control plane; it never listens for it."
	>
		<UAlert
			v-if="failure"
			color="error"
			variant="subtle"
			icon="i-lucide-circle-alert"
			title="Could Not Read Pairing"
			:description="failure"
			data-test="failure"
		/>

		<template v-if="status">
			<UCard>
				<template #header>
					<h2 class="font-semibold">Link</h2>
				</template>
				<Link :status="status" />
			</UCard>

			<UCard v-if="status.paired">
				<template #header>
					<h2 class="font-semibold">Commands</h2>
				</template>
				<Queue
					:commands="status.commands ?? []"
					:busy="busy"
					@approve="(id) => decide(id, 'approve')"
					@reject="(id) => decide(id, 'reject')"
				/>
				<template #footer>
					<p class="text-sm text-muted">
						Stateful and destructive commands always wait here. Safe and rebuild
						commands wait unless `pairing.commands` sets them to auto.
					</p>
				</template>
			</UCard>

			<UCard>
				<template #header>
					<h2 class="font-semibold">What Leaves This Box</h2>
				</template>
				<Fields :fields="status.fields" />
			</UCard>
		</template>
		<USkeleton
			v-else-if="!failure"
			class="h-52"
		/>
	</Shell>
</template>
