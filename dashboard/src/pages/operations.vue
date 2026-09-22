<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Shell from '../components/Shell.vue';
import StatCard from '../components/StatCard.vue';
import { call } from '../shared/api';

useHead({ title: 'Operations' });

interface BackupRow {
	site: string;
	version: number;
	takenAt: number;
	bytes: number;
}
interface CertRow {
	host: string;
	expiresAt: number;
	severity: string;
	source: string;
}
interface AuditRow {
	seq: number;
	at: number;
	event: string;
	principal: string;
}

const CERT_COLOR: Record<string, 'success' | 'warning' | 'error'> = {
	ok: 'success',
	warn: 'warning',
	error: 'error',
	critical: 'error',
	expired: 'error'
};

const backups = ref<BackupRow[]>([]);
const certificates = ref<CertRow[]>([]);
const audit = ref<AuditRow[]>([]);
const chainOk = ref<boolean | null>(null);
const loading = ref(true);

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

onMounted(async () => {
	const empty: { entries: AuditRow[]; ok?: boolean } = { entries: [] };
	const [backupPage, auditPage] = await Promise.all([
		call<{ backups: BackupRow[]; certificates?: CertRow[] }>('/api/backups').catch(() => ({
			backups: [] as BackupRow[],
			certificates: [] as CertRow[]
		})),
		call<{ entries: AuditRow[]; ok?: boolean }>('/api/audit').catch(() => empty)
	]);
	backups.value = backupPage.backups;
	certificates.value = backupPage.certificates ?? [];
	audit.value = auditPage.entries;
	chainOk.value = auditPage.ok ?? null;
	loading.value = false;
});
</script>

<template>
	<Shell
		title="Operations"
		icon="i-lucide-wrench"
		description="Backups, certificates and the audit chain, which are the three things that fail quietly."
	>
		<template #actions>
			<UBadge
				v-if="chainOk !== null"
				:color="chainOk ? 'success' : 'error'"
				variant="subtle"
				:icon="chainOk ? 'i-lucide-shield-check' : 'i-lucide-shield-x'"
				size="lg"
				data-test="chain"
			>
				{{ chainOk ? 'Audit chain verifies' : 'Audit chain broken' }}
			</UBadge>
		</template>

		<UAlert
			v-if="chainOk === false"
			color="error"
			variant="subtle"
			icon="i-lucide-shield-x"
			title="The audit chain does not verify"
			description="Run `bastion audit verify` for where it breaks."
		/>

		<div class="grid grid-cols-2 gap-4 lg:grid-cols-3">
			<StatCard
				label="Backups"
				icon="i-lucide-archive"
				:value="backups.length"
				:tone="backups.length === 0 ? 'warning' : 'success'"
				hint="a backup nobody restored is not a backup"
				:loading="loading"
			/>
			<StatCard
				label="Certificates"
				icon="i-lucide-lock"
				:value="certificates.length"
				:loading="loading"
			/>
			<StatCard
				label="Audit Entries"
				icon="i-lucide-list"
				:value="audit.length"
				hint="hash-chained, so a deletion is detectable"
				:loading="loading"
			/>
		</div>

		<UCard>
			<template #header>
				<div class="flex items-center gap-2">
					<UIcon
						name="i-lucide-archive"
						class="size-5 text-muted"
					/>
					<h2 class="font-semibold">Backups</h2>
				</div>
			</template>
			<UEmpty
				v-if="backups.length === 0"
				icon="i-lucide-archive"
				title="No backups have been taken"
				description="The drill runs on a schedule once one exists, because a backup nobody has restored is not a backup."
			/>
			<ul
				v-else
				class="divide-y divide-default"
			>
				<li
					v-for="row in backups"
					:key="`${row.site}-${row.version}`"
					class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
				>
					<UIcon
						name="i-lucide-database"
						class="size-4 text-muted"
					/>
					<span class="font-medium">{{ row.site }}</span>
					<UBadge
						color="neutral"
						variant="subtle"
						size="sm"
						>v{{ row.version }}</UBadge
					>
					<span class="text-muted">{{ megabytes(row.bytes) }}</span>
					<span class="ml-auto text-muted">{{ day(row.takenAt) }}</span>
				</li>
			</ul>
		</UCard>

		<UCard>
			<template #header>
				<div class="flex items-center gap-2">
					<UIcon
						name="i-lucide-lock"
						class="size-5 text-muted"
					/>
					<h2 class="font-semibold">Certificates</h2>
				</div>
			</template>
			<UEmpty
				v-if="certificates.length === 0"
				icon="i-lucide-lock"
				title="No certificates installed"
				description="`bastion cert issue <host>` obtains one over ACME."
			/>
			<ul
				v-else
				class="divide-y divide-default"
			>
				<li
					v-for="row in certificates"
					:key="row.host"
					class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
				>
					<span class="font-medium">{{ row.host }}</span>
					<UBadge
						color="neutral"
						variant="subtle"
						size="sm"
						>{{ row.source }}</UBadge
					>
					<UBadge
						:color="CERT_COLOR[row.severity] ?? 'neutral'"
						variant="subtle"
						size="sm"
						class="ml-auto"
					>
						expires {{ day(row.expiresAt) }}
					</UBadge>
				</li>
			</ul>
		</UCard>

		<UCard>
			<template #header>
				<div class="flex items-center gap-2">
					<UIcon
						name="i-lucide-list"
						class="size-5 text-muted"
					/>
					<h2 class="font-semibold">Audit</h2>
				</div>
			</template>
			<UEmpty
				v-if="audit.length === 0"
				icon="i-lucide-list"
				title="Nothing recorded yet"
				description="Every action records its principal here."
			/>
			<ul
				v-else
				class="divide-y divide-default"
			>
				<li
					v-for="row in audit"
					:key="row.seq"
					class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
				>
					<span class="font-mono text-xs text-muted">#{{ row.seq }}</span>
					<span class="font-medium">{{ row.event }}</span>
					<span class="text-muted">by {{ row.principal }}</span>
				</li>
			</ul>
		</UCard>
	</Shell>
</template>
