<template>
	<UApp>
		<NuxtLayout>
			<NuxtPage />
		</NuxtLayout>
	</UApp>
</template>

<script setup lang="ts">
useHead({
	titleTemplate: (title) => (!title || title === 'bastion' ? 'bastion' : `${title} · bastion`)
});
</script>
