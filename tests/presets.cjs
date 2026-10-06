// Run with Node.js, Playwright and installed Edge (or Playwright Chromium).
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const labels = ['政治理论', '常识判断', '言语理解', '数量关系', '判断推理', '资料分析'];
const expected = {
    'national-provincial': [[1, 20], [21, 35], [36, 65], [66, 80], [81, 115], [116, 135]],
    'national-enforcement': [[1, 20], [21, 35], [36, 65], [66, 75], [76, 110], [111, 130]],
    guangdong: [[1, 10], [11, 15], [16, 30], [31, 45], [46, 70], [71, 90]],
    tianjin: [[1, 15], [16, 25], [26, 50], [51, 65], [66, 100], [101, 120]]
};

async function main() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'));
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
        catch { browser = await chromium.launch({ headless: true }); }
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        // External font availability should not affect the functional checks.
        await context.route('https://fonts.googleapis.com/**', route => route.abort());
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const url = `http://127.0.0.1:${server.address().port}/`;
        await page.goto(url);
        assert.equal(await page.locator('#paperPreset option').count(), 5);
        assert.equal(await page.locator('#totalQuestions').inputValue(), '135');
        for (const [id, ranges] of Object.entries(expected)) {
            await page.selectOption('#paperPreset', id);
            const config = await page.evaluate(() => getConfig());
            assert.equal(config.preset, id);
            assert.equal(config.presetYear, 2026);
            assert.equal(config.totalQuestions, ranges.at(-1)[1]);
            assert.deepEqual(config.labels, labels.map((name, i) => ({ name, start: ranges[i][0], end: ranges[i][1] })));
            assert.equal(await page.locator('#btnStart').isEnabled(), true);
            // Every question must map to exactly one correct board, including both endpoints.
            const mapped = await page.evaluate(() => {
                const config = getConfig();
                return Array.from({ length: config.totalQuestions }, (_, i) => getLabelForQuestion(i + 1, config));
            });
            ranges.forEach(([start, end], i) => {
                for (let q = start; q <= end; q++) assert.equal(mapped[q - 1], labels[i]);
            });
            await page.reload();
            assert.deepEqual(await page.evaluate(() => getConfig()), config);
        }
        console.log('PASS: four 2026 presets, all question mappings and refresh persistence');

        await page.selectOption('#paperPreset', 'custom');
        await page.locator('[data-label="数量关系"] .lr-start').fill('50');
        assert.equal(await page.locator('#btnStart').isDisabled(), true);
        assert.match(await page.locator('#setConfigError').innerText(), /多个板块/);
        await page.locator('[data-label="数量关系"] .lr-start').fill('51');
        await page.locator('#totalQuestions').fill('119');
        assert.equal(await page.locator('#btnStart').isDisabled(), true);
        await page.locator('#totalQuestions').fill('120.5');
        assert.equal(await page.locator('#btnStart').isDisabled(), true);
        await page.locator('#totalQuestions').fill('120');
        await page.locator('[data-label="数量关系"] .lr-end').fill('50');
        assert.equal(await page.locator('#btnStart').isDisabled(), true);
        await page.locator('[data-label="数量关系"] .lr-start').fill('0');
        await page.locator('[data-label="数量关系"] .lr-end').fill('0');
        assert.equal(await page.locator('#btnStart').isEnabled(), true);
        await page.locator('[data-mode="type"]').click();
        await page.getByRole('button', { name: '数量关系', exact: true }).click();
        await page.locator('#typeCount').fill('3');
        await page.reload();
        assert.equal(await page.evaluate(() => getConfig().typeLabel), '数量关系');
        await page.locator('[data-mode="set"]').click();
        assert.equal(await page.locator('#paperPreset').inputValue(), 'custom');
        assert.equal(await page.locator('[data-label="数量关系"] .lr-end').inputValue(), '0');
        console.log('PASS: custom edits, invalid/overlapping ranges and drafts across mode switches');

        await page.selectOption('#paperPreset', 'guangdong');
        await page.locator('#btnStart').click();
        await page.evaluate(() => navigateToQuestion(31));
        await page.waitForFunction(() => appState.progress.currentQuestion === 31 && !isTransitioning);
        assert.match(await page.locator('#cardQLabel').innerText(), /数量关系/);
        await page.locator('[data-option="A"]').click();
        await page.waitForFunction(() => appState.progress.answers[31] === 'A');
        await page.evaluate(() => pauseExam());
        const snapshot = await page.evaluate(() => appState.progress.config);
        await page.reload();
        await page.selectOption('#paperPreset', 'tianjin');
        assert.deepEqual(await page.evaluate(() => appState.progress.config), snapshot);
        await page.evaluate(() => doResume());
        assert.equal(await page.evaluate(() => appState.progress.isPaused), true);
        await page.evaluate(() => resumeExam());
        // Render an actual completed report via the existing submit action.
        await page.evaluate(() => confirmSubmit());
        assert.match(await page.locator('#reportContent').innerText(), /数量关系/);
        assert.equal(await page.evaluate(() => appState.reports[0].config.preset), 'guangdong');
        console.log('PASS: exam labels, frozen progress snapshot, pause/resume and report');

        await page.evaluate(() => {
            appState.progress = null;
            appState.config = null;
            appState.setConfig = null;
            saveState();
            goHome();
            switchMode('type');
        });
        await page.getByRole('button', { name: '数量关系', exact: true }).click();
        await page.locator('#typeCount').fill('3');
        await page.locator('#btnStart').click();
        assert.match(await page.locator('#cardQLabel').innerText(), /数量关系/);
        await page.locator('[data-option="B"]').click();
        await page.waitForFunction(() => appState.progress.answers[1] === 'B');
        await page.evaluate(() => confirmSubmit());
        assert.match(await page.locator('#reportContent').innerText(), /数量关系/);
        await page.evaluate(() => renderStats());
        assert.match(await page.locator('#statsContent').innerText(), /数量关系/);
        console.log('PASS: quantitative-only exam, report and overall statistics');

        await page.evaluate(() => goHome());
        await page.locator('[data-mode="set"]').click();
        await page.selectOption('#paperPreset', 'guangdong');
        await page.locator('[data-mode="type"]').click();
        const downloadReady = page.waitForEvent('download');
        await page.evaluate(() => exportData());
        const download = await downloadReady;
        const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        assert.equal(backup.data.setConfig.preset, 'guangdong');
        page.once('dialog', dialog => dialog.accept());
        await page.evaluate(() => clearAllData());
        assert.equal(await page.locator('#paperPreset').inputValue(), 'national-provincial');
        const chooserReady = page.waitForEvent('filechooser');
        await page.evaluate(() => importData());
        const chooser = await chooserReady;
        await chooser.setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
        await page.waitForFunction(() => appState.setConfig?.preset === 'guangdong');
        await page.locator('[data-mode="set"]').click();
        assert.equal(await page.locator('#paperPreset').inputValue(), 'guangdong');
        assert.equal(await page.locator('#totalQuestions').inputValue(), '90');
        console.log('PASS: backup export/import includes set draft; clear data resets it');

        const legacyLabels = ['常识判断', '政治理论', '言语理解', '判断推理', '资料分析'].map((name, i) => ({
            name, start: i * 24 + 1, end: (i + 1) * 24
        }));
        await page.evaluate(legacy => {
            localStorage.setItem('exam_timer_data', JSON.stringify({
                config: { mode: 'set', totalQuestions: 120, labels: legacy },
                reports: [{ id: 'legacy', config: { mode: 'set', totalQuestions: 120, labels: legacy } }]
            }));
        }, legacyLabels);
        await page.reload();
        assert.equal(await page.locator('#paperPreset').inputValue(), 'custom');
        for (const legacy of legacyLabels) {
            assert.equal(await page.locator(`[data-label="${legacy.name}"] .lr-start`).inputValue(), String(legacy.start));
            assert.equal(await page.locator(`[data-label="${legacy.name}"] .lr-end`).inputValue(), String(legacy.end));
        }
        assert.equal(await page.locator('[data-label="数量关系"] .lr-start').inputValue(), '0');
        assert.deepEqual(await page.evaluate(() => appState.reports[0].config.labels), legacyLabels);
        console.log('PASS: old five-board configs and historical snapshots remain intact');

        await page.selectOption('#paperPreset', 'national-provincial');
        for (const width of [320, 390, 1280]) {
            await page.setViewportSize({ width, height: 844 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.equal(await page.locator('#btnStart').isEnabled(), true);
        }
        if (process.env.CLOCKCLOCK_SCREENSHOT) {
            await page.setViewportSize({ width: 390, height: 844 });
            await page.screenshot({ path: process.env.CLOCKCLOCK_SCREENSHOT, fullPage: true });
        }
        assert.deepEqual(errors, []);
        console.log('PASS: 320/390px mobile and desktop layouts; no JavaScript errors');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
