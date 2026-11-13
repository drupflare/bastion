import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import Fields from '../../../src/components/pairing/Fields.vue';
import Link from '../../../src/components/pairing/Link.vue';
import Queue from '../../../src/components/pairing/Queue.vue';
import type { PairingCommand, PairingFields, PairingStatus } from '../../../src/shared/api';

const fields: PairingFields = {
	leaves: [
		{
			type: 'status',
			fields: [{ field: 'bastionVersion', description: 'the bastion version' }]
		},
		{ type: 'findings', fields: [{ field: 'code', description: 'the tripwire code' }] }
	],
	never: ['request bodies', 'secrets']
};

const unpaired: PairingStatus = { paired: false, fields };

const paired: PairingStatus = {
	paired: true,
	nodeId: 'node_abcdefghijklmnop',
	linkUrl: 'wss://plane.example.edu/api/v1/nodes/link',
	link: {
		connected: true,
		connectedAt: '2026-11-12T10:00:00Z',
		lastMessageAt: '2026-11-12T10:01:00Z',
		lastClose: null,
		lastRefusal: null,
		stopped: null
	},
	commands: [],
	fields
};

const waiting: PairingCommand = {
	id: 'a1b2c3d4e5',
	action: 'site.rollback',
	class: 'stateful',
	named: 'rebuild',
	state: 'queued',
	outcome: null,
	code: null,
	receivedAt: '2026-11-12T10:00:00Z',
	expiresAt: '2026-11-12T10:15:00Z'
};

describe('pairing Link', () => {
	it('says a box that never paired runs on its own and sends nothing', () => {
		const wrapper = mount(Link, { props: { status: unpaired } });
		expect(wrapper.get('[data-test="state"]').text()).toBe('Not Paired');
		expect(wrapper.get('[data-test="standalone"]').text()).toContain('sends nothing');
		expect(wrapper.find('[data-test="node-id"]').exists()).toBe(false);
	});

	it('shows the node, the control plane and the last message once paired', () => {
		const wrapper = mount(Link, { props: { status: paired } });
		expect(wrapper.get('[data-test="state"]').text()).toBe('Connected');
		expect(wrapper.get('[data-test="node-id"]').text()).toBe('node_abcdefghijklmnop');
		expect(wrapper.get('[data-test="link-url"]').text()).toContain('wss://plane.example.edu');
		expect(wrapper.get('[data-test="last-message"]').text()).toBe('2026-11-12T10:01:00Z');
	});

	it('says Never when no message has been sent', () => {
		const quiet = {
			...paired,
			link: { ...paired.link!, connected: false, lastMessageAt: null }
		};
		const wrapper = mount(Link, { props: { status: quiet } });
		expect(wrapper.get('[data-test="state"]').text()).toBe('Not Connected');
		expect(wrapper.get('[data-test="last-message"]').text()).toBe('Never');
	});

	// a revoked node does not retry on its own, and an operator has to be told that
	it('reports a link the control plane stopped, with the way out', () => {
		const stopped = {
			...paired,
			link: { ...paired.link!, connected: false, stopped: { reason: 'revoked', at: null } }
		};
		const wrapper = mount(Link, { props: { status: stopped } });
		expect(wrapper.get('[data-test="state"]').text()).toBe('Stopped');
		expect(wrapper.get('[data-test="stopped"]').text()).toContain('bastion unpair');
	});
});

describe('pairing Queue', () => {
	it('says plainly when nothing is waiting', () => {
		const wrapper = mount(Queue, { props: { commands: [], busy: null } });
		expect(wrapper.get('[data-test="none-waiting"]').text()).toBe('Nothing is waiting.');
	});

	it('lists a queued command with its action and class', () => {
		const wrapper = mount(Queue, { props: { commands: [waiting], busy: null } });
		const row = wrapper.get('[data-test="waiting"]');
		expect(row.text()).toContain('site.rollback');
		expect(row.text()).toContain('stateful');
		expect(row.text()).toContain('a1b2c3d4e5');
	});

	it('emits the command id on approve and on reject', async () => {
		const wrapper = mount(Queue, { props: { commands: [waiting], busy: null } });
		await wrapper.get('[data-test="approve"]').trigger('click');
		await wrapper.get('[data-test="reject"]').trigger('click');
		expect(wrapper.emitted('approve')?.[0]).toEqual(['a1b2c3d4e5']);
		expect(wrapper.emitted('reject')?.[0]).toEqual(['a1b2c3d4e5']);
	});

	it('moves a finished command out of the waiting list into the recent table', () => {
		const done: PairingCommand = {
			...waiting,
			state: 'finished',
			outcome: 'succeeded',
			code: null
		};
		const wrapper = mount(Queue, { props: { commands: [done], busy: null } });
		expect(wrapper.find('[data-test="waiting"]').exists()).toBe(false);
		expect(wrapper.get('[data-test="recent"]').text()).toContain('succeeded');
	});

	it('shows the refusal code beside a rejected command', () => {
		const refused: PairingCommand = {
			...waiting,
			state: 'finished',
			outcome: 'rejected',
			code: 'unsupported_action'
		};
		const wrapper = mount(Queue, { props: { commands: [refused], busy: null } });
		expect(wrapper.get('[data-test="recent"]').text()).toContain('unsupported_action');
	});

	it('disables the buttons of the command being decided', () => {
		const wrapper = mount(Queue, { props: { commands: [waiting], busy: waiting.id } });
		expect(wrapper.get('[data-test="approve"]').attributes('disabled')).toBeDefined();
		expect(wrapper.get('[data-test="reject"]').attributes('disabled')).toBeDefined();
	});
});

describe('pairing Fields', () => {
	it('lists every field of every message type it is given', () => {
		const wrapper = mount(Fields, { props: { fields } });
		expect(wrapper.findAll('[data-test="group"]').map((node) => node.text())).toEqual([
			'status',
			'findings'
		]);
		expect(wrapper.findAll('[data-test="field"]')).toHaveLength(2);
	});

	it('lists what never leaves the box', () => {
		const wrapper = mount(Fields, { props: { fields } });
		expect(wrapper.findAll('[data-test="never"]').map((node) => node.text())).toEqual([
			'request bodies',
			'secrets'
		]);
	});
});
