// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Runs the device bench page (tools/make_bench_page.mjs) in Chromium as a phone:
// 360x640, Pixel 7 user agent, CPU slowed down N times. Only the CPU-time column
// is meaningful here: the GPU is emulated in software.
//   node tests/bench_emulate.mjs page.html [cpuSlowdown=4] [screenshot.png]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const page_path = process.argv[2], rate = Number(process.argv[3] || 4), shot = process.argv[4];
const dir = page_path.replace(/[^/]+$/, ''), name = page_path.split('/').pop();
const server = spawn('python3', ['-m', 'http.server', '8130', '--directory', dir], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 360, height: 640 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const cdp = await ctx.newCDPSession(page);
await page.goto(`http://localhost:8130/${name}`);
await page.evaluate(() => { window.UGO_BENCH_NO_BREAK = true; });
await page.waitForTimeout(1500);
await cdp.send('Emulation.setCPUThrottlingRate', { rate });
await page.fill('#label', `emulated Pixel 7, CPU /${rate}`);
await page.click('#go');
await page.waitForFunction(() => document.getElementById('status').classList.contains('ok') || document.getElementById('status').classList.contains('err'), null, { timeout: 600000 });
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
if (shot) await page.screenshot({ path: shot, fullPage: true });
const rows = await page.$$eval('#rows tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent).join(' | ')));
const summary = await page.$$eval('.tile', (ts) => ts.map((t) => t.querySelector('.k').textContent + ': ' + t.querySelector('.v').textContent));
console.log(JSON.stringify({ rate, summary, note: await page.textContent('#refreshNote'), status: await page.textContent('#status'), errors }, null, 1));
console.log(rows.join('\n'));
await browser.close(); server.kill();
