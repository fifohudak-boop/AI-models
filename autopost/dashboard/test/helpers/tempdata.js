// Import first in tests that touch Fifofarm's database: gives each test file
// its own empty data folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fifofarm-unit-'));
process.env.DASHBOARD_PASSWORD = 'unit-test-password';
