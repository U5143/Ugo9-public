// For the browser tests: when nothing happens for a while (a page.evaluate or a wait that
// never returns), say what was going on and stop, instead of running until the CI's limit.
//   const dog = watchdog('editor_test');  dog.watch(page);  dog.beat('what just happened')
// The last check, the last lines of the page's console and the editor's state are printed.
// A page that crashes (its renderer process died: out of memory, most likely) stops the test at
// once, with the check it crashed after and the memory seen last. `await dog.mem('section')`
// prints the page's memory (JS heap, DOM nodes, and on Linux the renderer processes' resident
// memory), to see where it keeps growing.
// It also keeps, for those reports: the editor's step marks (editor/trace.js; `dog.watch` turns
// them on in the page) and the browser's own log: `chromium.launch(dog.launchOptions(args))` adds
// --enable-logging=stderr, and Playwright's DEBUG=pw:browser output (the browser's stderr) is
// caught here instead of printed (a "Received signal", "Check failed" or "Out of memory" line
// and the stack after it say why a process died).
import fs from 'node:fs';

// the browser's stderr reaches us through Playwright's debug output (set before Playwright loads:
// importing this file comes first in the tests); kept, not printed
const browserLog = [], browserNotable = [];
if (!/pw:browser/.test(process.env.DEBUG || '')) process.env.DEBUG = [process.env.DEBUG, 'pw:browser'].filter(Boolean).join(',');
{
  const write = process.stderr.write.bind(process.stderr);
  let after = 0; // lines kept after a notable one (the stack trace)
  process.stderr.write = (chunk, ...rest) => {
    const text = String(chunk);
    if (!text.includes('pw:browser')) return write(chunk, ...rest);
    for (const raw of text.split('\n')) {
      const line = raw.replace(/^\S+ pw:browser /, '').trim().slice(0, 300);
      if (!line) continue;
      browserLog.push(line); if (browserLog.length > 300) browserLog.shift();
      if (/Received signal|Check failed|FATAL|Out of memory|OOM|crash|GPU process/i.test(line)) after = 12;
      if (after > 0) { after--; browserNotable.push(line); if (browserNotable.length > 80) browserNotable.shift(); }
    }
    return true;
  };
}

// resident memory of Chromium's page processes, or its GPU process (Linux /proc; elsewhere null)
function rendererMB(type = 'renderer') {
  let sum = 0, peak = 0, n = 0;
  try {
    for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try {
        if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(`--type=${type}`)) continue;
        const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const rss = +(/VmRSS:\s+(\d+)/.exec(st)?.[1] ?? 0) / 1024, hwm = +(/VmHWM:\s+(\d+)/.exec(st)?.[1] ?? 0) / 1024;
        sum += rss; peak = Math.max(peak, hwm); n++;
      } catch { /* the process ended */ }
    }
  } catch { return null; }
  return n ? { rss: Math.round(sum), peak: Math.round(peak), n } : null;
}

export function watchdog(name, ms = Number(process.env.UGO9_STALL_MS) || 180000) {
  let last = 'start', at = Date.now(), lastMem = '';
  const pages = new Set(), lines = [], cdp = new Map(), marks = [];
  const report = () => {
    for (const line of lines.slice(-12)) console.log(`  console: ${line}`);
    if (marks.length) console.log(`  editor steps (last ${Math.min(marks.length, 20)}):`);
    for (const m of marks.slice(-20)) console.log(`    ${m}`);
    if (browserNotable.length) { console.log('  browser log, notable lines (and the lines after them):'); for (const l of browserNotable.slice(-40)) console.log(`    ${l}`); }
    if (browserLog.length) { console.log('  browser log, last lines:'); for (const l of browserLog.slice(-20)) console.log(`    ${l}`); }
    if (lastMem) console.log(`  memory last seen: ${lastMem}`);
  };
  const timer = setInterval(async () => {
    if (Date.now() - at < ms) return;
    clearInterval(timer);
    console.log(`STUCK ${name}: nothing for ${Math.round((Date.now() - at) / 1000)} s after: ${last}`);
    report();
    for (const page of pages) {
      const state = page.evaluate(() => {
        const ed = window.ugoEditor;
        return { status: document.getElementById('stCompile')?.textContent, doc: ed?.doc?.name, busy: ed?.live?.busy, pending: !!ed?.live?.pending, message: ed?.ui?.message };
      });
      const late = new Promise((_, no) => setTimeout(() => no(new Error('the page does not answer either')), 5000));
      try { console.log(`  page: ${JSON.stringify(await Promise.race([state, late]))}`); } catch (e) { console.log(`  page: ${e.message}`); }
    }
    process.exit(1);
  }, 5000);
  timer.unref();
  return {
    beat(msg) { last = msg; at = Date.now(); },
    watch(page) {
      pages.add(page);
      page.on('console', (m) => {
        const text = m.text();
        if (text.startsWith('[ugo9] ')) { marks.push(`${new Date().toISOString().slice(11, 23)} ${text.slice(7)}`); if (marks.length > 60) marks.shift(); return; }
        lines.push(`${m.type()} ${text}`.slice(0, 300)); if (lines.length > 50) lines.shift();
      });
      // the editor's step marks (editor/trace.js) for pages opened from here on
      page.addInitScript(() => { globalThis.__ugoTrace = true; }).catch(() => {});
      page.evaluate(() => { globalThis.__ugoTrace = true; }).catch(() => {});
      page.on('pageerror', (e) => lines.push(`pageerror ${e.message}`.slice(0, 300)));
      // a crashed page never answers: stop now, not after the stall time
      page.on('crash', async () => {
        await new Promise((r) => setTimeout(r, 1500)); // the browser's stderr (the stack) comes a moment later
        console.log(`CRASHED ${name}: the page's renderer process died after: ${last}`);
        report();
        const r = rendererMB();
        if (r) console.log(`  renderer processes now: ${r.n}, ${r.rss} MB resident, peak ${r.peak} MB`);
        process.exit(1);
      });
      page.on('close', () => { pages.delete(page); cdp.delete(page); });
    },
    /** Prints the memory of the watched pages under a label (one line each). */
    async mem(label) {
      for (const page of pages) {
        try {
          if (!cdp.has(page)) {
            const s = await page.context().newCDPSession(page);
            await s.send('Performance.enable');
            cdp.set(page, s);
          }
          const { metrics } = await cdp.get(page).send('Performance.getMetrics');
          const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
          const r = rendererMB(), g = rendererMB('gpu-process');
          lastMem = `${label}: JS heap ${(m.JSHeapUsedSize / 2 ** 20).toFixed(0)}/${(m.JSHeapTotalSize / 2 ** 20).toFixed(0)} MB, nodes ${m.Nodes}, documents ${m.Documents}`
            + (r ? `, renderers ${r.rss} MB resident (peak ${r.peak} MB, ${r.n} processes)` : '')
            + (g ? `, GPU process ${g.rss} MB (peak ${g.peak} MB)` : '');
          console.log(`mem  ${lastMem}`);
        } catch (e) { console.log(`mem  ${label}: (not read: ${e.message.split('\n')[0]})`); }
      }
    },
    /** Options for chromium.launch: the browser writes its log to stderr (caught above). */
    launchOptions(args = []) {
      // --disable-dev-shm-usage: a small /dev/shm (as on CI machines) ends pages with "Target crashed"
      return { args: [...args, '--disable-dev-shm-usage', '--enable-logging=stderr', '--v=0'] };
    },
    stop() { clearInterval(timer); },
  };
}
