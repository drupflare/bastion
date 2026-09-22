// always-miss cache service: workerd has no cache of its own, it forwards the cache api over http
export default {
	async fetch(request) {
		if (request.method === 'GET') return new Response(null, { status: 504 });
		if (request.method === 'PUT') {
			await request.arrayBuffer();
			return new Response(null, { status: 204 });
		}
		if (request.method === 'PURGE') return new Response(null, { status: 404 });
		return new Response(null, { status: 405 });
	}
};
