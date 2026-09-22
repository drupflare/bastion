#!/usr/bin/env node
import { defaultContext } from '@drupflare/bastion';
import { run } from './run';

process.exitCode = await run(defaultContext(), process.argv.slice(2));
