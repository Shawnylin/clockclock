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
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        await page.route('https://fonts.googleapis.com/**', route => route.abort());
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.locator('#btnStart').click();
        await page.locator('[data-option="A"]').click();
        await page.waitForFunction(() => appState.progress.currentQuestion === 2 && !isTransitioning);
        await page.evaluate(() => {
            const config = getPresetConfig('national-provincial');
            appState.reports = ['graded', 'ungraded', 'partial', 'type', 'legacy', 'zero'].map(id => {
                const report = { id, config: structuredClone(config), totalQuestions: 135,
                    completedAt: '2026-10-15T04:00:00Z', totalTime: 7200000,
                    answers: Object.fromEntries(Array.from({ length: 135 }, (_, i) => [i + 1, 'A'])), questionTimes: {}, correctCount: null };
                if (['graded', 'partial', 'zero'].includes(id)) {
                    ensureReportGrading(report);
                    Object.values(report.grading.sections).forEach((section, i) => {
                        if (id !== 'partial' || i === 0) section.accuracy = id === 'zero' ? 0 : 80;
                    });
                }
                if (id === 'type') {
                    report.config = { mode: 'type', typeLabel: '判断推理', typeCount: 135, totalQuestions: 135 };
                    report.correctCount = 100;
                }
                if (id === 'legacy') report.correctCount = 50;
                return report;
            });
            saveState();
            showHistory();
        });

        for (const theme of ['light', 'dark']) {
            await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
            for (const width of [320, 360, 390, 500, 768, 820, 1180, 1280]) {
                await page.setViewportSize({ width, height: 1180 });
                const cards = await page.locator('.history-item').evaluateAll(cards => cards.map(card => {
                    const base = card.getBoundingClientRect();
                    const rect = el => {
                        const r = el.getBoundingClientRect();
                        return { x: r.left - base.left, y: r.top - base.top, width: r.width, height: r.height };
                    };
                    const button = card.querySelector('.history-delete');
                    const letters = [...button.firstChild.textContent].map((_, i) => {
                        const range = document.createRange();
                        range.setStart(button.firstChild, i); range.setEnd(button.firstChild, i + 1);
                        return range.getBoundingClientRect().top;
                    });
                    return { x: base.x, width: base.width, height: base.height,
                        date: rect(card.querySelector('.history-item-date')),
                        metrics: [...card.querySelectorAll('.history-metric')].map(metric => ({
                            label: rect(metric.querySelector('dt')), value: rect(metric.querySelector('dd'))
                        })),
                        footer: rect(card.querySelector('.history-item-footer')), button: rect(button),
                        sameLine: Math.abs(letters[0] - letters[1]) < 1,
                        overflow: [...card.querySelectorAll('*')].some(el => el.scrollWidth > el.clientWidth + 1)
                    };
                }));
                assert.equal(cards.length, 7);
                const reference = cards[0];
                for (const card of cards) {
                    for (const property of ['x', 'width', 'height']) assert.ok(Math.abs(card[property] - reference[property]) <= 1, `${theme} ${width}px: card ${property}`);
                    assert.deepEqual(card.date, reference.date);
                    assert.deepEqual(card.metrics, reference.metrics);
                    assert.deepEqual(card.footer, reference.footer);
                    assert.deepEqual(card.button, reference.button);
                    assert.equal(card.sameLine, true);
                    assert.equal(card.overflow, false);
                    assert.ok(card.button.x + card.button.width <= card.width - 18);
                }
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                if (process.env.CLOCKCLOCK_LAYOUT_DIR && [390, 820].includes(width)) {
                    await page.locator('#page-history').evaluate(el => { el.scrollTop = 0; });
                    await page.screenshot({ path: path.join(process.env.CLOCKCLOCK_LAYOUT_DIR, `history-${theme}-${width}.png`) });
                }
            }
            console.log(`PASS: ${theme}, 320–1280px, equal card widths/heights, aligned labels/values/footers/buttons and no text overflow`);
        }
        const reportCards = page.locator('.history-item:not(.history-item-unfinished)');
        assert.match(await reportCards.nth(0).innerText(), /参考估分\s+80.00\/100.00/);
        assert.match(await reportCards.nth(1).innerText(), /正确率\s+未录入/);
        assert.match(await reportCards.nth(2).innerText(), /参考估分\s+待完成录入/);
        assert.match(await reportCards.nth(3).innerText(), /参考估分\s+—/);
        assert.match(await reportCards.nth(5).innerText(), /正确率\s+0.0%/);
        assert.match(await reportCards.nth(5).innerText(), /参考估分\s+0.00\/100.00/);

        await reportCards.first().click();
        assert.equal(await page.locator('#page-report').evaluate(el => el.classList.contains('active')), true);
        await page.locator('#btnEditReportGrade').click();
        for (const input of await page.locator('.section-accuracy').all()) await input.fill('100');
        await page.getByRole('button', { name: '完成并返回报告' }).click();
        await page.evaluate(() => showHistory());
        assert.match(await reportCards.first().innerText(), /参考估分\s+100.00\/100.00/);
        await reportCards.first().locator('.history-delete').click();
        assert.equal(await reportCards.count(), 5);
        assert.equal(await page.locator('#page-history').evaluate(el => el.classList.contains('active')), true);
        assert.equal(await page.evaluate(() => appState.reports.some(r => r.id === 'graded')), false);
        await page.reload();
        await page.evaluate(() => showHistory());
        assert.equal(await reportCards.count(), 5);
        await page.locator('.history-item-unfinished').click();
        assert.equal(await page.locator('#page-exam').evaluate(el => el.classList.contains('active')), true);
        assert.equal(await page.evaluate(() => appState.progress.currentQuestion), 2);
        await page.evaluate(() => showHistory());
        await page.locator('.history-item-unfinished .history-delete').click();
        assert.equal(await page.evaluate(() => appState.progress), null);
        assert.equal(await reportCards.count(), 5);
        await page.evaluate(() => { appState.reports = []; showHistory(); });
        assert.equal(await page.locator('.history-empty').innerText(), '暂无历史记录');
        assert.deepEqual(errors, []);
        console.log('PASS: grade states, report entry/edit, delete isolation/persistence, resume/discard and empty history');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
