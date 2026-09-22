<script setup lang="ts">
// three-way cycle rather than a binary toggle, so someone can opt back into following the OS
// without flipping it by hand at sunset
const colorMode = useColorMode();

const cycle = (): void => {
	colorMode.preference =
		colorMode.preference === 'system'
			? 'light'
			: colorMode.preference === 'light'
				? 'dark'
				: 'system';
};

const icon = computed(() => {
	if (colorMode.preference === 'system') return 'i-lucide-monitor';
	if (colorMode.preference === 'light') return 'i-lucide-sun';
	return 'i-lucide-moon';
});

const label = computed(() => {
	if (colorMode.preference === 'system') return 'Theme: follows system. Click for light.';
	if (colorMode.preference === 'light') return 'Theme: light. Click for dark.';
	return 'Theme: dark. Click to follow the system.';
});
</script>

<template>
	<ClientOnly>
		<UButton
			:icon="icon"
			color="neutral"
			variant="ghost"
			size="sm"
			:aria-label="label"
			:title="label"
			data-test="theme"
			@click="cycle"
		/>
		<template #fallback>
			<span class="inline-block size-8" />
		</template>
	</ClientOnly>
</template>
