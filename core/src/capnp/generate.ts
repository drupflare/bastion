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
	| { name: string; kind: 'json'; value: unknown }
	| {
			name: string;
			kind: 'hyperdrive';
			service: string;
			database: string;
			user: string;
			password: string;
			scheme: string;
	  }
	| { name: string; kind: 'unsafeEval' }
	| {
			name: string;
			kind: 'wrapped';
			/** an internal module declared by an extension in this same config */
			moduleName: string;
			entrypoint?: string;
			/** bindings handed to the wrapper as `env`, reachable by nothing else */
			innerBindings: BindingSpec[];
	  };

/** a javascript module workerd instantiates itself, which is how a wrapped binding gets its api */
export interface ExtensionModuleSpec {
	/** a fully qualified url with a non-file scheme, e.g. `bastion:d1` */
	name: string;
	internal: boolean;
	esModule: string;
}

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
	/** modules backing the wrapped bindings; workerd requires these to be internal */
	extensionModules?: ExtensionModuleSpec[];
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
		case 'json':
			return `(name = ${name}, json = ${text(JSON.stringify(binding.value))})`;
		// a real group in the schema rather than a shim: workerd pools and caches against whatever
		// the designator names, so bastion points it at its own sql adapter
		case 'hyperdrive':
			return (
				`(name = ${name}, hyperdrive = (designator = ${text(binding.service)}, ` +
				`database = ${text(binding.database)}, user = ${text(binding.user)}, ` +
				`password = ${text(binding.password)}, scheme = ${text(binding.scheme)}))`
			);
		case 'unsafeEval':
			return `(name = ${name}, unsafeEval = void)`;
		case 'wrapped': {
			// how a binding workerd has no field for still reaches the worker as a real object: an
			// internal module is handed the inner bindings and returns what `env.<name>` becomes
			const inner = binding.innerBindings.map(bindingLine).join(', ');
			return `(name = ${name}, wrapped = (moduleName = ${text(binding.moduleName)}, entrypoint = ${text(
				binding.entrypoint ?? 'default'
			)}, innerBindings = [${inner}]))`;
		}
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
	const modules = config.extensionModules ?? [];
	if (modules.length === 0) {
		out.push(`${INDENT}]`);
	} else {
		out.push(`${INDENT}],`);
		out.push(`${INDENT}extensions = [`);
		out.push(`${INDENT.repeat(2)}(modules = [`);
		out.push(
			modules
				.map(
					(m) =>
						`${INDENT.repeat(3)}(name = ${text(m.name)}, internal = ${m.internal}, esModule = ${text(m.esModule)})`
				)
				.join(',\n')
		);
		out.push(`${INDENT.repeat(2)}])`);
		out.push(`${INDENT}]`);
	}
	out.push(');');

	for (const service of config.services) {
		if (service.kind !== 'worker') continue;
		out.push('');
		out.push(renderWorker(service, workerConsts.get(service.name) ?? ''));
	}
	return `${out.join('\n')}\n`;
}
