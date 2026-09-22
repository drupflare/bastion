// workerd ships no kv store; the kvNamespace binding turns operations into http against a service,
// so this is the smallest thing that can stand in for one
const store = new Map();

export default {
	async fetch(request) {
		const url = new URL(request.url);
		const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
		if (request.method === 'GET') {
			const hit = store.get(key);
			if (hit === undefined) return new Response('not found', { status: 404 });
			return new Response(hit, { status: 200 });
		}
		if (request.method === 'PUT') {
			store.set(key, await request.arrayBuffer());
			return new Response(null, { status: 204 });
		}
		if (request.method === 'DELETE') {
			store.delete(key);
			return new Response(null, { status: 204 });
		}
		return new Response(null, { status: 405 });
	}
};
