import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(pathToFileURL(new URL('./ts-resolve-hook.mjs', import.meta.url).pathname));
