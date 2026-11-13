import {
	createPrivateKey,
	createPublicKey,
	randomBytes,
	sign,
	verify,
	type KeyObject
} from 'node:crypto';

/**
 * The fleet link wire format, written against the control plane's published contract.
 *
 * The contract ships as zod schemas, and bastion carries no schema library, so this is a second
 * implementation of the same rules: canonical JSON, the two signing contexts, and the checks a
 * receiver makes. `tests/unit/pair/vectors.spec.ts` runs it over the contract's signed vectors in
 * both directions, which is what keeps it from drifting.
 */

export const FLEET_LINK_VERSION = { major: 1, minor: 0 } as const;
export const FLEET_TS_WINDOW_MS = 5 * 60_000;

export const ENVELOPE_CONTEXT = 'drupflare.fleet-link.envelope.v1';
export const CHALLENGE_CONTEXT = 'drupflare.fleet-link.challenge.v1';

export const COMMAND_CLASSES = ['safe', 'rebuild', 'stateful', 'destructive'] as const;
export type CommandClass = (typeof COMMAND_CLASSES)[number];
export const COMMAND_APPROVALS = ['local', 'automatic'] as const;
export const COMMAND_OUTCOMES = ['succeeded', 'failed', 'rejected', 'expired', 'queued'] as const;
export type CommandOutcome = (typeof COMMAND_OUTCOMES)[number];

export const NODE_MESSAGE_TYPES = [
	'status',
	'findings',
	'metrics.batch',
	'audit.head',
	'usage.report',
	'command.result'
] as const;
export type NodeMessageType = (typeof NODE_MESSAGE_TYPES)[number];

/** private-use close codes the control plane sends; a node reads the code and the reason text */
export const CLOSE = {
	malformed: 4400,
	refused: 4401,
	revoked: 4403,
	handshakeTimeout: 4408,
	replaced: 4409,
	unsupportedVersion: 4426,
	tooManyRefusals: 4429
} as const;

export interface LeavingField {
	type: string;
	field: string;
	description: string;
}

/**
 * Every field that leaves the box, by message type.
 *
 * Copied from the contract's `LEAVES_THE_BOX`. A spec compares it to the dashboard checkout when
 * that checkout is present, so a field added there without a decision here fails the gate.
 */
export const LEAVES_THE_BOX: readonly LeavingField[] = [
	{
		type: 'status',
		field: 'nodeId',
		description: 'The node id the dashboard assigned at pairing.'
	},
	{
		type: 'status',
		field: 'hostname',
		description: 'The host name, sent only if the operator allows it.'
	},
	{ type: 'status', field: 'os', description: 'The operating system name.' },
	{ type: 'status', field: 'arch', description: 'The CPU architecture.' },
	{ type: 'status', field: 'bastionVersion', description: 'The bastion version.' },
	{ type: 'status', field: 'workerdVersion', description: 'The workerd version.' },
	{ type: 'status', field: 'mode', description: 'The bastion operating mode.' },
	{
		type: 'status',
		field: 'tenants',
		description: 'Tenant names, hashed if the operator chooses.'
	},
	{ type: 'status', field: 'sites', description: 'Site names, hashed if the operator chooses.' },
	{
		type: 'status',
		field: 'namesHashed',
		description: 'Whether tenant and site names are hashed.'
	},
	{
		type: 'status',
		field: 'capacity',
		description: 'Capacity numbers such as sites used and memory.'
	},
	{
		type: 'findings',
		field: 'findings',
		description: 'Finding codes with a site name and a count, never content.'
	},
	{ type: 'metrics.batch', field: 'windowStart', description: 'Start of the metrics window.' },
	{ type: 'metrics.batch', field: 'windowEnd', description: 'End of the metrics window.' },
	{ type: 'metrics.batch', field: 'requests', description: 'The request count for the window.' },
	{
		type: 'metrics.batch',
		field: 'points',
		description: 'Named numeric samples, never log bodies.'
	},
	{ type: 'audit.head', field: 'seq', description: 'The audit chain length.' },
	{ type: 'audit.head', field: 'hash', description: 'The audit chain head hash.' },
	{ type: 'usage.report', field: 'reportId', description: 'The usage report id.' },
	{ type: 'usage.report', field: 'source', description: 'The reporting component.' },
	{ type: 'usage.report', field: 'sentAt', description: 'When the report was sent.' },
	{ type: 'usage.report', field: 'intervals', description: 'Hourly view counts per site.' },
	{
		type: 'command.result',
		field: 'opId',
		description: 'The operation the command belonged to.'
	},
	{ type: 'command.result', field: 'stepId', description: 'The step the command belonged to.' },
	{
		type: 'command.result',
		field: 'idempotencyKey',
		description: 'The command idempotency key.'
	},
	{ type: 'command.result', field: 'outcome', description: 'Whether the command succeeded.' },
	{ type: 'command.result', field: 'code', description: 'A result code, never content.' },
	{ type: 'command.result', field: 'deploy', description: 'Deploy metadata: version and time.' }
];

export const NEVER_LEAVES_THE_BOX = [
	'site content',
	'databases',
	'secrets',
	'environment values',
	'log bodies'
] as const;

// #region bytes

export function toBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes)
		.toString('base64')
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
		throw new TypeError('invalid base64url');
	}
	return new Uint8Array(Buffer.from(text, 'base64url'));
}

/** sorts keys by utf-16 code unit and prints numbers as JSON does, which is rfc 8785 for these ranges */
export function canonicalJson(value: unknown): string {
	if (value === null) return 'null';
	switch (typeof value) {
		case 'string':
			return JSON.stringify(value);
		case 'boolean':
			return value ? 'true' : 'false';
		case 'number':
			if (!Number.isFinite(value)) throw new TypeError('canonical json: non-finite number');
			return JSON.stringify(value);
		case 'object': {
			if (Array.isArray(value)) {
				return `[${value
					.map((item) => {
						if (item === undefined)
							throw new TypeError('canonical json: undefined in array');
						return canonicalJson(item);
					})
					.join(',')}]`;
			}
			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) {
				throw new TypeError('canonical json: only plain objects');
			}
			const record = value as Record<string, unknown>;
			const parts: string[] = [];
			for (const key of Object.keys(record).sort()) {
				if (record[key] === undefined) continue;
				parts.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
			}
			return `{${parts.join(',')}}`;
		}
		default:
			throw new TypeError(`canonical json: unsupported ${typeof value}`);
	}
}

// #endregion

// #region ed25519

/** PKCS8 header for an Ed25519 private key; the 32 byte seed follows it */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface SigningKey {
	privateKey: KeyObject;
	/** the raw public key, base64url, which is what the control plane pins */
	publicKey: string;
}

export function signingKeyFromSeed(seed: Uint8Array): SigningKey {
	if (seed.length !== 32) throw new TypeError('ed25519 seed must be 32 bytes');
	const privateKey = createPrivateKey({
		key: Buffer.concat([PKCS8_PREFIX, seed]),
		format: 'der',
		type: 'pkcs8'
	});
	const x = createPublicKey(privateKey).export({ format: 'jwk' }).x;
	if (x === undefined) throw new Error('ed25519 export returned no public key');
	return { privateKey, publicKey: x };
}

export function newSeed(): Uint8Array {
	return new Uint8Array(randomBytes(32));
}

/** the signed bytes are the context line, a newline and the canonical json */
export function signingInput(context: string, value: unknown): string {
	return `${context}\n${canonicalJson(value)}`;
}

export function signCanonical(context: string, value: unknown, key: SigningKey): string {
	return toBase64Url(
		sign(null, Buffer.from(signingInput(context, value), 'utf8'), key.privateKey)
	);
}

const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

export function verifyCanonical(
	context: string,
	value: unknown,
	sig: string,
	publicKey: string
): boolean {
	if (!SIGNATURE.test(sig) || !PUBLIC_KEY.test(publicKey)) return false;
	try {
		const key = createPublicKey({
			key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
			format: 'jwk'
		});
		return verify(
			null,
			Buffer.from(signingInput(context, value), 'utf8'),
			key,
			Buffer.from(fromBase64Url(sig))
		);
	} catch {
		return false;
	}
}

function withoutSig(raw: Record<string, unknown>): Record<string, unknown> {
	const { sig: _sig, ...rest } = raw;
	return rest;
}

// #endregion

// #region shape checks

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value);
const isNonNegative = (value: unknown): value is number => isInt(value) && value >= 0;
const isText = (value: unknown, min: number, max: number): value is string =>
	typeof value === 'string' && value.length >= min && value.length <= max;
const matches = (value: unknown, pattern: RegExp): value is string =>
	typeof value === 'string' && pattern.test(value);

const NODE_ID = /^nod_[0-9a-z]{8,40}$/;
const OP_ID = /^op_[0-9a-z]{8,40}$/;
const SITE_ID = /^site_[0-9a-z]{8,40}$/;
const CODE = /^[A-Za-z0-9._-]{1,64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HOUR_MS = 3_600_000;

const isIso = (value: unknown): value is string =>
	matches(value, ISO) && !Number.isNaN(Date.parse(value));
const nullableText = (value: unknown, max: number): boolean =>
	value === null || isText(value, 0, max);

function hostFactsOk(body: Json): boolean {
	return (
		(body.hostname === undefined || isText(body.hostname, 1, 253)) &&
		isText(body.os, 1, 64) &&
		isText(body.arch, 1, 32) &&
		isText(body.bastionVersion, 1, 64) &&
		isText(body.workerdVersion, 1, 64) &&
		isText(body.mode, 1, 64)
	);
}

function usageIntervalOk(value: unknown): boolean {
	if (!isObject(value)) return false;
	const { accuracy, views, lowerBound } = value;
	if (
		!matches(value.siteId, SITE_ID) ||
		!isIso(value.start) ||
		!isIso(value.end) ||
		!['exact', 'estimated', 'unaccounted'].includes(accuracy as string) ||
		!isNonNegative(views) ||
		!isNonNegative(lowerBound) ||
		!(value.observedViews === null || isNonNegative(value.observedViews)) ||
		!['open', 'closed', 'invoiced', 'adjusted'].includes(value.settlement as string)
	) {
		return false;
	}
	if (Date.parse(value.end as string) - Date.parse(value.start as string) !== HOUR_MS)
		return false;
	if (accuracy === 'exact') return lowerBound === views;
	if (accuracy === 'estimated') return lowerBound <= views;
	return lowerBound === 0;
}

const BODY_CHECKS: Record<NodeMessageType, (body: Json) => boolean> = {
	status: (body) =>
		hostFactsOk(body) &&
		matches(body.nodeId, NODE_ID) &&
		Array.isArray(body.tenants) &&
		body.tenants.every((name) => isText(name, 0, 128)) &&
		Array.isArray(body.sites) &&
		body.sites.every((name) => isText(name, 0, 128)) &&
		typeof body.namesHashed === 'boolean' &&
		isObject(body.capacity) &&
		Object.values(body.capacity).every((n) => typeof n === 'number' && Number.isFinite(n)),
	findings: (body) =>
		Array.isArray(body.findings) &&
		body.findings.every(
			(entry) =>
				isObject(entry) &&
				matches(entry.code, CODE) &&
				nullableText(entry.site, 128) &&
				isInt(entry.count) &&
				entry.count > 0
		),
	'metrics.batch': (body) =>
		isIso(body.windowStart) &&
		isIso(body.windowEnd) &&
		isNonNegative(body.requests) &&
		Array.isArray(body.points) &&
		body.points.every(
			(point) =>
				isObject(point) &&
				matches(point.name, CODE) &&
				typeof point.value === 'number' &&
				Number.isFinite(point.value) &&
				nullableText(point.site, 128)
		),
	'audit.head': (body) => isNonNegative(body.seq) && matches(body.hash, DIGEST),
	'usage.report': (body) =>
		isText(body.reportId, 8, 64) &&
		['dispatch', 'worker', 'node'].includes(body.source as string) &&
		isIso(body.sentAt) &&
		Array.isArray(body.intervals) &&
		body.intervals.length >= 1 &&
		body.intervals.length <= 1000 &&
		body.intervals.every(usageIntervalOk),
	'command.result': (body) =>
		matches(body.opId, OP_ID) &&
		isText(body.stepId, 1, 64) &&
		isText(body.idempotencyKey, 1, 128) &&
		COMMAND_OUTCOMES.includes(body.outcome as CommandOutcome) &&
		(body.code === null || matches(body.code, CODE)) &&
		(body.deploy === null ||
			(isObject(body.deploy) &&
				isText(body.deploy.version, 1, 64) &&
				isIso(body.deploy.deployedAt)))
};

/** whether a body satisfies the contract for its message type */
export function nodeBodyOk(type: NodeMessageType, body: unknown): boolean {
	return isObject(body) && BODY_CHECKS[type](body);
}

export interface CommandBody {
	nodeId: string;
	opId: string;
	stepId: string;
	idempotencyKey: string;
	expiresAt: number;
	class: CommandClass;
	approval: 'local' | 'automatic';
	action: string;
	params: Record<string, unknown>;
}

function commandBodyOk(body: unknown): body is CommandBody {
	return (
		isObject(body) &&
		matches(body.nodeId, NODE_ID) &&
		matches(body.opId, OP_ID) &&
		isText(body.stepId, 1, 64) &&
		isText(body.idempotencyKey, 1, 128) &&
		isNonNegative(body.expiresAt) &&
		COMMAND_CLASSES.includes(body.class as CommandClass) &&
		(COMMAND_APPROVALS as readonly string[]).includes(body.approval as string) &&
		isText(body.action, 1, 64) &&
		isObject(body.params)
	);
}

// #endregion

// #region envelope

export interface Envelope<B = unknown> {
	v: number;
	id: string;
	type: string;
	ts: number;
	seq: number;
	ack: number;
	body: B;
	sig: string;
}

export type CommandEnvelope = Envelope<CommandBody> & { type: 'command' };

export const ENVELOPE_REFUSALS = [
	'malformed',
	'unsupported_version',
	'wrong_direction',
	'bad_signature',
	'expired',
	'future',
	'command_expired',
	'wrong_node',
	'replayed'
] as const;
export type EnvelopeRefusal = (typeof ENVELOPE_REFUSALS)[number];

export type Verified<T, C extends string> = { ok: true; value: T } | { ok: false; code: C };

export function signEnvelope<B>(message: Omit<Envelope<B>, 'sig'>, key: SigningKey): Envelope<B> {
	return { ...message, sig: signCanonical(ENVELOPE_CONTEXT, message, key) };
}

export interface VerifyEnvelopeOptions {
	publicKey: string;
	direction: 'node' | 'server';
	now: number;
	windowMs?: number;
	seen?: ReadonlySet<string>;
	/** the receiving node's own id; a command is refused unless it names this node */
	nodeId?: string;
}

function shapeOk(raw: Json, direction: 'node' | 'server'): boolean {
	if (
		!isText(raw.id, 8, 64) ||
		!isNonNegative(raw.ts) ||
		!isNonNegative(raw.seq) ||
		!isNonNegative(raw.ack) ||
		!matches(raw.sig, SIGNATURE)
	) {
		return false;
	}
	if (direction === 'server') return raw.type === 'command' && commandBodyOk(raw.body);
	return (
		(NODE_MESSAGE_TYPES as readonly string[]).includes(raw.type as string) &&
		nodeBodyOk(raw.type as NodeMessageType, raw.body)
	);
}

/** the checks a receiver makes, in the contract's order, so a refusal code means the same thing */
export function verifyEnvelope(
	raw: unknown,
	opts: VerifyEnvelopeOptions
): Verified<Envelope, EnvelopeRefusal> {
	if (!isObject(raw)) return { ok: false, code: 'malformed' };
	if (typeof raw.v === 'number' && raw.v !== FLEET_LINK_VERSION.major) {
		return { ok: false, code: 'unsupported_version' };
	}
	if (raw.v !== FLEET_LINK_VERSION.major || !shapeOk(raw, opts.direction)) {
		const other: readonly string[] =
			opts.direction === 'node' ? ['command'] : NODE_MESSAGE_TYPES;
		const wrong = typeof raw.type === 'string' && other.includes(raw.type);
		return { ok: false, code: wrong ? 'wrong_direction' : 'malformed' };
	}
	const message = raw as unknown as Envelope;
	if (!verifyCanonical(ENVELOPE_CONTEXT, withoutSig(raw), message.sig, opts.publicKey)) {
		return { ok: false, code: 'bad_signature' };
	}
	if (message.type === 'command' && (message.body as CommandBody).nodeId !== opts.nodeId) {
		return { ok: false, code: 'wrong_node' };
	}
	const windowMs = opts.windowMs ?? FLEET_TS_WINDOW_MS;
	if (message.ts < opts.now - windowMs) return { ok: false, code: 'expired' };
	if (message.ts > opts.now + windowMs) return { ok: false, code: 'future' };
	if (message.type === 'command' && (message.body as CommandBody).expiresAt <= opts.now) {
		return { ok: false, code: 'command_expired' };
	}
	if (opts.seen?.has(message.id)) return { ok: false, code: 'replayed' };
	return { ok: true, value: message };
}

// #endregion

// #region challenge

export interface Challenge {
	nonce: string;
	ts: number;
}

export interface VersionRange {
	min: { major: number; minor: number };
	max: { major: number; minor: number };
}

export interface ChallengeResponse {
	v: number;
	nodeId: string;
	nonce: string;
	ts: number;
	range: VersionRange;
	sig: string;
}

export const CHALLENGE_REFUSALS = [
	'malformed',
	'unsupported_version',
	'bad_signature',
	'wrong_nonce',
	'expired',
	'future'
] as const;
export type ChallengeRefusal = (typeof CHALLENGE_REFUSALS)[number];

const NONCE = /^[A-Za-z0-9_-]{22,64}$/;

export function parseChallenge(raw: unknown): Challenge | null {
	if (!isObject(raw) || raw.type !== 'challenge') return null;
	if (!matches(raw.nonce, NONCE) || !isNonNegative(raw.ts)) return null;
	return { nonce: raw.nonce, ts: raw.ts };
}

export function newChallenge(now: number): Challenge {
	return { nonce: toBase64Url(new Uint8Array(randomBytes(16))), ts: now };
}

export function signChallengeResponse(
	fields: { nodeId: string; nonce: string; ts: number; range: VersionRange },
	key: SigningKey
): ChallengeResponse {
	const unsigned = { v: FLEET_LINK_VERSION.major, ...fields };
	return { ...unsigned, sig: signCanonical(CHALLENGE_CONTEXT, unsigned, key) };
}

const versionOk = (value: unknown): boolean =>
	isObject(value) && isNonNegative(value.major) && isNonNegative(value.minor);

export function verifyChallengeResponse(
	raw: unknown,
	opts: { publicKey: string; nonce: string; now: number; windowMs?: number }
): Verified<ChallengeResponse, ChallengeRefusal> {
	if (!isObject(raw)) return { ok: false, code: 'malformed' };
	if (typeof raw.v === 'number' && raw.v !== FLEET_LINK_VERSION.major) {
		return { ok: false, code: 'unsupported_version' };
	}
	if (
		raw.v !== FLEET_LINK_VERSION.major ||
		!matches(raw.nodeId, NODE_ID) ||
		!matches(raw.nonce, NONCE) ||
		!isNonNegative(raw.ts) ||
		!isObject(raw.range) ||
		!versionOk(raw.range.min) ||
		!versionOk(raw.range.max) ||
		!matches(raw.sig, SIGNATURE)
	) {
		return { ok: false, code: 'malformed' };
	}
	const response = raw as unknown as ChallengeResponse;
	if (!verifyCanonical(CHALLENGE_CONTEXT, withoutSig(raw), response.sig, opts.publicKey)) {
		return { ok: false, code: 'bad_signature' };
	}
	if (response.nonce !== opts.nonce) return { ok: false, code: 'wrong_nonce' };
	const windowMs = opts.windowMs ?? FLEET_TS_WINDOW_MS;
	if (response.ts < opts.now - windowMs) return { ok: false, code: 'expired' };
	if (response.ts > opts.now + windowMs) return { ok: false, code: 'future' };
	return { ok: true, value: response };
}

// #endregion
