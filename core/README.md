# @drupflare/bastion

> 🏰 The engine behind bastion, a hardened operating environment for self-hosted workerd

This is the library. It carries the configuration loader, the Cap'n Proto generator, the TLS front
door, the adapters and their drivers, the isolation appliers, the backup engine and the management
API. It ships no binary.

The command-line program is [`@drupflare/warden`](https://www.npmjs.com/package/@drupflare/warden),
which installs as `bastion`. Install that unless you are embedding the engine.

## Install

```sh
bun add @drupflare/bastion
```

## Usage

Everything reaches the outside world through a `Context`, so nothing here opens a socket, spawns a
process or touches a disk that the caller did not supply.

```ts
import { defaultContext, loadConfig, validate } from '@drupflare/bastion';

const ctx = defaultContext();
const { config, path } = loadConfig(ctx, { path: './bastion.yml' });

const problems = validate(config);
if (!problems.ok) {
  for (const problem of problems.problems) {
    // report the path of each rejection here
  }
}
```

Substituting the seams is how the test lane stays hermetic:

```ts
import { memoryFiles, memoryIo, scriptedRunner } from '@drupflare/bastion';

const ctx = {
  files: memoryFiles({ '/bastion.yml': 'version: 1\nmode: solo\n' }),
  io: memoryIo(),
  runner: scriptedRunner(),
  fetch: () => Promise.reject(new Error('no network')),
  env: {},
  cwd: '/',
  now: () => 0
};
```

## Documentation

The API reference is generated from this package's own types and published at
[drupflare.github.io/bastion](https://drupflare.github.io/bastion). The operator manual, the command
reference and the configuration keys live in the
[repository](https://github.com/drupflare/bastion).

## License

MIT
