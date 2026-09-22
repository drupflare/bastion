import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import type { Context } from '../context';
import { BastionError } from '../errors';
import { certificateRequestBase64Url, generateKey } from './csr';

export const DIRECTORIES: Record<string, string> = {
	letsencrypt: 'https://acme-v02.api.letsencrypt.org/directory',
	'letsencrypt-staging': 'https://acme-staging-v02.api.letsencrypt.org/directory',
	zerossl: 'https://acme.zerossl.com/v2/DV90',
	buypass: 'https://api.buypass.com/acme/directory'
};

export interface Directory {
	newNonce: string;
	newAccount: string;
	newOrder: string;
	revokeCert?: string;
	keyChange?: string;
}

export type ChallengeType = 'http-01' | 'dns-01';

export interface Challenge {
	type: string;
	url: string;
	token: string;
	status: string;
}

/**
 * Where a challenge answer is published.
 *
 * A seam rather than a built-in HTTP server, because the answer for `http-01` is served by the
 * front door bastion already runs and the answer for `dns-01` is written wherever the operator's
 * DNS lives. The gate lane substitutes both and never opens a socket.
 */
export interface ChallengeResponder {
	type: ChallengeType;
	publish(host: string, token: string, keyAuthorization: string): Promise<void>;
	retract(host: string, token: string): Promise<void>;
}

export function base64url(bytes: Uint8Array | string): string {
	return Buffer.from(bytes as Uint8Array).toString('base64url');
}

/** the public JWK for a P-256 account key, with exactly the members a thumbprint is taken over */
export function accountJwk(privateKeyPem: string): {
	crv: string;
	kty: string;
	x: string;
	y: string;
} {
	const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: 'jwk' }) as {
		crv?: string;
		kty?: string;
		x?: string;
		y?: string;
	};
	return { crv: jwk.crv ?? '', kty: jwk.kty ?? '', x: jwk.x ?? '', y: jwk.y ?? '' };
}

/**
 * The JWK thumbprint, RFC 7638.
 *
 * The member order is lexicographic and is not a style choice: the thumbprint is a hash of the
 * serialisation, so any other order produces a different value and every challenge fails
 * validation with nothing saying why.
 */
export function thumbprint(privateKeyPem: string): string {
	const jwk = accountJwk(privateKeyPem);
	const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
	return base64url(new Uint8Array(createHash('sha256').update(canonical).digest()));
}

export function keyAuthorization(token: string, privateKeyPem: string): string {
	return `${token}.${thumbprint(privateKeyPem)}`;
}

/** the TXT value for dns-01, which is the HASH of the key authorization rather than the value */
export function dnsChallengeValue(token: string, privateKeyPem: string): string {
	return base64url(
		new Uint8Array(createHash('sha256').update(keyAuthorization(token, privateKeyPem)).digest())
	);
}

export function signJws(
	privateKeyPem: string,
	protectedHeader: Record<string, unknown>,
	payload: unknown
): string {
	const key = createPrivateKey(privateKeyPem);
	const encodedHeader = base64url(JSON.stringify(protectedHeader));
	const encodedPayload = payload === '' ? '' : base64url(JSON.stringify(payload));
	const signature = sign(
		'sha256',
		Buffer.from(`${encodedHeader}.${encodedPayload}`),
		// JOSE wants the raw r||s pair, not the DER wrapper node produces by default
		{ key, dsaEncoding: 'ieee-p1363' }
	);
	return JSON.stringify({
		protected: encodedHeader,
		payload: encodedPayload,
		signature: base64url(new Uint8Array(signature))
	});
}

export interface AcmeOptions {
	directory?: string;
	ca?: string;
	email: string;
	accountKeyPem?: string;
	/** how long to keep polling an authorization or an order */
	timeoutMs?: number;
	sleep?(ms: number): Promise<void>;
}

export interface IssuedCertificate {
	hosts: string[];
	certificatePem: string;
	privateKeyPem: string;
	issuedAt: number;
}

/**
 * An ACME client, RFC 8555, over the fetch seam.
 *
 * Written rather than depended on because the whole protocol that bastion needs is an ordered
 * sequence of signed POSTs, and a client library would bring a crypto stack beside the one node
 * already has. Every request is POST-as-GET where the spec asks for it, which is the half that
 * catches people out: an ordinary GET on an authorization answers, and then `finalize` refuses
 * with an error that names nothing.
 */
export class AcmeClient {
	private readonly ctx: Context;
	private readonly options: AcmeOptions;
	private readonly accountKeyPem: string;
	private directory: Directory | null = null;
	private nonce: string | null = null;
	private kid: string | null = null;

	constructor(ctx: Context, options: AcmeOptions) {
		this.ctx = ctx;
		this.options = options;
		this.accountKeyPem = options.accountKeyPem ?? generateKey().privateKeyPem;
	}

	get accountKey(): string {
		return this.accountKeyPem;
	}

	private get directoryUrl(): string {
		return (
			this.options.directory ??
			DIRECTORIES[this.options.ca ?? 'letsencrypt'] ??
			DIRECTORIES.letsencrypt ??
			''
		);
	}

	async loadDirectory(): Promise<Directory> {
		if (this.directory !== null) return this.directory;
		const response = await this.ctx.fetch(this.directoryUrl);
		if (!response.ok) {
			throw new BastionError(
				'driver-unreachable',
				`the ACME directory answered ${response.status}`,
				{
					retryable: true
				}
			);
		}
		this.directory = (await response.json()) as Directory;
		return this.directory;
	}

	private async freshNonce(): Promise<string> {
		if (this.nonce !== null) {
			const held = this.nonce;
			this.nonce = null;
			return held;
		}
		const directory = await this.loadDirectory();
		const response = await this.ctx.fetch(directory.newNonce, { method: 'HEAD' });
		const nonce = response.headers.get('replay-nonce');
		if (nonce === null)
			throw new BastionError('driver-unreachable', 'the ACME server sent no nonce');
		return nonce;
	}

	private async post(url: string, payload: unknown): Promise<Response> {
		const header: Record<string, unknown> = {
			alg: 'ES256',
			nonce: await this.freshNonce(),
			url
		};
		if (this.kid === null) header.jwk = accountJwk(this.accountKeyPem);
		else header.kid = this.kid;

		const response = await this.ctx.fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/jose+json' },
			body: signJws(this.accountKeyPem, header, payload)
		});
		this.nonce = response.headers.get('replay-nonce');
		return response;
	}

	/** a read of a protected resource is a POST with an EMPTY payload, not a GET */
	private postAsGet(url: string): Promise<Response> {
		return this.post(url, '');
	}

	async register(): Promise<string> {
		const directory = await this.loadDirectory();
		const response = await this.post(directory.newAccount, {
			termsOfServiceAgreed: true,
			contact: [`mailto:${this.options.email}`]
		});
		if (!response.ok && response.status !== 200 && response.status !== 201) {
			throw new BastionError(
				'driver-unreachable',
				`ACME registration answered ${response.status}: ${await response.text()}`
			);
		}
		const location = response.headers.get('location');
		if (location === null)
			throw new BastionError('driver-unreachable', 'ACME sent no account URL');
		this.kid = location;
		return location;
	}

	private wait(ms: number): Promise<void> {
		return this.options.sleep === undefined
			? new Promise((resolve) => setTimeout(resolve, ms))
			: this.options.sleep(ms);
	}

	private async pollUntil(
		url: string,
		wanted: string[],
		what: string
	): Promise<Record<string, unknown>> {
		const deadline = this.ctx.now() + (this.options.timeoutMs ?? 120_000);
		for (;;) {
			const response = await this.postAsGet(url);
			const body = (await response.json()) as Record<string, unknown>;
			const status = String(body.status ?? '');
			if (wanted.includes(status)) return body;
			if (status === 'invalid') {
				throw new BastionError(
					'driver-refused',
					`the ${what} was rejected: ${JSON.stringify(body.error ?? body)}`
				);
			}
			if (this.ctx.now() >= deadline) {
				throw new BastionError('driver-unreachable', `the ${what} never left ${status}`, {
					retryable: true
				});
			}
			await this.wait(2000);
		}
	}

	/**
	 * Issues one certificate covering every host.
	 *
	 * The responder is retracted in a `finally`, so a failed validation does not leave a challenge
	 * answer served or a TXT record published. A stale `_acme-challenge` record is a standing
	 * invitation to anyone who can later guess the token.
	 */
	async issue(hosts: string[], responder: ChallengeResponder): Promise<IssuedCertificate> {
		if (hosts.length === 0)
			throw new BastionError('usage', 'a certificate needs at least one host');
		const directory = await this.loadDirectory();
		if (this.kid === null) await this.register();

		const orderResponse = await this.post(directory.newOrder, {
			identifiers: hosts.map((value) => ({ type: 'dns', value }))
		});
		if (!orderResponse.ok && orderResponse.status !== 201) {
			throw new BastionError(
				'driver-unreachable',
				`ACME newOrder answered ${orderResponse.status}: ${await orderResponse.text()}`
			);
		}
		const orderUrl = orderResponse.headers.get('location') ?? '';
		const order = (await orderResponse.json()) as {
			authorizations: string[];
			finalize: string;
		};

		const published: { host: string; token: string }[] = [];
		try {
			for (const authorizationUrl of order.authorizations) {
				const authorization = (await (await this.postAsGet(authorizationUrl)).json()) as {
					identifier: { value: string };
					challenges: Challenge[];
				};
				const challenge = authorization.challenges.find((c) => c.type === responder.type);
				if (challenge === undefined) {
					throw new BastionError(
						'driver-refused',
						`the CA offers no ${responder.type} challenge for ${authorization.identifier.value}`
					);
				}
				const host = authorization.identifier.value;
				const answer =
					responder.type === 'dns-01'
						? dnsChallengeValue(challenge.token, this.accountKeyPem)
						: keyAuthorization(challenge.token, this.accountKeyPem);
				await responder.publish(host, challenge.token, answer);
				published.push({ host, token: challenge.token });
				await this.post(challenge.url, {});
				await this.pollUntil(
					authorizationUrl,
					['valid'],
					`${responder.type} challenge for ${host}`
				);
			}

			const key = generateKey();
			await this.post(order.finalize, {
				csr: certificateRequestBase64Url(key.privateKeyPem, hosts)
			});
			const finished = await this.pollUntil(orderUrl, ['valid'], 'order');
			const certificateUrl = String(finished.certificate ?? '');
			const certificate = await this.postAsGet(certificateUrl);
			return {
				hosts,
				certificatePem: await certificate.text(),
				privateKeyPem: key.privateKeyPem,
				issuedAt: this.ctx.now()
			};
		} finally {
			for (const entry of published) {
				await responder.retract(entry.host, entry.token).catch(() => {});
			}
		}
	}
}

/**
 * The http-01 responder the front door serves.
 *
 * Answers are held in memory rather than written under a web root: there is no web root here, the
 * front door is the only thing listening on 80, and a file left behind is one more thing to clean
 * up correctly.
 */
export function httpResponder(): ChallengeResponder & {
	answer(token: string): string | null;
	readonly size: number;
} {
	const answers = new Map<string, string>();
	return {
		type: 'http-01',
		get size() {
			return answers.size;
		},
		answer: (token) => answers.get(token) ?? null,
		publish: async (_host, token, keyAuth) => {
			answers.set(token, keyAuth);
		},
		retract: async (_host, token) => {
			answers.delete(token);
		}
	};
}

export const ACME_CHALLENGE_PREFIX = '/.well-known/acme-challenge/';
