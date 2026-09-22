import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import CapacityCard from '../../../src/components/CapacityCard.vue';
import HealthTree from '../../../src/components/HealthTree.vue';
import LimitsTable from '../../../src/components/LimitsTable.vue';
import type { CapacityAnswer, HealthNode } from '../../../src/shared/api';

const tree: HealthNode = {
	name: 'bastion',
	severity: 'error',
	detail: '',
	children: [
		{
			name: 'host',
			severity: 'error',
			detail: '2 findings',
			children: [
				{
					name: 'host.oom_kill',
					severity: 'error',
					detail: 'the kernel killed a tenant',
					children: []
				}
			]
		}
	]
};

describe('HealthTree', () => {
	it('renders every node in the tree', () => {
		const wrapper = mount(HealthTree, { props: { node: tree } });
		expect(wrapper.text()).toContain('bastion');
		expect(wrapper.text()).toContain('host.oom_kill');
	});

	it('labels a severity in words rather than a colour alone', () => {
		const wrapper = mount(HealthTree, { props: { node: tree } });
		expect(wrapper.findAll('[data-test="severity"]')[0]?.text()).toBe('Error');
	});

	it('indents each level, so the shape is readable', () => {
		const wrapper = mount(HealthTree, { props: { node: tree, depth: 2 } });
		expect(wrapper.attributes('style')).toContain('32px');
	});

	it('renders a leaf with no children', () => {
		const leaf: HealthNode = { name: 'ok', severity: 'info', detail: '', children: [] };
		expect(mount(HealthTree, { props: { node: leaf } }).text()).toContain('Healthy');
	});
});

describe('LimitsTable', () => {
	const rows = [
		{ limit: 'cpu', cloudflare: 'enforced', workerd: 'none', bastion: 'enforced per tenant' },
		{
			limit: 'subrequests',
			cloudflare: '50',
			workerd: 'none',
			bastion: 'declared, not enforced'
		}
	];

	// asserted on the state rather than on a class, so restyling cannot silently flip the claim
	it('shows an enforced limit differently from a declared one', () => {
		const wrapper = mount(LimitsTable, { props: { rows } });
		const cells = wrapper.findAll('[data-test="bastion"]');
		expect(cells[0]?.attributes('data-state')).toBe('enforced');
		expect(cells[1]?.attributes('data-state')).toBe('declared');
	});

	it('never renders a declared limit as enforced', () => {
		const wrapper = mount(LimitsTable, { props: { rows } });
		const declared = wrapper.findAll('[data-test="bastion"]')[1];
		expect(declared?.attributes('data-state')).not.toBe('enforced');
	});

	it('shows what standalone workerd enforces, which is nothing', () => {
		expect(mount(LimitsTable, { props: { rows } }).text()).toContain('none');
	});
});

describe('CapacityCard', () => {
	const answer: CapacityAnswer = {
		known: true,
		recommended: 160,
		maximum: 200,
		bindingTerm: 'site storage on disk',
		provenance: 'assumed',
		concurrencyCeiling: 40,
		terms: [],
		notes: ['this is what this host holds and is not a density']
	};

	it('shows the recommendation, the maximum and what binds', () => {
		const wrapper = mount(CapacityCard, { props: { answer } });
		expect(wrapper.get('[data-test="recommended"]').text()).toBe('160');
		expect(wrapper.get('[data-test="maximum"]').text()).toBe('200');
		expect(wrapper.get('[data-test="binding"]').text()).toBe('site storage on disk');
	});

	it('marks an assumed answer so it cannot read as measured', () => {
		const wrapper = mount(CapacityCard, { props: { answer } });
		const badge = wrapper.get('[data-test="provenance"]');
		expect(badge.attributes('data-provenance')).toBe('assumed');
		expect(badge.text()).toBe('assumed');
	});

	it('marks a probed answer differently', () => {
		const assumed = mount(CapacityCard, { props: { answer } });
		const probed = mount(CapacityCard, {
			props: { answer: { ...answer, provenance: 'probed' } }
		});
		expect(probed.get('[data-test="provenance"]').attributes('data-provenance')).toBe('probed');
		// the two must not paint the same, or the column stops distinguishing anything
		expect(probed.get('[data-test="provenance"]').classes()).not.toEqual(
			assumed.get('[data-test="provenance"]').classes()
		);
	});

	it('explains the concurrency ceiling rather than printing a bare number', () => {
		expect(mount(CapacityCard, { props: { answer } }).text()).toContain('resident at once');
	});

	it('hides the ceiling when it does not apply', () => {
		const pinned = { ...answer, concurrencyCeiling: null };
		expect(mount(CapacityCard, { props: { answer: pinned } }).text()).not.toContain(
			'resident at once'
		);
	});

	it('carries the notes through, including the one refusing a density reading', () => {
		expect(mount(CapacityCard, { props: { answer } }).text()).toContain('is not a density');
	});

	it('says a host was not measured rather than showing a ceiling of zero', () => {
		const unread = { ...answer, known: false, recommended: 0, maximum: 0 };
		const wrapper = mount(CapacityCard, { props: { answer: unread } });
		expect(wrapper.get('[data-test="recommended"]').text()).toBe('not measured');
		expect(wrapper.get('[data-test="maximum"]').text()).toBe('not measured');
	});
});
