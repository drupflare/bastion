using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
	services = [
		(name = "main", worker = .mainWorker),
		(name = "nullcache", worker = .nullCache),
		(name = "kvstub", worker = .kvStub),
		(name = "assetdir", disk = (path = "/Users/gamer/gmitch215/drupflare/worker/assets", writable = false)),
		(name = "dostate2", disk = (path = "/private/tmp/claude-502/-Users-gamer-gmitch215-drupflare-worker/144c2093-2200-4b32-a244-1edd45db5ff0/scratchpad/dostate2", writable = true))
	],
	sockets = [
		(name = "http", address = "127.0.0.1:8789", http = (), service = "main"),
		(name = "rawassets", address = "127.0.0.1:8790", http = (), service = "assetdir")
	]
);

const mainWorker :Workerd.Worker = (
	modules = [
		(name = "site.js", esModule = embed "site.js"),
		(name = "d513af2902500e3f87d308aad3059512651ab4f8-php8.5.tuned.wasm", wasm = embed "d513af2902500e3f87d308aad3059512651ab4f8-php8.5.tuned.wasm"),
		(name = "b78384ed3f5021552b3b1405d0a6cfe26e446817-tinyimg.wasm", wasm = embed "b78384ed3f5021552b3b1405d0a6cfe26e446817-tinyimg.wasm")
	],
	compatibilityDate = "2026-08-01",
	compatibilityFlags = ["nodejs_compat"],
	cacheApiOutbound = "nullcache",
	durableObjectNamespaces = [
		(className = "SitePhpDurableObject", uniqueKey = "drupflare-standalone-probe", enableSql = true)
	],
	durableObjectStorage = (localDisk = "dostate2"),
	bindings = [
		(name = "SITE", durableObjectNamespace = "SitePhpDurableObject"),
		(name = "ASSETS", service = "assetdir"),
		(name = "CONFIG_KV", kvNamespace = "kvstub"),
		(name = "PAGE_KV", kvNamespace = "kvstub"),
		(name = "LAZY_MOUNT", text = "1"),
		(name = "LAZY_FS_BUDGET_BYTES", text = "4194304"),
		(name = "GEN_BUCKET_MS", text = "5000"),
		(name = "PLAN", text = "free"),
		(name = "PAGE_KV_ENABLED", text = "1"),
		(name = "ASSET_AGGREGATES", text = "1")
	]
);

const nullCache :Workerd.Worker = (
	modules = [(name = "nullcache.js", esModule = embed "nullcache.js")],
	compatibilityDate = "2026-08-01"
);

const kvStub :Workerd.Worker = (
	modules = [(name = "kvstub.js", esModule = embed "kvstub.js")],
	compatibilityDate = "2026-08-01"
);
