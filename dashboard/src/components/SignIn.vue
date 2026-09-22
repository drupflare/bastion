<script setup lang="ts">
import { ref } from 'vue';
import { useSession } from '../composables/useSession';

const { signIn } = useSession();
const claim = ref('');
const failure = ref('');
const working = ref(false);

async function submit(): Promise<void> {
	if (claim.value.trim() === '') return;
	working.value = true;
	failure.value = '';
	try {
		await signIn(claim.value.trim());
		claim.value = '';
	} catch (error) {
		failure.value = error instanceof Error ? error.message : 'that claim is not valid';
	} finally {
		working.value = false;
	}
}
</script>

<template>
	<div class="flex min-h-svh w-full items-center justify-center p-4">
		<div class="w-full max-w-md rounded-lg border border-default bg-default p-6">
			<div class="flex items-center gap-2">
				<span
					class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated"
				>
					<UIcon
						name="i-lucide-shield"
						class="size-5 text-primary"
					/>
				</span>
				<div>
					<h1 class="leading-tight font-semibold">Sign In</h1>
					<p class="text-xs leading-tight text-muted">bastion console</p>
				</div>
			</div>

			<form
				class="mt-6 space-y-3"
				@submit.prevent="submit"
			>
				<UFormField
					label="Claim Token"
					name="claim"
					help="Run `bastion dashboard token` on this box to mint one. It is spent once."
				>
					<UInput
						v-model="claim"
						type="password"
						autocomplete="one-time-code"
						placeholder="paste the token"
						class="w-full"
						data-test="claim"
					/>
				</UFormField>

				<UAlert
					v-if="failure"
					color="error"
					variant="subtle"
					icon="i-lucide-triangle-alert"
					:description="failure"
					data-test="failure"
				/>

				<UButton
					type="submit"
					block
					:loading="working"
					:disabled="claim.trim() === ''"
					data-test="submit"
				>
					Sign In
				</UButton>
			</form>

			<p class="mt-4 text-xs text-muted">
				The session cookie is <code>__Host-</code> prefixed, so a browser keeps it only over
				https. On a console with no certificate, run
				<code>bastion cert self-sign</code> first.
			</p>
		</div>
	</div>
</template>
