const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

async function main() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'));
    const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
        catch { browser = await chromium.launch({ headless: true }); }
        const page = await browser.newPage({ viewport: { width: 820, height: 1180 } });
        await page.route('https://fonts.googleapis.com/**', route => route.abort());
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.locator('#btnStart').click();
        await page.locator('[data-option="A"]').click();
        await page.waitForFunction(() => appState.progress.currentQuestion === 2 && !isTransitioning);
        await page.locator('.btn-answer-sheet').click();
        assert.deepEqual(await page.locator('.answer-section-title').allTextContents(), [
            '政治理论第 1–20 题', '常识判断第 21–35 题', '言语理解第 36–65 题', '数量关系第 66–80 题', '判断推理第 81–115 题', '资料分析第 116–135 题'
        ]);
        const nums = await page.locator('.answer-grid-item').evaluateAll(items => items.map(i => Number(i.dataset.question)));
        assert.deepEqual(nums, Array.from({ length: 135 }, (_, i) => i + 1));
        assert.equal(await page.locator('#answerGrid [data-question="1"]').getAttribute('class'), 'answer-grid-item answered');
        assert.equal(await page.locator('#answerGrid [data-question="2"]').getAttribute('aria-current'), 'true');
        if (process.env.CLOCKCLOCK_LAYOUT_DIR) {
            await page.locator('#answerSheetModal .modal-content').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {}))));
            await page.screenshot({ path: path.join(process.env.CLOCKCLOCK_LAYOUT_DIR, 'clockclock-answer-sheet-tablet.png') });
        }
        await page.locator('#answerGrid [data-question="66"]').click();
        assert.match(await page.locator('#cardQLabel').innerText(), /数量关系/);
        assert.equal(await page.locator('#answerSheetModal').evaluate(el => el.classList.contains('open')), false);
        assert.equal(await page.evaluate(() => appState.progress.currentQuestion), 66);
        await page.evaluate(() => {
            appState.progress.config = { mode: 'set', totalQuestions: 6, labels: [{ name: '数量关系', start: 2, end: 3 }, { name: '资料分析', start: 5, end: 6 }] };
            appState.progress.currentQuestion = 2;
            openAnswerSheet();
        });
        assert.deepEqual(await page.locator('.answer-section-title').allTextContents(), ['未分类第 1–1 题', '数量关系第 2–3 题', '未分类第 4–4 题', '资料分析第 5–6 题']);
        await page.evaluate(() => { closeAnswerSheet(); appState.progress.config.mode = 'type'; appState.progress.config.typeCount = 6; openAnswerSheet(); });
        assert.equal(await page.locator('.answer-section-title').count(), 0);
        assert.equal(await page.locator('.answer-grid-item').count(), 6);
        console.log('PASS: section headings, complete question order, answer/current states and jump navigation');

        await page.evaluate(() => {
            closeAnswerSheet();
            const config = getPresetConfig('national-provincial');
            const report = { id: 'layout', config, totalQuestions: 135, completedAt: '2026-10-06T04:00:00Z', totalTime: 7200000,
                answers: Object.fromEntries(Array.from({ length: 135 }, (_, i) => [i + 1, 'A'])),
                questionTimes: Object.fromEntries(Array.from({ length: 135 }, (_, i) => [i + 1, 34000])), correctCount: null };
            appState.progress = null;
            appState.reports = [report];
            showReport(report);
        });
        assert.equal(await page.locator('#reportContent input').count(), 0);
        await page.locator('#btnEditReportGrade').click();
        for (const input of await page.locator('.section-accuracy').all()) await input.fill('80');
        await page.getByRole('button', { name: '完成并返回报告' }).click();
        assert.equal(await page.locator('#reportGradeDialog').evaluate(el => el.open), false);
        const stats = await page.locator('[data-stat-section="政治理论"]').innerText();
        assert.match(stats, /正确率 80.00%/);
        assert.match(stats, /参考得分 9.50 \/ 11.88\s分/);
        assert.match(stats, /用时 11m20s/);
        assert.match(stats, /已答题均时 34.0s/);
        await page.locator('#btnEditReportGrade').click();
        await page.locator('.section-correct').first().fill('999');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#reportGradeDialog').evaluate(el => el.open), false);
        assert.match(await page.locator('[data-stat-section="政治理论"]').innerText(), /正确率 80.00%/);
        assert.equal(await page.locator('#btnCopyReport').isEnabled(), true);
        console.log('PASS: grade button/dialog, statistics after entry and safe close with invalid draft');

        for (const width of [320, 390, 719, 720, 768, 820, 1024, 1180, 1280]) {
            await page.setViewportSize({ width, height: 1180 });
            const expectedTables = width >= 720 ? 2 : 1;
            await page.waitForFunction(n => document.querySelectorAll('#reportDetailsTables table').length === n, expectedTables);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            const rows = await page.locator('#reportDetailsTables tr[data-question]').evaluateAll(rows => rows.map(row => Number(row.dataset.question)));
            assert.deepEqual(rows, Array.from({ length: 135 }, (_, i) => i + 1));
            const content = await page.locator('#reportContent').boundingBox();
            assert.ok(content.width > width * 0.86);
            if (width >= 720) {
                const tables = await page.locator('#reportDetailsTables .report-table-wrap').all();
                const a = await tables[0].boundingBox(), b = await tables[1].boundingBox();
                assert.ok(b.x > a.x + a.width && Math.abs(a.y - b.y) < 1);
                const cols = await page.locator('#reportTypeStats').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
                assert.equal(cols, 3);
            }
            if (process.env.CLOCKCLOCK_LAYOUT_DIR && [820, 1180, 390].includes(width)) {
                await page.evaluate(() => { document.getElementById('page-report').scrollTop = 0; document.getElementById('toast').style.display = 'none'; });
                await page.screenshot({ path: path.join(process.env.CLOCKCLOCK_LAYOUT_DIR, `clockclock-report-${width}.png`) });
                if (width !== 1180) {
                    await page.locator('#btnEditReportGrade').click();
                    await page.screenshot({ path: path.join(process.env.CLOCKCLOCK_LAYOUT_DIR, `clockclock-grade-${width}.png`) });
                    await page.getByRole('button', { name: '完成并返回报告' }).click();
                }
            }
        }
        await page.evaluate(() => {
            const r = activeReport;
            r.config = { mode: 'type', typeLabel: '资料分析', typeCount: 13, totalQuestions: 13, labels: [{ name: '资料分析', start: 1, end: 13 }] };
            r.totalQuestions = 13;
            showReport(r);
        });
        assert.equal(await page.locator('#reportDetailsTables table').count(), 2);
        assert.deepEqual(await page.locator('#reportDetailsTables table').first().locator('tr[data-question]').evaluateAll(rows => rows.map(r => Number(r.dataset.question))), [1,2,3,4,5,6,7,8,9,10]);
        assert.match(await page.locator('#reportDetailsTables table').last().innerText(), /第11-13题/);
        assert.deepEqual(errors, []);
        console.log('PASS: 320–1280px responsive report, no repeated/missing rows and intact 5-question groups');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
