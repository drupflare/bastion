import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import Summary, { type SiteRow } from '../../../src/components/analytics/Summary.vue';

const row: SiteRow = {
	site: 'www.example.edu',
	tenant: 'acme',
	requests: 1000,
	errors: 0,
	refusals: 0,
	cachedFraction: 0.82,
	bytes: 1024,
	p50Ms: 12,
	p95Ms: 90,
	p99Ms: 300
};

describe('analytics Summary', () => {
	it('shows the cached fraction, which is what explains a slow site', () => {
		const wrapper = mount(Summary, { props: { rows: [row], hostMetrics: true } });
		expect(wrapper.get('[data-test="cached"]').text()).toBe('82%');
		expect(wrapper.get('[data-test="cached"]').classes()).toContain('text-ok');
	});

	it('marks a fallen cache fraction, rather than leaving it to be noticed', () => {
		const cold = { ...row, cachedFraction: 0.2 };
		const wrapper = mount(Summary, { props: { rows: [cold], hostMetrics: true } });
		expect(wrapper.get('[data-test="cached"]').classes()).toContain('text-warn');
	});

	it('separates a refusal from a site error, because they have different causes', () => {
		const mixed = { ...row, errors: 3, refusals: 7 };
		const wrapper = mount(Summary, { props: { rows: [mixed], hostMetrics: true } });
		expect(wrapper.get('[data-test="errors"]').text()).toBe('3');
		expect(wrapper.get('[data-test="refusals"]').text()).toBe('7');
		expect(wrapper.get('[data-test="errors"]').classes()).toContain('text-bad');
	});

	it('tells a tenant why it sees no host figures rather than showing an empty panel', () => {
		const wrapper = mount(Summary, { props: { rows: [row], hostMetrics: false } });
		expect(wrapper.get('[data-test="scope"]').text()).toContain(
			'describe every tenant on the box'
		);
	});

	it('shows no scope note to an operator', () => {
		const wrapper = mount(Summary, { props: { rows: [row], hostMetrics: true } });
		expect(wrapper.find('[data-test="scope"]').exists()).toBe(false);
	});

	it('says plainly that a window is empty', () => {
		expect(mount(Summary, { props: { rows: [], hostMetrics: true } }).text()).toContain(
			'No requests in this window'
		);
	});
});
