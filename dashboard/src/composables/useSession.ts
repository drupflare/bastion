import { computed, ref } from 'vue';
import { call, type TenantSummary } from '../shared/api';

export type Role = 'operator' | 'tenant-admin' | 'tenant-viewer';

export interface Principal {
	id: string;
	role: Role;
	tenant: string | null;
}

const principal = ref<Principal | null>(null);
const csrf = ref<string>('');
const tenants = ref<TenantSummary[]>([]);
let bootstrap: Promise<void> | null = null;

/**
 * Who is looking, and what they may see.
 *
 * The tenant view is a FILTER over the same components rather than a second application. A
 * parallel implementation is how two views drift into a privilege bug, and the server refuses
 * anything this filter gets wrong anyway.
 */
export function useSession() {
	const isOperator = computed(() => principal.value?.role === 'operator');
	const canWrite = computed(
		() => principal.value?.role === 'operator' || principal.value?.role === 'tenant-admin'
	);

	/** the tenants this principal may see; an operator sees all of them */
	const visibleTenants = computed(() => {
		if (principal.value === null) return [];
		if (principal.value.role === 'operator') return tenants.value;
		return tenants.value.filter((tenant) => tenant.name === principal.value?.tenant);
	});

	/**
	 * Reads who is signed in, once per page load.
	 *
	 * Memoised on the promise rather than on the value, so the nav and a page mounting at the same
	 * moment share one request instead of racing two. Everything that filters by principal is
	 * empty until this resolves, which is why `load` waits on it rather than running beside it.
	 */
	async function ensure(): Promise<void> {
		if (principal.value !== null) return;
		bootstrap ??= call<Principal & { csrf: string | null }>('/api/session')
			.then((answer) => {
				principal.value = { id: answer.id, role: answer.role, tenant: answer.tenant };
				csrf.value = answer.csrf ?? '';
			})
			.catch(() => {
				// a signed-out browser is not an error; the nav says so and every call answers 401
				bootstrap = null;
			});
		await bootstrap;
	}

	async function load(): Promise<void> {
		await ensure();
		const answer = await call<TenantSummary[] | { tenants: TenantSummary[] }>('/api/tenants');
		tenants.value = Array.isArray(answer) ? answer : answer.tenants;
	}

	function adopt(next: Principal, token: string): void {
		principal.value = next;
		csrf.value = token;
	}

	return { principal, csrf, tenants, isOperator, canWrite, visibleTenants, ensure, load, adopt };
}
