import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STROLL } from '../src/definition.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const body = {
  tools: STROLL.describe.tools,
  events: STROLL.describe.events,
};
fs.writeFileSync(path.join(root, 'describe.json'), JSON.stringify(body, null, 2) + '\n', 'utf8');
console.log(`describe.json: ${body.tools.length} tools, ${body.events.length} events`);
