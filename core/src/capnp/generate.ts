import { ident, serviceName, text } from './escape';

/** a module inside a Worker; `esModule` is inline source, `wasm`/`esModulePath` are embeds */
export interface ModuleSpec {
	name: string;
	kind: 'esModule' | 'wasm' | 'text' | 'data';
	/** inline source for esModule, or a path to embed */
	source?: string;
	embed?: string;
}

export type BindingSpec =
	| { name: string; kind: 'text'; value: string }
	| { name: string; kind: 'service'; service: string }
	| { name: string; kind: 'durableObjectNamespace'; className: string }
	| { name: string; kind: 'kvNamespace'; service: string }
	| { name: string; kind: 'r2Bucket'; service: string }
	| { name: string; kind: 'queue'; service: string }
	| { name: string; kind: 'unsafeEval' };

export interface DurableObjectSpec {
	className: string;
	uniqueKey: string;
	enableSql: boolean;
	preventEviction?: boolean;
}

export interface WorkerSpec {
	kind: 'worker';
	name: string;
	modules: ModuleSpec[];
	compatibilityDate: string;
	compatibilityFlags?: string[];
	cacheApiOutbound?: string;
	globalOutbound?: string;
	durableObjectNamespaces?: DurableObjectSpec[];
	durableObjectStorage?: { localDisk: string };
	bindings?: BindingSpec[];
}

export interface DiskSpec {
	kind: 'disk';
	name: string;
	path: string;
	writable?: boolean;
	allowDotfiles?: boolean;
}

export interface ExternalSpec {
	kind: 'external';
	name: string;
	address: string;
}

export interface NetworkSpec {
	kind: 'network';
	name: string;
	allow?: string[];
	deny?: string[];
}

export type ServiceSpec = WorkerSpec | DiskSpec | ExternalSpec | NetworkSpec;

export interface SocketSpec {
	name: string;
	address: string;
	service: string;
	/** http is the only style bastion emits; TLS is terminated in front, since workerd has no SNI */
	http?: boolean;
}

export interface CapnpConfig {
	services: ServiceSpec[];
	sockets: SocketSpec[];
}

const INDENT = '\t';

function lines(parts: string[], depth: number): string {
	return parts.map((p) => `${INDENT.repeat(depth)}${p}`).join('\n');
}

function moduleLine(module: ModuleSpec): string {
	const name = text(module.name);
	if (module.kind === 'esModule' && module.source !== undefined) {
		return `(name = ${name}, esModule = ${text(module.source)})`;
	}
	const embed = text(module.embed ?? module.name);
	return `(name = ${name}, ${module.kind} = embed ${embed})`;
}

function bindingLine(binding: BindingSpec): string {
	const name = text(binding.name);
	switch (binding.kind) {
		case 'text':
			return `(name = ${name}, text = ${text(binding.value)})`;
		case 'service':
			return `(name = ${name}, service = ${text(binding.service)})`;
		case 'durableObjectNamespace':
			return `(name = ${name}, durableObjectNamespace = ${text(binding.className)})`;
		case 'kvNamespace':
			return `(name = ${name}, kvNamespace = ${text(binding.service)})`;
		case 'r2Bucket':
			return `(name = ${name}, r2Bucket = ${text(binding.service)})`;
		case 'queue':
			return `(name = ${name}, queue = ${text(binding.service)})`;
		case 'unsafeEval':
			return `(name = ${name}, unsafeEval = void)`;
	}
}

function durableObjectLine(spec: DurableObjectSpec): string {
	const parts = [
		`className = ${text(spec.className)}`,
		`uniqueKey = ${text(spec.uniqueKey)}`,
		`enableSql = ${spec.enableSql ? 'true' : 'false'}`
	];
	if (spec.preventEviction === true) parts.push('preventEviction = true');
	return `(${parts.join(', ')})`;
}

function renderWorker(worker: WorkerSpec, constName: string): string {
	const body: string[] = [];
	body.push('modules = [');
	body.push(lines(worker.modules.map(moduleLine), 1).replace(/^/, '').split('\n').join(',\n'));
	body.push('],');
	body.push(`compatibilityDate = ${text(worker.compatibilityDate)},`);
	if (worker.compatibilityFlags !== undefined && worker.compatibilityFlags.length > 0) {
		body.push(`compatibilityFlags = [${worker.compatibilityFlags.map(text).join(', ')}],`);
	}
	if (worker.cacheApiOutbound !== undefined) {
		body.push(`cacheApiOutbound = ${text(worker.cacheApiOutbound)},`);
	}
	if (worker.globalOutbound !== undefined) {
		body.push(`globalOutbound = ${text(worker.globalOutbound)},`);
	}
	if (worker.durableObjectNamespaces !== undefined && worker.durableObjectNamespaces.length > 0) {
		body.push('durableObjectNamespaces = [');
		body.push(
			worker.durableObjectNamespaces
				.map((d) => `${INDENT}${durableObjectLine(d)}`)
				.join(',\n')
		);
		body.push('],');
	}
	if (worker.durableObjectStorage !== undefined) {
		body.push(
			`durableObjectStorage = (localDisk = ${text(worker.durableObjectStorage.localDisk)}),`
		);
	}
	if (worker.bindings !== undefined && worker.bindings.length > 0) {
		body.push('bindings = [');
		body.push(worker.bindings.map((b) => `${INDENT}${bindingLine(b)}`).join(',\n'));
		body.push(']');
	}
	const rendered = body
		.join('\n')
		.split('\n')
		.map((l) => (l === '' ? l : `${INDENT}${l}`))
		.join('\n');
	return `const ${ident(constName)} :Workerd.Worker = (\n${rendered}\n);`;
}

function serviceEntry(service: ServiceSpec, constName: string): string {
	switch (service.kind) {
		case 'worker':
			return `(name = ${text(service.name)}, worker = .${ident(constName)})`;
		case 'disk': {
			const parts = [`path = ${text(service.path)}`];
			parts.push(`writable = ${service.writable === true ? 'true' : 'false'}`);
			if (service.allowDotfiles === true) parts.push('allowDotfiles = true');
			return `(name = ${text(service.name)}, disk = (${parts.join(', ')}))`;
		}
		case 'external':
			return `(name = ${text(service.name)}, external = (address = ${text(service.address)}))`;
		case 'network': {
			const parts: string[] = [];
			if (service.allow !== undefined) {
				parts.push(`allow = [${service.allow.map(text).join(', ')}]`);
			}
			if (service.deny !== undefined) {
				parts.push(`deny = [${service.deny.map(text).join(', ')}]`);
			}
			const inner = parts.length === 0 ? '' : ` (${parts.join(', ')})`;
			return `(name = ${text(service.name)}, network =${inner === '' ? ' ()' : inner})`;
		}
	}
}

function socketEntry(socket: SocketSpec): string {
	const parts = [`name = ${text(socket.name)}`, `address = ${text(socket.address)}`];
	if (socket.http !== false) parts.push('http = ()');
	parts.push(`service = ${text(socket.service)}`);
	return `(${parts.join(', ')})`;
}

/**
 * Renders a `config.capnp` for `workerd serve`.
 *
 * The shape reproduces the 2026-09-21 smoke lane exactly: a main worker, a cache service on
 * `cacheApiOutbound` (mandatory -- without it every `/` is a 500 `No Cache was configured`), a KV
 * service behind the `kvNamespace` designator, and `durableObjectStorage = (localDisk = ...)`.
 */
export function renderConfig(config: CapnpConfig): string {
	const workerConsts = new Map<string, string>();
	for (const service of config.services) {
		if (service.kind === 'worker') {
			workerConsts.set(service.name, serviceName('w', service.name));
		}
	}

	const out: string[] = [];
	out.push('using Workerd = import "/workerd/workerd.capnp";');
	out.push('');
	out.push('const config :Workerd.Config = (');
	out.push(`${INDENT}services = [`);
	out.push(
		config.services
			.map((s) => `${INDENT.repeat(2)}${serviceEntry(s, workerConsts.get(s.name) ?? '')}`)
			.join(',\n')
	);
	out.push(`${INDENT}],`);
	out.push(`${INDENT}sockets = [`);
	out.push(config.sockets.map((s) => `${INDENT.repeat(2)}${socketEntry(s)}`).join(',\n'));
	out.push(`${INDENT}]`);
	out.push(');');

	for (const service of config.services) {
		if (service.kind !== 'worker') continue;
		out.push('');
		out.push(renderWorker(service, workerConsts.get(service.name) ?? ''));
	}
	return `${out.join('\n')}\n`;
}
