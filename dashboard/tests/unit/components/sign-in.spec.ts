import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import SignIn from '../../../src/components/SignIn.vue';

function stubFetch(status: number, body: unknown): Request[] {
	const seen: Request[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		seen.push(new Request(`http://local${url}`, init));
		return new Response(JSON.stringify(body), { status });
	});
	return seen;
}

const type = async (wrapper: ReturnType<typeof mount>, value: string) => {
	await wrapper.get('[data-test="claim"]').setValue(value);
};

describe('SignIn', () => {
	it('names the command that mints the token, since nothing else can', () => {
		expect(mount(SignIn).text()).toContain('bastion dashboard token');
	});

	it('says why a console with no certificate cannot hold the session', () => {
		expect(mount(SignIn).text()).toContain('__Host-');
	});

	it('will not submit an empty claim', async () => {
		const wrapper = mount(SignIn);
		expect(wrapper.get('[data-test="submit"]').attributes('disabled')).toBeDefined();
	});

	it('masks the token, which is a credential in a shared office', () => {
		expect(mount(SignIn).get('[data-test="claim"]').attributes('type')).toBe('password');
	});

	it('shows the reason a claim was refused rather than failing silently', async () => {
		stubFetch(401, {
			ok: false,
			error: { code: 'unauthenticated', message: 'that claim is not valid', retryable: false }
		});
		const wrapper = mount(SignIn);
		await type(wrapper, 'wrong');
		await wrapper.get('form').trigger('submit');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await wrapper.vm.$nextTick();
		expect(wrapper.get('[data-test="failure"]').text()).toContain('that claim is not valid');
	});
});
