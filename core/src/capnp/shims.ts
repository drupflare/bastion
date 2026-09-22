/**
 * The modules behind bastion's wrapped bindings.
 *
 * workerd carries no `d1Database` and no `ai` field, so neither can be bound natively. It does
 * carry `wrapped @14 :WrappedBinding`, which instantiates an internal module and hands it the
 * inner bindings, and whatever that module returns is what `env.<name>` becomes. So the binding
 * that does not exist is built out of the one that does, which is the same mechanism miniflare
 * uses to serve D1 locally.
 *
 * These are source strings rather than files because a wrapped module must be declared inline in
 * the config as an extension: workerd will not load one off disk, and the bundle may not provide
 * it either. They are the only javascript bastion ships into a tenant, so they hold no state, keep
 * no credentials and reach exactly one service.
 */

/** the module name for each shim; a fully qualified url with a non-file scheme, as workerd wants */
export const SHIM_MODULES = {
	d1: 'bastion:d1',
	vectorize: 'bastion:vectorize',
	images: 'bastion:images',
	browser: 'bastion:browser',
	email: 'bastion:email',
	analytics: 'bastion:analytics',
	ai: 'bastion:ai'
} as const;

/**
 * `env.DB`, as D1 presents it.
 *
 * Covers the surface a Worker actually calls: `prepare().bind().first()/all()/run()/raw()`,
 * `batch()`, `exec()` and `dump()`. `dump()` throws rather than returning something wrong, because
 * a caller that gets bytes back expects a restorable SQLite image and bastion serves statements.
 */
export const D1_SHIM = `
const post = async (fetcher, body) => {
	const response = await fetcher.fetch('http://bastion/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!response.ok) throw new Error('D1_ERROR: ' + response.status + ' ' + (await response.text()));
	return response.json();
};

// bastion's sql adapter answers {rows, rowsAffected, lastInsertId} and D1 answers
// {results, success, meta}. Two different contracts either side of one socket, so the shim maps
// between them; without this every caller reading a result set gets undefined
const shape = (answer) => ({
	results: (answer && answer.rows) ?? [],
	success: true,
	meta: {
		changes: (answer && answer.rowsAffected) ?? 0,
		last_row_id: (answer && answer.lastInsertId) ?? null,
		rows_read: ((answer && answer.rows) ?? []).length,
		rows_written: (answer && answer.rowsAffected) ?? 0
	}
});

const one = (answers) => shape(answers && answers[0]);

class Statement {
	constructor(fetcher, sql, params) {
		this.fetcher = fetcher;
		this.sql = sql;
		this.params = params ?? [];
	}
	bind(...params) {
		return new Statement(this.fetcher, this.sql, params);
	}
	async all() {
		const body = await post(this.fetcher, { sql: this.sql, params: this.params });
		return one(body.results);
	}
	async run() {
		return this.all();
	}
	async first(column) {
		const answer = await this.all();
		const row = answer.results[0];
		if (row === undefined) return null;
		return column === undefined ? row : (row[column] ?? null);
	}
	async raw(options) {
		const answer = await this.all();
		const rows = answer.results.map((row) => Object.values(row));
		if (options && options.columnNames) {
			const first = answer.results[0];
			return first === undefined ? rows : [Object.keys(first), ...rows];
		}
		return rows;
	}
}

export default function (env) {
	const fetcher = env.fetcher;
	return {
		prepare: (sql) => new Statement(fetcher, sql),
		batch: async (statements) => {
			const body = await post(fetcher, {
				batch: statements.map((s) => ({ sql: s.sql, params: s.params }))
			});
			// one D1 result per statement, in the order they were sent
			return (body.results ?? []).map(shape);
		},
		exec: async (sql) => {
			const body = await post(fetcher, { sql });
			return { count: (body.results ?? []).length, duration: 0 };
		},
		dump: async () => {
			throw new Error('D1_ERROR: bastion serves sql over an adapter and cannot dump a file');
		},
		withSession: () => {
			throw new Error('D1_ERROR: sessions are a Cloudflare replication feature');
		}
	};
}
`.trimStart();

/**
 * `env.AI`, as Workers AI presents it.
 *
 * `run(model, inputs)` posts to bastion's ai adapter, which forwards to whatever inference server
 * the operator configured. A streaming request returns the body directly so a caller piping it to
 * a `Response` keeps working; everything else is parsed.
 */
export const AI_SHIM = `
export default function (env) {
	const fetcher = env.fetcher;
	return {
		async run(model, inputs, options) {
			const response = await fetcher.fetch('http://bastion/run', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model, inputs: inputs ?? {}, options: options ?? {} })
			});
			if (!response.ok) {
				throw new Error('AiError: ' + response.status + ' ' + (await response.text()));
			}
			if (inputs && inputs.stream === true) return response.body;
			const body = await response.json();
			return body.result;
		},
		async models(params) {
			const query = new URLSearchParams(params ?? {}).toString();
			const response = await fetcher.fetch('http://bastion/models?' + query);
			if (!response.ok) throw new Error('AiError: ' + response.status);
			return (await response.json()).models;
		},
		gateway() {
			throw new Error('AiError: an AI Gateway is a Cloudflare product with no self-hosted half');
		},
		toMarkdown() {
			throw new Error('AiError: markdown conversion runs on Cloudflare infrastructure');
		}
	};
}
`.trimStart();

/**
 * `env.VECTORIZE`, as Vectorize presents it.
 *
 * The same five calls a Worker makes, each one post to the adapter. `insert` and `upsert` differ
 * only in whether an existing id is left alone, and that difference is decided by the index rather
 * than here, so the shim does not have to know which one it is talking to.
 */
export const VECTORIZE_SHIM = `
const call = async (fetcher, path, body) => {
	const response = await fetcher.fetch('http://bastion' + path, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!response.ok) {
		throw new Error('VectorizeError: ' + response.status + ' ' + (await response.text()));
	}
	return response.json();
};

export default function (env) {
	const fetcher = env.fetcher;
	return {
		describe: () => call(fetcher, '/describe'),
		insert: (records) => call(fetcher, '/insert', { records }),
		upsert: (records) => call(fetcher, '/upsert', { records }),
		query: (values, options) => call(fetcher, '/query', { values, ...(options ?? {}) }),
		getByIds: async (ids) => (await call(fetcher, '/get', { ids })).records,
		deleteByIds: (ids) => call(fetcher, '/delete', { ids })
	};
}
`.trimStart();

/**
 * `env.IMAGES`, as the Images binding presents it.
 *
 * The chain is lazy: `input().transform().transform().output()` accumulates operations and sends
 * ONE request when an output is asked for. Sending per link would cost a re-encode per step, which
 * is both slower and lossy -- two quality-95 JPEG passes are not one quality-95 pass.
 */
export const IMAGES_SHIM = `
const bytesOf = async (source) => {
	if (source instanceof ArrayBuffer) return new Uint8Array(source);
	if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
	if (source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
	if (source && typeof source.getReader === 'function') {
		return new Uint8Array(await new Response(source).arrayBuffer());
	}
	throw new Error('ImagesError: input takes bytes, a blob or a stream');
};

const send = async (fetcher, path, header, body) => {
	const response = await fetcher.fetch('http://bastion' + path, {
		method: 'POST',
		headers: { 'content-type': 'application/octet-stream', 'x-bastion-ops': header },
		body
	});
	if (!response.ok) {
		throw new Error('ImagesError: ' + response.status + ' ' + (await response.text()));
	}
	return response;
};

class Handle {
	constructor(fetcher, source, ops) {
		this.fetcher = fetcher;
		this.source = source;
		this.ops = ops ?? [];
	}
	transform(options) {
		return new Handle(this.fetcher, this.source, [...this.ops, { op: 'transform', options }]);
	}
	draw(image, options) {
		return new Handle(this.fetcher, this.source, [...this.ops, { op: 'draw', options }]);
	}
	async output(options) {
		const body = await bytesOf(await this.source);
		const ops = JSON.stringify({ ops: this.ops, output: options ?? {} });
		const response = await send(this.fetcher, '/transform', ops, body);
		const type = response.headers.get('content-type') ?? 'application/octet-stream';
		const bytes = new Uint8Array(await response.arrayBuffer());
		return {
			contentType: () => type,
			image: () => new Blob([bytes], { type }).stream(),
			response: (init) =>
				new Response(bytes, { ...(init ?? {}), headers: { 'content-type': type } })
		};
	}
}

export default function (env) {
	const fetcher = env.fetcher;
	return {
		input: (source) => new Handle(fetcher, source),
		info: async (source) => {
			const body = await bytesOf(await source);
			const response = await send(fetcher, '/info', '{}', body);
			return response.json();
		}
	};
}
`.trimStart();

/**
 * `env.SEB`, as the send_email binding presents it.
 *
 * Takes anything carrying `from`, `to` and `raw`, which is what `EmailMessage` is, so a bundle
 * importing `cloudflare:email` keeps working and one constructing a plain object does too. The
 * raw side is a MIME message and bastion does not parse it: an SMTP server is the thing that
 * understands mail, and re-encoding a message in between is how a DKIM signature stops verifying.
 */
export const EMAIL_SHIM = `
export default function (env) {
	const fetcher = env.fetcher;
	return {
		async send(message) {
			if (!message || !message.from || !message.to) {
				throw new Error('EmailError: a message needs from and to');
			}
			const raw =
				typeof message.raw === 'string'
					? message.raw
					: await new Response(message.raw).text();
			const response = await fetcher.fetch('http://bastion/send', {
				method: 'POST',
				headers: {
					'content-type': 'message/rfc822',
					'x-bastion-from': message.from,
					'x-bastion-to': message.to
				},
				body: raw
			});
			if (!response.ok) {
				throw new Error('EmailError: ' + response.status + ' ' + (await response.text()));
			}
		}
	};
}
`.trimStart();

/**
 * `env.AE`, as the Analytics Engine binding presents it.
 *
 * workerd carries `analyticsEngine @17` natively, and it is gated behind `--experimental`, which
 * bastion does not pass and should not: the flag also unlocks unsafe-eval, the worker loader and
 * the debug port. So this is a wrapped binding instead, which reaches the same shape with none of
 * that. `writeDataPoint` returns void on Cloudflare and returns void here, so a failing sink never
 * takes a request down with it.
 */
export const ANALYTICS_SHIM = `
export default function (env) {
	const fetcher = env.fetcher;
	return {
		writeDataPoint(event) {
			const body = JSON.stringify({
				indexes: (event && event.indexes) || [],
				doubles: (event && event.doubles) || [],
				blobs: (event && event.blobs) || []
			});
			// analytics is never worth failing a request over, so the write is fire and forget
			fetcher
				.fetch('http://bastion/write', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body
				})
				.catch(() => {});
		}
	};
}
`.trimStart();

/**
 * `env.BROWSER`, as the Browser Rendering binding presents it.
 *
 * Carries `fetch`, because `@cloudflare/puppeteer` takes the binding and calls it rather than any
 * named method, and the REST helpers a bundle calls directly. The devtools path is a websocket
 * upgrade that bastion proxies to the browser's own CDP port; everything else is one POST.
 */
export const BROWSER_SHIM = `
const call = async (fetcher, path, body) => {
	const response = await fetcher.fetch('http://bastion' + path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body ?? {})
	});
	if (!response.ok) {
		throw new Error('BrowserError: ' + response.status + ' ' + (await response.text()));
	}
	return response;
};

export default function (env) {
	const fetcher = env.fetcher;
	return {
		// puppeteer.launch(env.BROWSER) reaches for fetch and upgrades it; pass it straight through
		fetch: (input, init) => fetcher.fetch(input, init),
		async screenshot(options) {
			return new Uint8Array(await (await call(fetcher, '/screenshot', options)).arrayBuffer());
		},
		async pdf(options) {
			return new Uint8Array(await (await call(fetcher, '/pdf', options)).arrayBuffer());
		},
		async content(options) {
			return (await call(fetcher, '/content', options)).text();
		}
	};
}
`.trimStart();
