import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import Nodes from '../../../src/components/cluster/Nodes.vue';
import DeployHistory from '../../../src/components/site/DeployHistory.vue';
import Capabilities from '../../../src/components/tenant/Capabilities.vue';
import Card from '../../../src/components/tenant/Card.vue';
import type { TenantSummary } from '../../../src/shared/api';

const tenant: TenantSummary = {
	name: 'acme',
	sites: [{ host: 'www.example.edu' }],
	limits: { cpu: '2', memory: 4096, maxSites: 40 },
	egress: { allow: [] }
};

describe('tenant Card', () => {
	it('shows the quota, which is what makes delegation safe', () => {
		const wrapper = mount(Card, { props: { tenant, canWrite: true } });
		expect(wrapper.get('[data-test="quota"]').text()).toBe('40');
	});

	it('says unset rather than a number when there is no ceiling', () => {
		const open = { ...tenant, limits: { cpu: '2' } };
		expect(
			mount(Card, { props: { tenant: open, canWrite: true } })
				.get('[data-test="quota"]')
				.text()
		).toBe('unset');
	});

	// the cgroup limit is set in binary units, and a raw byte count is not a number anyone reads
	it('renders a memory limit in binary units rather than raw bytes', () => {
		const sized = { ...tenant, limits: { ...tenant.limits, memory: 4 * 1024 ** 3 } };
		expect(
			mount(Card, { props: { tenant: sized, canWrite: true } })
				.get('[data-test="memory"]')
				.text()
		).toBe('4 GiB');
	});

	it('says max when a tenant has no memory ceiling', () => {
		const open = { ...tenant, limits: { cpu: '2' } };
		expect(
			mount(Card, { props: { tenant: open, canWrite: true } })
				.get('[data-test="memory"]')
				.text()
		).toBe('max');
	});

	it('says plainly that an empty allow list denies everything', () => {
		expect(mount(Card, { props: { tenant, canWrite: true } }).text()).toContain(
			'everything outbound is denied'
		);
	});

	it('hides the manage button from a viewer', () => {
		const wrapper = mount(Card, { props: { tenant, canWrite: false } });
		expect(wrapper.find('[data-test="open"]').exists()).toBe(false);
	});

	it('emits the tenant name rather than an index when managed', async () => {
		const wrapper = mount(Card, { props: { tenant, canWrite: true } });
		await wrapper.get('[data-test="open"]').trigger('click');
		expect(wrapper.emitted('open')?.[0]).toEqual(['acme']);
	});
});

describe('tenant Capabilities', () => {
	const rows = [
		{ name: 'codegen', value: 'no', enforcement: 'capnp: unsafeEval not emitted -- enforced' },
		{ name: 'adminPhpConsole', value: 'no', enforcement: 'site var -- DECLARED, not enforced' }
	];

	it('marks an enforced capability differently from a declared one', () => {
		const wrapper = mount(Capabilities, { props: { rows } });
		expect(wrapper.get('[data-test="enforcement-codegen"]').classes()).toContain('text-ok');
		expect(wrapper.get('[data-test="enforcement-adminPhpConsole"]').classes()).toContain(
			'text-warn'
		);
	});

	it('never shows a declared capability as enforced, even though the word appears in its text', () => {
		const wrapper = mount(Capabilities, { props: { rows } });
		expect(wrapper.get('[data-test="enforcement-adminPhpConsole"]').classes()).not.toContain(
			'text-ok'
		);
	});
});

describe('cluster Nodes', () => {
	const nodes = [
		{ id: 'node-a', address: '10.0.0.1:8788', state: 'ready' as const, lastSeenAt: 0 },
		{ id: 'node-b', address: '10.0.0.2:8788', state: 'unreachable' as const, lastSeenAt: 0 }
	];

	// asserted on the rendered state rather than on a class, so restyling cannot flip the meaning
	it('shows each node with its state', () => {
		const wrapper = mount(Nodes, { props: { nodes, reachable: true } });
		const states = wrapper.findAll('[data-test="state"]');
		expect(states[0]?.text()).toBe('ready');
		expect(states[1]?.text()).toBe('unreachable');
		expect(states[0]?.html()).not.toBe(states[1]?.html());
	});

	it('degrades to this node rather than erroring when the control node is gone', () => {
		const wrapper = mount(Nodes, { props: { nodes, reachable: false } });
		expect(wrapper.get('[data-test="degraded"]').text()).toContain('showing this node only');
	});

	it('shows no banner when the control node answers', () => {
		expect(
			mount(Nodes, { props: { nodes, reachable: true } })
				.find('[data-test="degraded"]')
				.exists()
		).toBe(false);
	});
});

describe('site DeployHistory', () => {
	const deployments = [
		{ current: 'aaaaaaaaaaaaaaaa', split: null, at: 0, by: 'op' },
		{
			current: 'bbbbbbbbbbbbbbbb',
			split: { version: 'cccccccccccccccc', percent: 10 },
			at: 1,
			by: 'op'
		}
	];

	it('shows a split as a share rather than as a second deployment', () => {
		const wrapper = mount(DeployHistory, { props: { deployments, canWrite: true } });
		expect(wrapper.get('[data-test="split"]').text()).toContain('10%');
	});

	it('offers no rollback on the current deployment', () => {
		const wrapper = mount(DeployHistory, { props: { deployments, canWrite: true } });
		expect(wrapper.findAll('[data-test="rollback"]')).toHaveLength(1);
	});

	it('offers no rollback at all to a viewer', () => {
		const wrapper = mount(DeployHistory, { props: { deployments, canWrite: false } });
		expect(wrapper.findAll('[data-test="rollback"]')).toHaveLength(0);
	});

	it('emits the version to roll back to', async () => {
		const wrapper = mount(DeployHistory, { props: { deployments, canWrite: true } });
		await wrapper.get('[data-test="rollback"]').trigger('click');
		expect(wrapper.emitted('rollback')?.[0]).toEqual(['bbbbbbbbbbbbbbbb']);
	});
});
