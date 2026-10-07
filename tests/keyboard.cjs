const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
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
        const page = await browser.newPage({ viewport: { width: 820, height: 1180 } });
        await page.route('https://fonts.googleapis.com/**', route => route.abort());
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        // Keep the layout viewport unchanged, as iPad Safari does when its keyboard opens.
        await page.addInitScript(() => {
            const viewport = new EventTarget();
            viewport.height = innerHeight;
            viewport.offsetTop = 0;
            Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
            window.setKeyboardViewport = (height, offsetTop = 0, event = 'resize') => {
                viewport.height = height;
                viewport.offsetTop = offsetTop;
                viewport.dispatchEvent(new Event(event));
            };
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.evaluate(() => {
            const config = getPresetConfig('national-provincial');
            const report = { id: 'keyboard', config, totalQuestions: 135, completedAt: '2026-10-07T04:00:00Z', totalTime: 7200000,
                answers: Object.fromEntries(Array.from({ length: 135 }, (_, i) => [i + 1, 'A'])), questionTimes: {}, correctCount: null };
            appState.reports = [report];
            showReport(report);
        });

        const dialog = page.locator('#reportGradeDialog');
        const reasoning = page.getByRole('spinbutton', { name: '判断推理答对题数', exact: true });
        const analysis = page.getByRole('spinbutton', { name: '资料分析答对题数', exact: true });
        async function expectVisibleViewport(height, top) {
            await page.waitForFunction(({ height, top }) => {
                const rect = document.getElementById('reportGradeDialog').getBoundingClientRect();
                return rect.top >= top + 11 && rect.bottom <= top + height - 11;
            }, { height, top });
        }
        async function expectInputVisible(input) {
            await page.waitForFunction(label => {
                const dialog = document.getElementById('reportGradeDialog');
                const input = [...dialog.querySelectorAll('input')].find(el => el.getAttribute('aria-label') === label);
                const rect = input.getBoundingClientRect();
                return rect.top >= dialog.getBoundingClientRect().top + 11 &&
                    rect.bottom <= dialog.querySelector('.grade-done').getBoundingClientRect().top - 11 &&
                    document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === input;
            }, await input.getAttribute('aria-label'));
        }

        for (const [width, fullHeight, keyboardHeight] of [[820, 1180, 620], [1180, 820, 330], [390, 844, 360]]) {
            await page.setViewportSize({ width, height: fullHeight });
            await page.evaluate(height => setKeyboardViewport(height), fullHeight);
            await page.locator('#btnEditReportGrade').click();
            assert.equal(await dialog.locator('.modal-close').evaluate(el => el === document.activeElement), true);
            await dialog.locator('input').first().click();
            await page.evaluate(height => setKeyboardViewport(height), keyboardHeight);
            assert.equal(await page.evaluate(() => innerHeight), fullHeight);
            await expectVisibleViewport(keyboardHeight, 0);
            await expectInputVisible(dialog.locator('input').first());

            // Scroll by wheel while the first field retains focus, then click the lower rows.
            await dialog.hover();
            await page.mouse.wheel(0, 1500);
            await page.waitForFunction(() => document.getElementById('reportGradeDialog').scrollTop > 500);
            await reasoning.click();
            await expectInputVisible(reasoning);
            await reasoning.fill('10');
            await analysis.click();
            await expectInputVisible(analysis);
            await analysis.fill('10');

            // Safari can pan the visible viewport while switching focused fields.
            await page.evaluate(height => setKeyboardViewport(height, 85, 'scroll'), keyboardHeight);
            await expectVisibleViewport(keyboardHeight, 85);
            await expectInputVisible(analysis);
            await page.keyboard.press('Tab');
            const accuracy = page.getByRole('spinbutton', { name: '资料分析正确率', exact: true });
            await expectInputVisible(accuracy);
            assert.equal(await accuracy.evaluate(el => el === document.activeElement), true);

            await page.evaluate(height => setKeyboardViewport(height), fullHeight);
            await expectVisibleViewport(fullHeight, 0);
            await page.getByRole('button', { name: '完成并返回报告' }).click();
            assert.equal(await dialog.evaluate(el => el.open), false);
            assert.equal(await dialog.getAttribute('style'), '');
            assert.equal(await page.evaluate(() => activeReport.grading.sections['判断推理'].correctCount), 10);
            assert.equal(await page.evaluate(() => activeReport.grading.sections['资料分析'].correctCount), 10);
            console.log(`PASS: ${width}×${fullHeight}, keyboard viewport ${keyboardHeight}px, scroll/click/tab, viewport pan and dismissal`);
        }

        await page.reload();
        await page.evaluate(() => showReport(appState.reports.find(report => report.id === 'keyboard')));
        await page.locator('#btnEditReportGrade').click();
        assert.equal(await reasoning.inputValue(), '10');
        assert.equal(await analysis.inputValue(), '10');
        await page.keyboard.press('Escape');
        // Browsers without VisualViewport still follow ordinary window resize events.
        await page.evaluate(() => Object.defineProperty(window, 'visualViewport', { value: undefined }));
        await page.locator('#btnEditReportGrade').click();
        await analysis.evaluate(el => el.focus({ preventScroll: true }));
        await page.setViewportSize({ width: 390, height: 360 });
        await expectVisibleViewport(360, 0);
        await expectInputVisible(analysis);
        await page.getByRole('button', { name: '完成并返回报告' }).click();
        assert.deepEqual(errors, []);
        console.log('PASS: saved lower-section scores survive reload; window resize fallback and close button remain usable');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
