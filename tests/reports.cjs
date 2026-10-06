const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

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
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        await context.route('https://fonts.googleapis.com/**', route => route.abort());
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const url = `http://127.0.0.1:${server.address().port}/`;
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
        await page.goto(url);

        async function makeReport(preset, options = {}) {
            await page.evaluate(({ preset, options }) => {
                const config = getPresetConfig(preset);
                const total = config.totalQuestions;
                const report = {
                    id: preset, config, totalQuestions: total,
                    completedAt: '2026-10-06T03:00:00Z', totalTime: 3600000,
                    answers: Object.fromEntries(Array.from({ length: options.empty ? 0 : total }, (_, i) => [i + 1, ['A', 'B', 'C', 'D'][i % 4]])),
                    questionTimes: Object.fromEntries(Array.from({ length: total }, (_, i) => [i + 1, 1000])),
                    correctCount: options.legacy ? 10 : null
                };
                appState.reports = [report];
                saveState();
                showReport(report);
            }, { preset, options });
        }
        async function fillAllRates(rate) {
            const inputs = page.locator('.section-accuracy');
            for (let i = 0; i < await inputs.count(); i++) await inputs.nth(i).fill(String(rate));
        }
        for (const preset of ['national-provincial', 'national-enforcement', 'guangdong', 'tianjin']) {
            await makeReport(preset);
            assert.equal(await page.locator('.score-section').count(), 6);
            assert.match(await page.locator('#reportScoreSummary').innerText(), /待完成录入/);
            await fillAllRates(100);
            let score = await page.evaluate(() => getReportScore(activeReport));
            assert.ok(Math.abs(score.knownScore - 100) < 1e-8);
            assert.ok(Math.abs(score.fullScore - 100) < 1e-8);
            assert.equal(score.accuracy, 100);
            await fillAllRates(50);
            score = await page.evaluate(() => getReportScore(activeReport));
            assert.ok(Math.abs(score.knownScore - 50) < 1e-8);
            assert.equal(score.accuracy, 50);
            assert.match(await page.locator('#reportScoreSummary').innerText(), /50.00/);
        }
        console.log('PASS: four scoring models; all correct = 100, half accuracy = 50');

        await makeReport('national-enforcement');
        const firstCount = page.locator('.section-correct').first();
        const firstRate = page.locator('.section-accuracy').first();
        await firstCount.fill('10');
        assert.equal(await firstRate.inputValue(), '50');
        await firstRate.fill('75');
        assert.equal(await firstCount.inputValue(), '15');
        await firstCount.fill('0');
        assert.equal(await firstRate.inputValue(), '0');
        assert.match(await page.locator('#reportScoreSummary').innerText(), /已录入 1\/6/);
        await firstCount.fill('');
        assert.equal(await firstRate.inputValue(), '');
        assert.match(await page.locator('#reportScoreSummary').innerText(), /已录入 0\/6/);
        for (const value of ['-1', '21', '1.5']) {
            await firstCount.fill(value);
            assert.equal(await firstCount.getAttribute('aria-invalid'), 'true');
            assert.equal(await page.locator('#btnCopyReport').isDisabled(), true);
        }
        await firstCount.fill('10');
        for (const value of ['-1', '101']) {
            await firstRate.fill(value);
            assert.equal(await firstRate.getAttribute('aria-invalid'), 'true');
        }
        await firstRate.fill('50');
        await firstCount.fill('21');
        await firstRate.fill('50');
        assert.equal(await page.locator('#btnCopyReport').isEnabled(), true);
        await fillAllRates(50);
        await page.locator('.section-points').first().fill('1');
        let score = await page.evaluate(() => getReportScore(activeReport));
        assert.ok(Math.abs(score.fullScore - 104) < 1e-8);
        assert.ok(Math.abs(score.knownScore - 52) < 1e-8);
        assert.equal(score.percentScore, 50);
        await page.reload();
        await page.evaluate(() => viewReportByIndex(0));
        assert.equal(await page.locator('.section-points').first().inputValue(), '1');
        assert.equal(await firstRate.inputValue(), '50');
        assert.match(await page.locator('#reportScoreSummary').innerText(), /已自定义/);
        console.log('PASS: count/rate conversion, zero/blank, validation, custom points and persistence');

        await page.locator('#btnCopyReport').click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        assert.match(copied, /国考-行政执法/);
        assert.match(copied, /52.00 \/ 104.00/);
        assert.match(copied, /总体正确率：50.00%/);
        assert.match(copied, /数量关系/);
        assert.match(copied, /已自定义单题分值/);
        assert.match(copied, /第 130 题 \| 资料分析 \| B \| 1.0s/);
        assert.equal(await page.locator('#reportCopyFallback').isHidden(), true);
        // Both failed clipboard APIs must expose selectable text without claiming success.
        await page.evaluate(() => {
            navigator.clipboard.writeText = async () => { throw new Error('denied'); };
            document.execCommand = () => false;
        });
        await page.locator('#btnCopyReport').click();
        assert.equal(await page.locator('#reportCopyFallback').inputValue(), copied.replace(/\r\n/g, '\n'));
        assert.equal(await page.locator('#reportCopyFallback').isVisible(), true);
        assert.match(await page.locator('#toast').innerText(), /复制未获允许/);
        console.log('PASS: real clipboard export and denied-clipboard fallback');

        await page.evaluate(() => {
            const graded = appState.reports[0];
            appState.reports.push({ ...graded, id: 'ungraded', grading: undefined, correctCount: null });
            renderStats();
        });
        assert.match(await page.locator('#statsContent').innerText(), /50.0%/);
        await page.evaluate(() => showHistory());
        assert.match(await page.locator('#historyList').innerText(), /估分 52.00\/104.00/);
        console.log('PASS: history scores and accuracy excludes reports without grading');

        await makeReport('guangdong', { empty: true });
        await page.locator('.section-accuracy').first().fill('1');
        assert.match(await page.locator('.score-error').first().innerText(), /不能超过已答题数/);
        await fillAllRates(0);
        assert.match(await page.locator('#reportScoreSummary').innerText(), /0.00 \/ 100.00/);
        assert.equal(await page.evaluate(() => /NaN|Infinity/.test(buildReportExportText(activeReport))), false);
        await makeReport('tianjin', { legacy: true });
        assert.match(await page.locator('#reportGrading').innerText(), /旧版总记录：答对 10\/120/);
        assert.equal(await page.evaluate(() => appState.reports[0].correctCount), 10);
        console.log('PASS: unanswered reports and preserved legacy totals');

        // Custom ranges may leave questions unclassified; they must still participate in full score.
        await page.evaluate(() => {
            const report = appState.reports[0];
            report.config = { mode: 'set', preset: 'custom', totalQuestions: 3, labels: [{ name: '数量关系', start: 1, end: 2 }] };
            report.totalQuestions = 3;
            report.answers = { 1: 'A', 2: 'B', 3: 'C' };
            report.grading = undefined;
            report.correctCount = null;
            showReport(report);
        });
        assert.equal(await page.locator('.score-section').count(), 2);
        assert.match(await page.locator('#reportGrading').innerText(), /未分类/);
        await fillAllRates(100);
        assert.ok(Math.abs((await page.evaluate(() => getReportScore(activeReport))).knownScore - 100) < 1e-8);
        const points = page.locator('.section-points');
        for (let i = 0; i < await points.count(); i++) await points.nth(i).fill('0');
        assert.match(await page.locator('#reportScoreSummary').innerText(), /不可计算/);
        assert.equal(await page.evaluate(() => /NaN|Infinity/.test(buildReportExportText(activeReport))), false);
        console.log('PASS: custom/unclassified sections and zero-total score');

        await makeReport('national-provincial');
        await fillAllRates(80);
        for (const width of [320, 390, 1280]) {
            await page.setViewportSize({ width, height: 844 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            const box = await page.locator('.score-section').first().boundingBox();
            const inputBoxes = await page.locator('.score-section').first().locator('input').evaluateAll(inputs => inputs.map(i => ({ left: i.getBoundingClientRect().left, right: i.getBoundingClientRect().right })));
            for (const input of inputBoxes) assert.ok(input.left >= box.x && input.right <= box.x + box.width + 1);
        }
        if (process.env.CLOCKCLOCK_REPORT_SCREENSHOT) {
            await page.setViewportSize({ width: 390, height: 844 });
            await page.evaluate(() => {
                document.activeElement?.blur();
                document.getElementById('toast').style.display = 'none';
                const panel = document.getElementById('page-report');
                panel.scrollTop += document.getElementById('reportGrading').getBoundingClientRect().top - 20;
            });
            await page.screenshot({ path: process.env.CLOCKCLOCK_REPORT_SCREENSHOT });
        }
        assert.deepEqual(errors, []);
        console.log('PASS: report layouts at 320/390px and desktop; no JavaScript errors');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
