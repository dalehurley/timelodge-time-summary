import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { summarizeDay } from '../action.mjs';

const date = '2026-11-18';
const token = 'synthetic-time-read-token';
const timeEntry = (id, duration, billable) => ({
    id,
    duration_seconds: duration,
    billable,
});
const pageResponse = (data, page, total) =>
    Response.json({
        data,
        meta: {
            current_page: page,
            per_page: 100,
            total,
            last_page: Math.max(1, Math.ceil(total / 100)),
        },
    });

test('sums the exact day across pages with a read-only request to the fixed API origin', async () => {
    const pages = [];
    const result = await summarizeDay(date, token, (url, init) => {
        assert.equal(
            url.origin + url.pathname,
            'https://timelodge.com/api/v1/time-entries',
        );
        assert.equal(url.searchParams.get('entry_date'), date);
        assert.equal(url.searchParams.get('per_page'), '100');
        assert.equal(init.method, 'GET');
        assert.equal(init.headers.Authorization, 'Bearer ' + token);
        assert.equal(init.redirect, 'error');
        const page = Number(url.searchParams.get('page'));
        pages.push(page);
        const records =
            page === 1
                ? Array.from({ length: 100 }, (_, index) =>
                      timeEntry(String(index), 60, index % 2 === 0),
                  )
                : [timeEntry('final', 900, true)];
        return pageResponse(records, page, 101);
    });
    assert.deepEqual(pages, [1, 2]);
    assert.deepEqual(result, {
        'entry-count': 101,
        'recorded-seconds': 6900,
        'billable-seconds': 3900,
    });
});

test('writes zero totals for a date with no records', async () => {
    assert.deepEqual(
        await summarizeDay(date, token, () => pageResponse([], 1, 0)),
        {
            'entry-count': 0,
            'recorded-seconds': 0,
            'billable-seconds': 0,
        },
    );
});

test('rejects invalid calendar dates and blank credentials before making a request', async () => {
    const unexpected = () =>
        assert.fail('this validation must run before any API request');
    await assert.rejects(
        summarizeDay('2026-02-29', token, unexpected),
        /valid.*entry date/i,
    );
    await assert.rejects(
        summarizeDay(date, '', unexpected),
        /workspace service token/i,
    );
});

test('honours a rate limit and suppresses the response body', async () => {
    let requests = 0;
    await assert.rejects(
        summarizeDay(date, token, () => {
            requests += 1;
            return new Response(token, {
                status: 429,
                headers: { 'Retry-After': '21' },
            });
        }),
        (error) =>
            error.message.includes('Wait 21 seconds') &&
            !error.message.includes(token),
    );
    assert.equal(requests, 1);
});

test('rejects a duplicated ID across pages and pagination totals that change', async () => {
    const entries = Array.from({ length: 100 }, (_, index) =>
        timeEntry(String(index), 60, true),
    );
    const requestWithSecondPage = (records, total) => (url) =>
        url.searchParams.get('page') === '1'
            ? pageResponse(entries, 1, 101)
            : pageResponse(records, 2, total);
    await assert.rejects(
        summarizeDay(
            date,
            token,
            requestWithSecondPage([timeEntry('0', 30, false)], 101),
        ),
        /duplicate/i,
    );
    await assert.rejects(
        summarizeDay(date, token, requestWithSecondPage([], 100)),
        /inconsistent page|changed during pagination/i,
    );
});

test('rejects malformed durations rather than writing misleading totals', async () => {
    await assert.rejects(
        summarizeDay(date, token, () =>
            pageResponse([timeEntry('row', '-1', true)], 1, 1),
        ),
        /invalid.*time entry/i,
    );
});

test('runs the action entry point using GitHub input names and output file', (t) => {
    const temporary = mkdtempSync(join(tmpdir(), 'timelodge-action-test-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const outputPath = join(temporary, 'outputs');
    const fixturePath = join(temporary, 'fixture.mjs');
    const fixture = [
        "import assert from 'node:assert/strict';",
        'globalThis.fetch = (url, options) => {',
        "  assert.equal(url.href, 'https://timelodge.com/api/v1/time-entries?entry_date=2026-11-18&page=1&per_page=100');",
        "  assert.equal(options.headers.Authorization, 'Bearer synthetic-time-read-token');",
        "  if (process.env.TEST_UNAUTHORISED) return new Response('synthetic-time-read-token', { status: 401 });",
        '  return Response.json({ data: [{ id: "test-id", duration_seconds: 900, billable: true, notes: "private fixture note" }],',
        '    meta: { current_page: 1, per_page: 100, total: 1, last_page: 1 } });',
        '};',
    ].join('\n');
    writeFileSync(fixturePath, fixture);
    const env = {
        GITHUB_OUTPUT: outputPath,
        INPUT_DATE: date,
        'INPUT_API-TOKEN': token,
    };
    const run = (extra = {}) =>
        spawnSync(process.execPath, ['--import', fixturePath, 'action.mjs'], {
            env: { ...env, ...extra },
            encoding: 'utf8',
        });
    const allowed = run();
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stdout + allowed.stderr, '');
    const outputs =
        'entry-count=1\nrecorded-seconds=900\nbillable-seconds=900\n';
    assert.equal(readFileSync(outputPath, 'utf8'), outputs);

    const denied = run({ TEST_UNAUTHORISED: '1' });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /denied access/i);
    assert.doesNotMatch(denied.stderr, /synthetic-time-read-token/);
    assert.equal(readFileSync(outputPath, 'utf8'), outputs);
});
